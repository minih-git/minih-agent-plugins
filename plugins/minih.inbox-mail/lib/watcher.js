"use strict";

/**
 * Keeping one IMAP mailbox watched: poll, collect, notify, sleep.
 *
 * There is no IDLE here, and no connection that outlives one poll. The host
 * allows eight TCP connections per plugin while the credential slot now has no
 * account limit, so a socket per mailbox is not affordable: every account is
 * *polled* instead, every three minutes, on a short session that is closed again
 * before the next account starts —
 *
 *   connect → CAPABILITY → (ID) → SELECT INBOX → SEARCH/FETCH new headers → LOGOUT
 *
 * Three things make that safe in practice:
 *
 * - **One gate for every session.** A poll, a message body and a flag change all
 *   go through `lib/gate.js`, so no more than four connections exist at once and
 *   a body fetch cannot starve the round that is running.
 * - **Staggered starts.** The first poll of account *n* waits `n × staggerMs`, so
 *   five accounts added at once do not connect in the same second.
 * - **Per-account backoff.** A failing mailbox backs off 5 s doubling to five
 *   minutes on its own schedule; it never delays another account.
 *
 * What survives from the connected design is the part that is about mail rather
 * than sockets: the UID cursor, the baseline on first sight (or after a
 * `UIDVALIDITY` change), header-only `BODY.PEEK` fetches, the importance rule, the
 * digest queue, and "do not report the same message twice".
 *
 * Everything here is injected — the socket, the clock, the timers, the state file,
 * the notifier, the gate — so the tests drive a scripted server and a fake clock.
 */

const mime = require("./mime");
const protocol = require("./protocol");
const rules = require("./rules");
const store = require("./store");
const summary = require("./summary");

/** Every account is checked this often. Fixed on purpose: no new setting. */
const DEFAULT_POLL_MS = 3 * 60 * 1000;
/** Accounts start this far apart, so a round does not open five sockets at once. */
const DEFAULT_STAGGER_MS = 1_500;
/** Enough messages per cycle to make progress, few enough to stay responsive. */
const MAX_FETCH_PER_CYCLE = 25;
/** Rounds per poll, so one poll on a mailbox full of new mail still terminates. */
const MAX_ROUNDS_PER_CYCLE = 4;
/** How many older envelopes one "load older" round brings back. */
const OLDER_LIMIT = 50;

