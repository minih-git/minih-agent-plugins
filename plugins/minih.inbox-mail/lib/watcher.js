"use strict";

/**
 * Keeping one mailbox watched: connect, wait, collect, notify, repeat.
 *
 * The shape of this file is the answer to three failure modes that a mail
 * watcher gets wrong by default:
 *
 * - **Reconnect storms.** A dropped connection is retried with exponential
 *   backoff, and a successful `SELECT` resets the delay, so a server that is up
 *   but flaky costs one attempt per interval rather than one per event loop tick.
 * - **The lost window.** Between "the server accepted the socket" and "IDLE is
 *   running" new mail can arrive and produce no `EXISTS` a client is listening
 *   for. Every cycle therefore ends with a `UID SEARCH` above the stored cursor
 *   and every `EXISTS` seen while not idling is remembered and honoured on the
 *   next idle, rather than dropped because nobody was waiting.
 * - **The unread archive.** On a first connection, or after the server changes
 *   `UIDVALIDITY`, the cursor is baselined at `UIDNEXT - 1`: the plugin starts
 *   watching from now and does not announce a mailbox it has never seen.
 *
 * Everything here is injected — the socket, the clock, the timers, the state
 * file, the notifier — so the tests drive a scripted server and a fake clock and
 * assert on the exact commands the plugin sent.
 */

const mime = require("./mime");
const rules = require("./rules");
const store = require("./store");

/** IMAP servers drop an IDLE that lasts longer than 30 minutes; renew well before. */
const IDLE_RENEW_MS = 25 * 60 * 1000;
/** Enough messages per cycle to make progress, few enough to stay responsive. */
const MAX_FETCH_PER_CYCLE = 25;
/** Rounds per wake, so one wake on a mailbox full of new mail still terminates. */
const MAX_ROUNDS_PER_CYCLE = 4;
/** What this client calls itself in the RFC 2971 `ID` command. */
const CLIENT_ID = { name: "Minih Agent Inbox Mail", vendor: "minih", version: "0.1.0" };

