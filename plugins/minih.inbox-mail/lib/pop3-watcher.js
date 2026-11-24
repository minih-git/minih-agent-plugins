"use strict";

/**
 * Watching a POP3 mailbox: poll, diff, fetch headers, notify, sleep.
 *
 * POP3 cannot push, and it cannot hold a connection open either: a session locks
 * the maildrop while it lasts, so a client that kept one open would block the
 * user's phone. This file is therefore the opposite of `lib/watcher.js` — no
 * IDLE, no long-lived socket, one short session per poll:
 *
 *   connect → CAPA (for LOGIN-DELAY) → STAT → UIDL → TOP n 0 per new UIDL → QUIT
 *
 * The three rules that shape it:
 *
 * - **Baseline first.** The first poll only records the UIDLs already there. A
 *   mailbox is not a queue of new mail, and a watcher that announced an archive
 *   would be uninstalled within the hour.
 * - **UIDL is the identity.** A message number is only valid inside one session,
 *   so what is remembered is the UIDL, bounded (`store.POP3_UIDL_LIMIT`), and the
 *   number is looked up again every time a message has to be read.
 * - **Never `DELE`.** `lib/pop3.js` has no `DELE` at all, so nothing here can
 *   remove the user's mail, and `QUIT` therefore commits nothing.
 *
 * The poll interval is five minutes by default and never shorter than the
 * `LOGIN-DELAY` the server advertises; a failure backs off 5 s doubling to five
 * minutes, and a batch larger than one cycle catches up a second later instead of
 * waiting for the next interval.
 */

const mime = require("./mime");
const rules = require("./rules");
const store = require("./store");

/** Every account is checked this often, POP3 included. */
const DEFAULT_POLL_MS = 3 * 60 * 1000;
/** Accounts start this far apart, so a restart does not connect all at once. */
const DEFAULT_STAGGER_MS = 1_500;
/** How many new messages one session reads headers for. */
const MAX_FETCH_PER_CYCLE = 25;
/** A `LOGIN-DELAY` this large is a typo or a hostile server; a day is enough. */
const MAX_LOGIN_DELAY_MS = 24 * 60 * 60 * 1000;
/** Waiting this long after the next login keeps `LOGIN-DELAY` a floor, not a target. */
const LOGIN_DELAY_MARGIN_MS = 5_000;
/** How much of a message a server without `TOP` is asked for, to read its headers. */
const HEADER_FALLBACK_BYTES = 64 * 1024;
/** A backlog is drained a batch per second rather than a batch per interval. */
const CATCH_UP_MS = 1_000;

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/** `"Boss" <boss@example.com>`, `<boss@example.com>` or a bare address. */
function senderOf(headers) {
  const raw = mime.headerValue(headers, "from").trim();
  if (!raw) return { name: "", address: "" };
  const angle = /<([^>]+)>\s*$/.exec(raw);
  if (angle) {
    const name = raw.slice(0, angle.index).trim().replace(/^"|"$/g, "").trim();
    return { name, address: angle[1].trim() };
  }
  return { name: "", address: raw.replace(/^"|"$/g, "").trim() };
}

/**
 * One message's identity and envelope, from its header block.
 *
 * `key` is the UIDL-derived name the panel, the digest queue and the notification
 * dedupe key all use, because the message number in `uid` moves between sessions.
 */
function toMessage(headers, entry) {
  const received = Date.parse(mime.headerValue(headers, "date"));
  return {
    key: store.pop3Key(entry.uidl),
    uid: entry.number,
    uidValidity: null,
    messageId: mime.headerValue(headers, "message-id").trim(),
    from: senderOf(headers),
    subject: mime.headerValue(headers, "subject"),
    receivedAt: Number.isFinite(received) ? received : null,
  };
}