function parseInternalDate(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value.replace(/^"|"$/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One FETCH reply as the plugin's own message record.
 *
 * The headers and the envelope give identity, sender, date and the urgency
 * flags; the capped `BODY[TEXT]` fragment gives the list's preview; the
 * `BODYSTRUCTURE` says whether there is an attachment. Every one of those came
 * from a `BODY.PEEK`, so the server did not mark the message as read on the way.
 */
function toMessage(item, uidValidity) {
  const headers = mime.parseHeaders(item.headers);
  const envelope = item.envelope ?? { from: [], subject: "", messageId: "" };
  const sender = envelope.from?.[0] ?? { name: "", address: "" };
  const subject = mime.decodeEncodedWords(envelope.subject || mime.headerValue(headers, "subject"));
  const messageId = (mime.headerValue(headers, "message-id") || envelope.messageId || "").trim();
  return {
    headers,
    flags: Array.isArray(item.flags) ? item.flags : [],
    message: {
      uid: item.uid,
      uidValidity,
      messageId,
      from: { name: mime.decodeEncodedWords(sender.name), address: sender.address },
      subject,
      receivedAt: parseInternalDate(item.internalDate),
    },
    // `ENVELOPE` carries the recipients, so no extra command is needed for the
    // reading pane's "to me and N others" line.
    to: (envelope.to ?? []).map((entry) => ({
      name: mime.decodeEncodedWords(entry.name),
      address: entry.address,
    })),
    cc: (envelope.cc ?? []).map((entry) => ({
      name: mime.decodeEncodedWords(entry.name),
      address: entry.address,
    })),
    summary: summary.summarizeFragment(item.text, {
      contentType: mime.headerValue(headers, "content-type"),
      transferEncoding: mime.headerValue(headers, "content-transfer-encoding"),
    }),
    hasAttachments: protocol.hasAttachments(item.structure),
  };
}

function createWatcher(deps) {
  const options = {
    pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
    staggerMs: deps.staggerMs ?? DEFAULT_STAGGER_MS,
    maxFetch: deps.maxFetch ?? MAX_FETCH_PER_CYCLE,
    backoffBaseMs: deps.backoffBaseMs ?? 5_000,
    backoffMaxMs: deps.backoffMaxMs ?? 5 * 60 * 1000,
  };
  const state = deps.state;
  const accountId = deps.account?.instanceId ?? "";
  const gate = deps.gate ?? null;
  let stopped = true;
  let timer = null;
  /** The poll in flight, so a poke cannot open a second session. */
  let active = null;
  /** Sessions for this account, one after another. */
  let sessionChain = Promise.resolve();
  let pokePending = false;
  let failures = 0;
  let phase = "stopped";
  let lastError = null;
  let lastCheckAt = null;

  const now = () => deps.now();
  const limited = (fn) => (gate ? gate.run(fn) : fn());

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

  /**
   * Post one notification.
   *
   * The host can refuse a row (its own rate limit, a closed centre), and a refused
   * row must not take the watcher down with it: the mail is still handled, and the
   * next one might work.
   */
  async function notify(kind, payload, reasons) {
    try {
      await deps.notify[kind](payload, reasons);
    } catch (error) {
      deps.log("warn", `could not post a ${kind}: ${error?.message ?? error}`);
    }
  }

  /** Baseline or continue the cursor for the mailbox just selected. */
  async function reconcile(session, box) {
    if (store.cursorFor(state, box.uidValidity)) return;
    const previous = state.cursor;
    const fallback = Number.isInteger(box.uidNext) ? box.uidNext - 1 : await session.maxUid();
    store.setCursor(state, box.uidValidity, Math.max(0, fallback));
    // A UID only names a message inside one `UIDVALIDITY`. When the server changes
    // it, every envelope kept from before may now point at a different message, so
    // they leave the list before anything can act on them.
    if (previous && previous.uidValidity !== box.uidValidity) {
      const dropped = store.purgeStaleEnvelopes(state, box.uidValidity);
      if (dropped) {
        deps.log("info", `UIDVALIDITY changed: dropped ${dropped} envelope(s) from the old one`);
      }
    }
    await save();
    deps.log("info", `watching from UID ${state.cursor.maxUid} (uidValidity ${box.uidValidity})`);
  }

  /**
   * Classify one batch, remember it for the panel, and post what it earned.
   *
   * `notifyNow` is false for "load older": walking back through a mailbox the
   * user already has must not turn yesterday's mail into today's notifications.
   */
  async function handleItems(items, settings, uidValidity, { notifyNow = true } = {}) {
    for (const item of items) {
      const { message, flags, headers, summary: preview, to, cc, hasAttachments } = toMessage(item, uidValidity);
      const key = store.messageKey(message);
      const verdict = rules.classify(message, settings, headers);
      // The panel's list is filled here too: one pass over the same envelope the
      // notification decided on, so the two can never disagree about importance.
      store.recordEnvelope(state, {
        key,
        uid: message.uid,
        uidValidity,
        messageId: message.messageId,
        from: message.from,
        subject: message.subject,
        receivedAt: message.receivedAt,
        flags,
        important: verdict.level === "alert",
        summary: preview,
        to,
        cc,
        hasAttachments,
      });
      if (!notifyNow || !deps.notify) continue;
      if (store.hasSeen(state, key)) continue;
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

  /**
   * Walk back through the mailbox for the panel.
   *
   * Separate from `collect` on purpose: it starts from the oldest UID the panel
   * already holds rather than from the cursor, it never moves the cursor (so a
   * later poll still starts from the newest handled message), and it never
   * notifies.
   *
   * @returns the envelopes it recorded, oldest first.
   */
  async function loadOlder({ beforeUid, limit = OLDER_LIMIT } = {}) {
    const settings = deps.settings();
    return withSession(async (session, box, capabilities) => {
      await probeFolders(session, capabilities);
      const items = await session.fetchOlder({ beforeUid, limit });
      if (!items.length) return [];
      await handleItems(items, settings, box.uidValidity, { notifyNow: false });
      await save();
      return items
        .map((item) => ({ uid: item.uid }))
        .sort((a, b) => a.uid - b.uid);
    });
  }

  /** Post the queued batch once its interval has passed. */
  async function flushDigest(settings, force) {
    if (!deps.notify || !state.pending.length) return false;
    const elapsed = state.pendingSince === null ? 0 : now() - state.pendingSince;
    if (!force && elapsed < settings.digestMinutes * 60_000) return false;
    const entries = store.takeDigest(state);
    state.lastDigestAt = now();
    await save();
    await notify("digest", entries);
    return true;
  }

  /** One collection pass: everything above the cursor, in bounded rounds. */
  async function collect(session, settings, uidValidity) {
    let handled = 0;
    for (let round = 0; round < MAX_ROUNDS_PER_CYCLE; round += 1) {
      const afterUid = state.cursor?.maxUid ?? 0;
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
    return handled;
  }

  /**
   * Ask the server which mailbox is the trash and which the archive.
   *
   * The runtime owns the cache and the decision; the watcher only lends a session
   * that already fetched its capabilities. A failed `LIST` must not fail the
   * poll — the mail still arrives, and the panel keeps the buttons it had.
   */
  async function probeFolders(session, capabilities) {
    if (typeof deps.probeFolders !== "function") return;
    try {
      await deps.probeFolders(session, capabilities);
    } catch (error) {
      deps.log("warn", `could not list the mailboxes: ${error?.message ?? error}`);
    }
  }

  /**
   * One prepared session, closed again whatever happens.
   *
   * The gate is held for the whole session, not just the handshake: the host's
   * ceiling is about open sockets, and a session that was opened but not yet
   * closed still counts. The caller gets the capabilities as well, because a
   * delete or an archive has to know whether the server can move a message.
   */
  function withSession(run) {
    // Sessions for one account run one at a time: a body fetch waits for the poll
    // in flight instead of opening a second socket to the same mailbox. The gate
    // still caps the different accounts (`lib/gate.js`).
    const start = () => limited(async () => {
      const session = await deps.connect();
      try {
        const capabilities = await session.capabilities();
        if (capabilities.includes("ID")) {
          // NetEase answers `SELECT` with "Unsafe Login" until a client identifies
          // itself; a refused ID is not fatal for providers that do not want one.
          await session.identify(deps.clientId ?? {}).catch((error) => {
            deps.log("info", `ID refused: ${error?.message ?? error}`);
          });
        }
        const box = await session.select("INBOX");
        await reconcile(session, box);
        return await run(session, box, capabilities);
      } finally {
        await session.close().catch(() => undefined);
      }
    });
    const queued = sessionChain.then(start, start);
    sessionChain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** One poll: everything one short session can settle. */
  async function poll() {
    const settings = deps.settings();
    const handled = await withSession(async (session, box, capabilities) => {
      await probeFolders(session, capabilities);
      return collect(session, settings, box.uidValidity);
    });
    lastCheckAt = now();
    state.lastCheckAt = lastCheckAt;
    state.lastError = null;
    lastError = null;
    await save();
    await flushDigest(settings, false);
    deps.onCycle?.({ handled });
    return handled;
  }

  async function runCycle() {
    if (active) return active.then((handled) => handled, () => 0);
    const run = (async () => {
      try {
        const handled = await poll();
        failures = 0;
        phase = "connected";
        return handled;
      } catch (error) {
        failures += 1;
        phase = "error";
        recordError(error);
        deps.log("warn", `mailbox poll ended: ${error?.code ?? ""} ${error?.message ?? error}`.trim());
        throw error;
      } finally {
        active = null;
      }
    })();
    active = run;
    return run;
  }

  function stopTimer() {
    if (timer) deps.timers.clearTimeout(timer);
    timer = null;
  }

  function schedule(ms) {
    stopTimer();
    if (stopped) return;
    timer = deps.timers.setTimeout(() => {
      timer = null;
      void tick();
    }, Math.max(0, Math.trunc(ms)));
    if (typeof timer?.unref === "function") timer.unref();
  }

  async function tick() {
    if (stopped) return;
    let failed = false;
    let handled = 0;
    try {
      handled = await runCycle();
    } catch {
      failed = true;
    }
    if (stopped) return;
    const backoff = failures > 0
      ? Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** (failures - 1))
      : 0;
    // A poke that arrived while the session was open, or a batch that produced
    // notifications, is not a reason to wait the whole interval again.
    const delay = pokePending || (!failed && handled > 0)
      ? Math.min(options.pollMs, options.staggerMs)
      : Math.max(options.pollMs, backoff);
    pokePending = false;
    schedule(delay);
  }

  return {
    get status() {
      return {
        accountId,
        protocol: "imap",
        phase,
        watched: phase === "connected" || phase === "connecting",
        lastCheckAt,
        lastDigestAt: state.lastDigestAt,
        lastError,
        pendingDigest: state.pending.length,
        pollIntervalMs: options.pollMs,
        uidValidity: state.cursor?.uidValidity ?? null,
        maxUid: state.cursor?.maxUid ?? null,
      };
    },

    start() {
      if (!stopped) return;
      stopped = false;
      phase = "connecting";
      pokePending = false;
      // First poll staggered by the account's position, so a restart of five
      // accounts is five sessions a second apart rather than five at once.
      schedule(Math.max(0, deps.staggerMs ?? options.staggerMs));
    },

    /** A settings change or a panel click: poll soon, on this account's schedule. */
    poke() {
      if (stopped) {
        this.start();
        return;
      }
      if (active) {
        pokePending = true;
        return;
      }
      schedule(0);
    },

    /** The user asked now: poll now, and report what the poll did. */
    async checkNow() {
      if (stopped) this.start();
      stopTimer();
      try {
        const handled = await runCycle();
        if (!stopped) schedule(options.pollMs);
        return { ...this.status, checked: true, handled };
      } catch {
        if (!stopped) schedule(Math.max(options.pollMs, options.backoffBaseMs));
        return { ...this.status, checked: false, handled: 0 };
      }
    },

    /**
     * Walk back through the mailbox for the panel's "load older".
     *
     * The cursor is untouched and nothing is announced: this is browsing, not
     * watching.
     */
    async loadOlder(input) {
      return loadOlder(input);
    },

    /**
     * Run one command on a session of its own.
     *
     * Opening a message and changing a flag used to ride the IDLE connection.
     * Now they get a short session through the same gate, which is what keeps the
     * plugin inside the host's ceiling when there are more accounts than sockets.
     * The callback receives `(session, box, capabilities)`.
     */
    withSession(run) {
      return withSession(run);
    },

    /** Post anything the digest queue is holding, if its interval has passed. */
    async flushDue() {
      return flushDigest(deps.settings(), false);
    },

    async stop() {
      stopped = true;
      stopTimer();
      pokePending = false;
      await Promise.resolve(active).catch(() => undefined);
      phase = "stopped";
    },
  };
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_STAGGER_MS,
  MAX_FETCH_PER_CYCLE,
  MAX_ROUNDS_PER_CYCLE,
  OLDER_LIMIT,
  createWatcher,
  toMessage,
};