function parseInternalDate(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value.replace(/^"|"$/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One FETCH reply as the plugin's own message record.
 *
 * Only headers and envelope fields are read: the body was never fetched, and
 * `BODY.PEEK` means the server did not mark the message as read on the way.
 */
function toMessage(item, uidValidity) {
  const headers = mime.parseHeaders(item.headers);
  const envelope = item.envelope ?? { from: [], subject: "", messageId: "" };
  const sender = envelope.from?.[0] ?? { name: "", address: "" };
  const subject = mime.decodeEncodedWords(envelope.subject || mime.headerValue(headers, "subject"));
  const messageId = (mime.headerValue(headers, "message-id") || envelope.messageId || "").trim();
  return {
    headers,
    message: {
      uid: item.uid,
      uidValidity,
      messageId,
      from: { name: mime.decodeEncodedWords(sender.name), address: sender.address },
      subject,
      receivedAt: parseInternalDate(item.internalDate),
    },
  };
}

function createWatcher(deps) {
  const options = {
    idleRenewMs: deps.idleRenewMs ?? IDLE_RENEW_MS,
    maxFetch: deps.maxFetch ?? MAX_FETCH_PER_CYCLE,
    // 5 s doubling to five minutes: a first retry is quick enough to feel like a
    // reconnect and a long outage stops costing a handshake every few seconds.
    backoffBaseMs: deps.backoffBaseMs ?? 5_000,
    backoffMaxMs: deps.backoffMaxMs ?? 5 * 60 * 1000,
  };
  const state = deps.state;
  let session = null;
  let stopped = true;
  let loopPromise = null;
  let waiter = null;
  /** An `EXISTS` seen when nobody was idling; honoured on the next idle. */
  let existsPending = false;
  /** Callers waiting for the next completed cycle, which a command needs to answer. */
  let cycleWaiters = [];
  /**
   * A wake reason that arrived while nothing was waiting.
   *
   * A signal has to survive the gap between two waits: a command, a schedule
   * tick or a dropped socket lands whenever it lands, and a watcher that only
   * listened while it was parked would sleep through it — for 25 minutes on an
   * IDLE, which is exactly the case an unload must not deadlock on.
   */
  let pendingWake = null;
  let providerAtConnect = null;
  let phase = "stopped";
  let lastError = null;
  let lastCheckAt = null;

  const now = () => deps.now();

  function signal(reason) {
    const entry = waiter;
    if (!entry) {
      if (reason === "poke" || reason === "closed") pendingWake = reason;
      return;
    }
    waiter = null;
    deps.timers.clearTimeout(entry.timer);
    entry.resolve(reason);
  }

  /**
   * Sleep until the timeout, a poke, an `EXISTS`, or `stop()`.
   *
   * The wake reason matters: a renewed IDLE must not skip the search that the
   * other reasons imply.
   */
  function waitFor(ms) {
    return new Promise((resolve) => {
      if (stopped) {
        resolve("stop");
        return;
      }
      if (pendingWake) {
        const reason = pendingWake;
        pendingWake = null;
        resolve(reason);
        return;
      }
      const entry = {
        resolve,
        timer: deps.timers.setTimeout(() => {
          if (waiter === entry) waiter = null;
          resolve("timeout");
        }, ms),
      };
      waiter = entry;
    });
  }

  function settleCycle(handled) {
    const waiters = cycleWaiters;
    cycleWaiters = [];
    for (const resolve of waiters) resolve(handled);
  }

  /** Resolve with the next cycle's count, or `null` if none arrives in time. */
  function awaitNextCycle(ms) {
    return new Promise((resolve) => {
      const timer = deps.timers.setTimeout(() => {
        cycleWaiters = cycleWaiters.filter((entry) => entry !== waiter);
        resolve(null);
      }, ms);
      const waiter = (handled) => {
        deps.timers.clearTimeout(timer);
        resolve(handled);
      };
      cycleWaiters.push(waiter);
    });
  }

  function recordError(error) {
    lastError = error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error);
    state.lastError = lastError;
    deps.onError?.(error);
  }

  async function save() {
    try {
      await deps.persist(state);
    } catch (error) {
      deps.log("warn", `could not save the mailbox state: ${error?.message ?? error}`);
    }
  }

  /** Baseline or continue the cursor for the mailbox just selected. */
  async function reconcile(box) {
    const settings = deps.settings();
    providerAtConnect = settings.provider;
    if (store.cursorFor(state, box.uidValidity)) return;
    const fallback = Number.isInteger(box.uidNext) ? box.uidNext - 1 : await session.maxUid();
    store.setCursor(state, box.uidValidity, Math.max(0, fallback));
    await save();
    deps.log("info", `watching from UID ${state.cursor.maxUid} (uidValidity ${box.uidValidity})`);
  }

  /**
   * Post one notification.
   *
   * The host can refuse a row (its own rate limit, a closed centre), and a
   * refused row must not take the watcher down with it: the mail is still
   * handled, and the next one might work.
   */
  async function notify(kind, payload, reasons) {
    try {
      await deps.notify[kind](payload, reasons);
    } catch (error) {
      deps.log("warn", `could not post a ${kind}: ${error?.message ?? error}`);
    }
  }

  /** Classify one batch and post what it earned. */
  async function handleItems(items, settings, uidValidity) {
    for (const item of items) {
      const { message, headers } = toMessage(item, uidValidity);
      const key = store.messageKey(message);
      if (store.hasSeen(state, key)) continue;
      const verdict = rules.classify(message, settings, headers);
      if (verdict.level === "alert") {
        store.rememberSeen(state, key);
        await notify("alert", message, verdict.reasons);
      } else {
        store.queueDigest(
          state,
          {
            uid: message.uid,
            uidValidity,
            messageId: key,
            from: message.from,
            subject: message.subject,
            receivedAt: message.receivedAt,
          },
          now(),
        );
      }
    }
  }

  /** Post the queued batch once its interval has passed. */
  async function flushDigest(settings, force) {
    if (!state.pending.length) return false;
    const elapsed = state.pendingSince === null ? 0 : now() - state.pendingSince;
    if (!force && elapsed < settings.digestMinutes * 60_000) return false;
    const entries = store.takeDigest(state);
    state.lastDigestAt = now();
    await save();
    await notify("digest", entries);
    return true;
  }

  /** One collection pass: everything above the cursor, in bounded rounds. */
  async function collect(settings) {
    let handled = 0;
    for (let round = 0; round < MAX_ROUNDS_PER_CYCLE; round += 1) {
      const afterUid = state.cursor?.maxUid ?? 0;
      const uidValidity = state.cursor?.uidValidity ?? 0;
      const uids = await session.searchNew({ afterUid, unseen: settings.unreadOnly });
      if (!uids.length) break;
      const batch = uids.slice(0, options.maxFetch);
      const items = await session.fetch(batch);
      if (!items.length) break;
      await handleItems(items, settings, uidValidity);
      const highest = items.reduce((max, item) => Math.max(max, item.uid), afterUid);
      store.advanceCursor(state, highest);
      await save();
      handled += items.length;
      if (uids.length <= batch.length) break;
    }
    lastCheckAt = now();
    state.lastCheckAt = lastCheckAt;
    state.lastError = null;
    lastError = null;
    await save();
    await flushDigest(settings, false);
    deps.onCycle?.({ handled });
    return handled;
  }

  /** A setting that names a different server invalidates this connection. */
  function settingsMoved() {
    return providerAtConnect !== null && deps.settings().provider !== providerAtConnect;
  }

  /** Everything one authenticated connection does, until it ends or is stopped. */
  async function runConnected(current) {
    const settings = deps.settings();
    phase = "connected";
    const capabilities = await current.capabilities();
    if (capabilities.includes("ID")) {
      // NetEase answers `SELECT` with "Unsafe Login" until a client identifies
      // itself; a refused ID is not fatal for providers that do not want one.
      await current.identify(deps.clientId ?? CLIENT_ID).catch((error) => {
        deps.log("info", `ID refused: ${error?.message ?? error}`);
      });
    }
    const box = await current.select("INBOX");
    await reconcile(box);
    const canIdle = capabilities.includes("IDLE");
    if (!canIdle) deps.log("info", "server does not advertise IDLE; polling on the schedule instead");

    for (;;) {
      if (stopped) return;
      if (settingsMoved()) {
        deps.log("info", "the provider setting changed; reconnecting");
        return;
      }
      settleCycle(await collect(deps.settings()));
      if (stopped) return;
      if (!canIdle) {
        // A server without IDLE is polled: a timeout is the next poll, and a
        // poke is the schedule tick or the user asking, but neither is a reason
        // to tear down a healthy connection.
        if ((await waitFor(options.idleRenewMs)) === "stop") return;
        continue;
      }
      await current.idleStart();
      const reason = existsPending ? "exists" : await waitFor(options.idleRenewMs);
      existsPending = false;
      await current.idleStop();
      if (reason === "stop") return;
      // Only a renewal skips the search; every other reason means something may
      // have arrived, which the next `collect` settles authoritatively.
      if (reason === "timeout") continue;
    }
  }

  async function loop() {
    let failures = 0;
    while (!stopped) {
      let current = null;
      try {
        current = await deps.connect();
        session = current;
        failures = 0;
        current.onExists(() => {
          existsPending = true;
          phase = "connected";
          signal("exists");
        });
        current.onClose(() => {
          signal("closed");
        });
        await runConnected(current);
      } catch (error) {
        failures += 1;
        if (!stopped) {
          phase = "error";
          recordError(error);
          deps.log("warn", `mailbox connection ended: ${error?.code ?? ""} ${error?.message ?? error}`.trim());
        }
      } finally {
        session = null;
        if (current) await current.close().catch(() => undefined);
      }
      if (stopped) break;
      phase = "waiting";
      const delay = Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** Math.max(0, failures - 1));
      await waitFor(delay);
    }
    phase = "stopped";
  }

  return {
    get status() {
      return {
        phase,
        watched: phase === "connected" || phase === "waiting" || phase === "error",
        lastCheckAt,
        lastDigestAt: state.lastDigestAt,
        lastError,
        uidValidity: state.cursor?.uidValidity ?? null,
        maxUid: state.cursor?.maxUid ?? null,
        pendingDigest: state.pending.length,
      };
    },

    start() {
      if (!stopped) return loopPromise;
      stopped = false;
      phase = "connecting";
      existsPending = false;
      pendingWake = null;
      loopPromise = loop();
      return loopPromise;
    },

    /** Wake the loop for a schedule tick, a settings change or a command. */
    poke() {
      if (stopped) {
        this.start();
        return;
      }
      signal("poke");
      void flushDigest(deps.settings(), false);
    },

    /**
     * A user-initiated check.
     *
     * While the plugin is idling it cannot issue a command — IMAP allows only one
     * at a time — so it wakes the loop and waits for the cycle that wake causes,
     * rather than answering "done" before anything happened.
     */
    async checkNow() {
      if (stopped) this.start();
      if (!session) {
        signal("poke");
        return { ...this.status, checked: false, handled: 0 };
      }
      if (session.idling) {
        const next = awaitNextCycle(15_000);
        signal("poke");
        const handled = await next;
        return { ...this.status, checked: handled !== null, handled: handled ?? 0 };
      }
      return { ...this.status, checked: true, handled: await collect(deps.settings()) };
    },

    async stop() {
      stopped = true;
      signal("stop");
      // The loop owns its connection: closing it here as well would race the one
      // the loop is already performing in its `finally`.
      await Promise.resolve(loopPromise).catch(() => undefined);
      loopPromise = null;
      session = null;
      settleCycle(null);
      phase = "stopped";
    },
  };
}

module.exports = { createWatcher };