function createPop3Watcher(deps) {
  const options = {
    pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
    staggerMs: deps.staggerMs ?? DEFAULT_STAGGER_MS,
    maxFetch: deps.maxFetch ?? MAX_FETCH_PER_CYCLE,
    backoffBaseMs: deps.backoffBaseMs ?? 5_000,
    backoffMaxMs: deps.backoffMaxMs ?? 5 * 60 * 1000,
    catchUpMs: deps.catchUpMs ?? CATCH_UP_MS,
    loginDelayMarginMs: deps.loginDelayMarginMs ?? LOGIN_DELAY_MARGIN_MS,
    headerFallbackBytes: deps.headerFallbackBytes ?? HEADER_FALLBACK_BYTES,
  };
  const state = deps.state;
  const accountId = deps.account?.instanceId ?? "";
  const gate = deps.gate ?? null;
  const limited = (fn) => (gate ? gate.run(fn) : fn());
  let stopped = true;
  let timer = null;
  /** The cycle in flight, so a poke cannot open a second session. */
  let active = null;
  /** Sessions for this account, one after another. */
  let sessionChain = Promise.resolve();
  let pokePending = false;
  let failures = 0;
  let phase = "stopped";
  let lastError = null;
  let lastCheckAt = null;
  /** The floor the server asked for, in milliseconds; 0 when it asked for none. */
  let loginDelayMs = 0;

  const now = () => deps.now();

  function recordError(error) {
    lastError = error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error);
    state.lastError = lastError;
    deps.onError?.(error);
  }

  async function save() {
    try {
      await deps.persist(state);
    } catch (error) {
      deps.log("warn", `could not save the POP3 mailbox state: ${error?.message ?? error}`);
    }
  }

  async function notify(kind, payload) {
    try {
      await deps.notify[kind](payload);
    } catch (error) {
      deps.log("warn", `could not post a ${kind}: ${error?.message ?? error}`);
    }
  }

  /** The interval the next poll must respect: the plugin's own, or the server's. */
  function pollInterval() {
    if (loginDelayMs <= 0) return options.pollMs;
    return Math.max(options.pollMs, loginDelayMs + options.loginDelayMarginMs);
  }

  /** One short session, always closed — a POP3 connection left open locks the maildrop. */
  async function withConnection(run) {
    // The gate is held for the whole session: a socket that is open but not yet
    // closed counts against the host's ceiling (`lib/gate.js`). Sessions for one
    // account also run one at a time — POP3 locks the maildrop, so a second
    // connection to the same account would only be refused.
    const start = () => limited(async () => {
      const client = await deps.connect();
      try {
        return await run(client);
      } finally {
        await Promise.resolve(client.close?.()).catch(() => undefined);
      }
    });
    const queued = sessionChain.then(start, start);
    sessionChain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /**
   * The header block of one message.
   *
   * `TOP n 0` is what the plan asks for, and it is the right command: headers
   * only, no body, no read state. `TOP` is optional (RFC 2449), so a server that
   * refuses it gets a capped `RETR` instead — the headers are the first bytes of
   * a message, and the rest is drained and dropped by the client.
   */
  async function headerBlock(client, entry) {
    const top = await client.top(entry.number, 0);
    if (top) return top;
    deps.log("info", "this POP3 server has no TOP; reading headers with a capped RETR");
    const partial = await client.retr(entry.number, { maxBytes: options.headerFallbackBytes });
    return partial.body;
  }

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

  /** One poll: everything a single POP3 session can settle. */
  async function poll(settings) {
    return withConnection(async (client) => {
      const capabilities = await client.capabilities();
      const delay = Number.parseInt(String(capabilities.get("LOGIN-DELAY")?.[0] ?? ""), 10);
      if (Number.isFinite(delay) && delay > 0) {
        loginDelayMs = Math.min(MAX_LOGIN_DELAY_MS, delay * 1000);
      }
      // `STAT` is not decorative: a server that says it holds no messages and a
      // `UIDL` that disagrees is a broken session, not an empty mailbox.
      await client.stat();
      const listing = await client.uidl();

      if (!store.pop3Baselined(state)) {
        store.pop3Baseline(state, listing.map((entry) => entry.uidl));
        lastCheckAt = now();
        state.lastCheckAt = lastCheckAt;
        state.lastError = null;
        lastError = null;
        await save();
        deps.log("info", `POP3: watching from now (${listing.length} message(s) already there)`);
        return { handled: 0, remaining: 0 };
      }

      const seen = store.pop3Seen(state);
      const fresh = listing.filter((entry) => !seen.has(entry.uidl));
      const batch = fresh.slice(0, options.maxFetch);
      let handled = 0;
      for (const entry of batch) {
        try {
          const headers = mime.parseHeaders(await headerBlock(client, entry));
          const message = toMessage(headers, entry);
          const verdict = rules.classify(message, settings, headers);
          // The panel's list is filled from the same headers the notification
          // decided on, so the two can never disagree about importance.
          store.recordEnvelope(state, {
            key: message.key,
            uid: message.uid,
            uidValidity: null,
            messageId: message.messageId,
            from: message.from,
            subject: message.subject,
            receivedAt: message.receivedAt,
            // POP3 reports no flags at all: nothing here is read or starred.
            flags: [],
            important: verdict.level === "alert",
          });
          if (verdict.level === "alert") {
            store.rememberSeen(state, message.key);
            await notify("alert", message);
          } else {
            store.queueDigest(
              state,
              {
                key: message.key,
                uid: message.uid,
                uidValidity: null,
                messageId: message.key,
                from: message.from,
                subject: message.subject,
                receivedAt: message.receivedAt,
              },
              now(),
            );
          }
        } catch (error) {
          deps.log("warn", `POP3: could not read message ${entry.number}: ${error?.message ?? error}`);
        }
        // The UIDL is remembered even when its headers could not be read: one
        // unreadable message must not block every later one forever.
        store.pop3Remember(state, entry.uidl);
        handled += 1;
      }
      lastCheckAt = now();
      state.lastCheckAt = lastCheckAt;
      state.lastError = null;
      lastError = null;
      await save();
      await flushDigest(settings, false);
      deps.onCycle?.({ handled });
      return { handled, remaining: Math.max(0, fresh.length - batch.length) };
    });
  }

  async function cycle() {
    if (active) {
      await active;
      return { checked: false, handled: 0, remaining: 0 };
    }
    const run = (async () => {
      const settings = deps.settings();
      try {
        const result = await poll(settings);
        failures = 0;
        phase = "connected";
        return { checked: true, ...result };
      } catch (error) {
        failures += 1;
        phase = "error";
        recordError(error);
        deps.log("warn", `POP3 poll ended: ${error?.code ?? ""} ${error?.message ?? error}`.trim());
        return { checked: false, handled: 0, remaining: 0, failed: true };
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
    const result = await cycle();
    if (stopped) return;
    const backoff = failures > 0 ? Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** (failures - 1)) : 0;
    let delay = Math.max(pollInterval(), backoff);
    // A backlog, or a poke that arrived mid-session, is not a reason to wait a
    // full interval: one more short session follows almost immediately.
    if (!result.failed && (result.remaining > 0 || pokePending || result.handled > 0)) {
      delay = Math.min(delay, options.catchUpMs);
    }
    pokePending = false;
    schedule(delay);
  }

  return {
    get status() {
      return {
        accountId,
        protocol: "pop3",
        phase,
        watched: phase === "connected" || phase === "connecting",
        lastCheckAt,
        lastDigestAt: state.lastDigestAt,
        lastError,
        pendingDigest: state.pending.length,
        pollIntervalMs: pollInterval(),
        // POP3 has no flags: no message is read or starred as far as the server
        // is concerned, and the panel says so instead of inventing a state.
        flagsSupported: false,
      };
    },

    start() {
      if (!stopped) return;
      stopped = false;
      phase = "connecting";
      pokePending = false;
      // Staggered by the account's position, like the IMAP watcher.
      schedule(Math.max(0, deps.staggerMs ?? options.staggerMs));
    },

    /** A schedule tick, a settings change or a panel click: poll soon. */
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

    /** A user-initiated check: run now and answer with what it found. */
    async checkNow() {
      if (stopped) this.start();
      stopTimer();
      const result = await cycle();
      if (!stopped) {
        schedule(result.failed ? Math.max(pollInterval(), options.backoffBaseMs) : pollInterval());
      }
      return { ...this.status, checked: result.checked, handled: result.handled };
    },

    /**
     * One message's body, over a session of its own.
     *
     * The number is resolved from the UIDL first: the panel knows which message
     * the user clicked, not which position it has in today's maildrop.
     */
    async fetchBody(key, options2 = {}) {
      const wanted = String(key ?? "");
      if (!wanted) throw coded("INVALID_ARGUMENT", "a message key is required");
      return withConnection(async (client) => {
        const listing = await client.uidl();
        const target = listing.find((entry) => store.pop3Key(entry.uidl) === wanted);
        if (!target) throw coded("MESSAGE_NOT_FOUND", "the mailbox no longer holds this message");
        const fetched = await client.retr(target.number, {
          maxBytes: options2.maxBytes ?? 0,
          timeoutMs: options2.timeoutMs,
        });
        return { body: fetched.body, size: fetched.size, truncated: fetched.truncated };
      });
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
  CATCH_UP_MS,
  DEFAULT_POLL_MS,
  HEADER_FALLBACK_BYTES,
  MAX_FETCH_PER_CYCLE,
  createPop3Watcher,
  senderOf,
  toMessage,
};