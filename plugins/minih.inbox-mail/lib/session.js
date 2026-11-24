"use strict";

/**
 * One authenticated IMAP session, in the plugin's own words.
 *
 * The host performs the login: by the time `net.tcp.connect` resolves, the socket
 * is inside TLS, the server has accepted the credential and the greeting, the
 * capability reply and the login exchange have all been consumed. This file
 * therefore starts at `CAPABILITY` and owns everything after it:
 *
 *   CAPABILITY, ID, SELECT INBOX, UID SEARCH, UID FETCH with BODY.PEEK,
 *   UID STORE of `\Seen` / `\Flagged`, LOGOUT.
 *
 * There is no `APPEND`, no `COPY`, no `EXPUNGE` and no `STORE` other than the two
 * flags above: nothing here deletes, moves, copies or sends mail. There is no
 * IDLE either: this plugin polls, so every session is short and ends with
 * `LOGOUT` (`lib/watcher.js`).
 *
 * `STORE` exists because the user asked for it: the Inbox panel offers "mark as
 * read" and "add star", and each of those is one click that sends exactly one
 * `STORE`. `storeFlags` is therefore only reachable from a panel action; the
 * watcher's own collection path cannot call it, and `tests/watcher.test.mjs`
 * asserts that collecting new mail sends no `STORE` at all.
 *
 * `BODY.PEEK[...]` is not a stylistic choice either: the non-peek form sets
 * `\Seen` on the message, which would make the plugin a thing that marks the
 * user's mail as read behind their back. The body fetch for a message the user
 * opened is a `BODY.PEEK[]` for the same reason.
 *
 * Commands are serialised: IMAP allows one command in flight, and a plugin that
 * pipelined them would have to match untagged responses to two commands at once.
 */

const { createParser, kindOf, parseTagged, parseUntagged } = require("./protocol");

const DEFAULT_TIMEOUT_MS = 30_000;
/** Header fields fetched for one message: identity, date and the urgency flags. */
const HEADER_FIELDS = "FROM SUBJECT DATE MESSAGE-ID IMPORTANCE X-PRIORITY X-MSMail-Priority";

function taggedError(status, text) {
  const error = new Error(`IMAP ${status || "failed"}: ${text || "no detail"}`);
  error.code = status === "NO" ? "IMAP_NO" : "IMAP_BAD";
  return error;
}

function closedError() {
  const error = new Error("the IMAP connection is closed");
  error.code = "IMAP_CLOSED";
  return error;
}

function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Resolve or reject with one deadline.
 *
 * A server that stops answering must not leave the plugin waiting forever:
 * `LOGOUT` goes through here, and a timeout is a broken connection that the
 * plugin simply closes.
 */
function deadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out`), { code: "IMAP_TIMEOUT" }));
    }, ms);
    if (typeof timer?.unref === "function") timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * @param transport `{ send, close, onData, onClose }` — the socket the host owns,
 *   wrapped by `main.js` so this module never sees `pi.net.tcp` itself.
 */
function createSession(transport, options = {}) {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const parser = createParser();
  const closeListeners = new Set();
  let inflight = null;
  let chain = Promise.resolve();
  let tagSeq = 0;
  let closed = false;
  let closeCause = null;
  /** The teardown in progress, shared by every `close()` caller. */
  let closing = null;

  function notifyClose(error) {
    for (const listener of closeListeners) {
      try {
        listener(error);
      } catch (failure) {
        log("warn", `close listener failed: ${failure?.message ?? failure}`);
      }
    }
    closeListeners.clear();
  }

  /** Tear the session down once: the waiter fails, then the socket is dropped. */
  function fail(error) {
    if (closed) return;
    closed = true;
    closeCause = error ?? closedError();
    if (inflight) {
      const entry = inflight;
      inflight = null;
      clearTimeout(entry.timer);
      entry.reject(closeCause);
    }
    void transport.close?.().catch?.(() => undefined);
    notifyClose(closeCause);
  }

  function dispatch(tokens) {
    const kind = kindOf(tokens);
    // No command here has a continuation: without IDLE, a `+` line is a server
    // that is out of step, and answering nothing is the honest response.
    if (kind === "cont") return;
    if (kind === "untagged") {
      const record = parseUntagged(tokens);
      if (record.kind === "status" && record.status === "BYE") {
        // The server is closing: nothing else on this socket can be trusted.
        fail(Object.assign(new Error(`server said BYE: ${record.text}`), { code: "IMAP_BYE" }));
        return;
      }
      if (inflight) inflight.untagged.push(record);
      return;
    }
    if (kind === "tagged") {
      const tag = tokens[0];
      if (!inflight || inflight.tag !== tag) {
        log("warn", `tagged response for an unknown tag: ${String(tag)}`);
        return;
      }
      const entry = inflight;
      inflight = null;
      clearTimeout(entry.timer);
      const reply = parseTagged(tokens);
      if (reply.status === "OK") entry.resolve({ ...reply, untagged: entry.untagged });
      else entry.reject(Object.assign(taggedError(reply.status, reply.text), { untagged: entry.untagged }));
      return;
    }
    log("warn", "response with no tag or untagged marker");
  }

  transport.onData((chunk) => {
    if (closed) return;
    let responses;
    try {
      responses = parser.push(chunk);
    } catch (error) {
      fail(Object.assign(error, { code: "IMAP_PROTOCOL" }));
      return;
    }
    for (const tokens of responses) {
      if (closed) return;
      dispatch(tokens);
    }
  });
  transport.onClose((error) => {
    fail(error ?? closedError());
  });

  /**
   * Run one exchange after the previous one finished, successful or not.
   *
   * IMAP allows one command in flight at a time. Two paths that skipped this queue
   * could interleave two commands, and the reply that arrives would settle the
   * wrong waiter.
   */
  function enqueue(run) {
    const queued = chain.then(run, run);
    chain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** One command, resolved with its tagged reply plus the untagged responses it caused. */
  function command(text, options2 = {}) {
    const timeoutMs = options2.timeoutMs ?? defaultTimeoutMs;
    const run = () => new Promise((resolve, reject) => {
      if (closed) {
        reject(closeCause ?? closedError());
        return;
      }
      const tag = `A${(tagSeq += 1)}`;
      const entry = { tag, untagged: [], resolve, reject, timer: null };
      inflight = entry;
      entry.timer = setTimeout(() => {
        if (inflight === entry) inflight = null;
        const error = Object.assign(new Error(`IMAP command timed out: ${text.split(" ")[0]}`), {
          code: "IMAP_TIMEOUT",
        });
        // The caller is rejected first: `fail` only settles what is still in
        // flight, and this command has just stepped out of it.
        entry.reject(error);
        fail(error);
      }, timeoutMs);
      // A plugin timer must never keep the app alive on its own.
      if (typeof entry.timer?.unref === "function") entry.timer.unref();
      transport.send(`${tag} ${text}\r\n`).catch((error) => {
        if (inflight === entry) inflight = null;
        clearTimeout(entry.timer);
        reject(Object.assign(error ?? new Error("send failed"), { code: "IMAP_SEND_FAILED" }));
        fail(error ?? new Error("send failed"));
      });
    });
    return enqueue(run);
  }

  return {
    get closed() {
      return closed;
    },

    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },

    /** `[CAPABILITY …]` from the reply, or the untagged one, upper-cased. */
    async capabilities() {
      const reply = await command("CAPABILITY");
      const record = reply.untagged.find((entry) => entry.kind === "capability");
      if (record) return record.values.map((value) => value.toUpperCase());
      const inline = /\[CAPABILITY([^\]]*)\]/i.exec(reply.text ?? "");
      if (!inline) return [];
      return inline[1].trim().split(/\s+/).filter(Boolean).map((value) => value.toUpperCase());
    },

    /**
     * RFC 2971 identification.
     *
     * NetEase's servers (163, 126, Exmail) answer `SELECT` with "Unsafe Login"
     * until a client has sent `ID`, so this is not cosmetic for the providers
     * that are shipped here. The values name the client; none of them is about
     * the user.
     */
    async identify(props) {
      const pairs = Object.entries(props ?? {}).flatMap(([key, value]) => [quote(key), quote(value)]);
      return command(`ID (${pairs.join(" ")})`);
    },

    /** `SELECT INBOX`, with the three numbers the cursor depends on. */
    async select(mailbox = "INBOX") {
      const reply = await command(`SELECT ${quote(mailbox)}`);
      const box = {
        mailbox,
        exists: 0,
        uidValidity: 0,
        uidNext: null,
        readOnly: /\[READ-ONLY\]/i.test(reply.text ?? ""),
      };
      for (const record of reply.untagged) {
        if (record.kind === "exists") box.exists = record.count;
        else if (record.kind === "status" && record.code === "UIDVALIDITY" && record.value !== null) {
          box.uidValidity = record.value;
        } else if (record.kind === "status" && record.code === "UIDNEXT" && record.value !== null) {
          box.uidNext = record.value;
        }
      }
      if (box.readOnly) {
        // A read-only mailbox cannot be a source of new mail, and pretending
        // otherwise would leave the user waiting for a notification forever.
        const error = new Error(`mailbox ${mailbox} is read-only`);
        error.code = "IMAP_READ_ONLY";
        throw error;
      }
      return box;
    },

    /** The highest UID the mailbox holds, for a server that omits `UIDNEXT`. */
    async maxUid() {
      const reply = await command("UID SEARCH ALL");
      const uids = reply.untagged
        .filter((record) => record.kind === "search")
        .flatMap((record) => record.uids)
        .filter((uid) => Number.isInteger(uid));
      return uids.length ? Math.max(...uids) : 0;
    },

    /**
     * UIDs above `afterUid`, oldest first.
     *
     * `UID n:*` always includes the highest UID in the mailbox even when `n` is
     * larger, so the result is filtered here rather than trusted: without that,
     * the last message of a quiet mailbox would be re-fetched on every cycle.
     */
    async searchNew({ afterUid = 0, unseen = false } = {}) {
      const range = `UID ${Math.max(0, afterUid) + 1}:*`;
      const reply = await command(`UID SEARCH ${range}${unseen ? " UNSEEN" : ""}`);
      const uids = reply.untagged
        .filter((record) => record.kind === "search")
        .flatMap((record) => record.uids)
        .filter((uid) => Number.isInteger(uid) && uid > afterUid);
      return [...new Set(uids)].sort((a, b) => a - b);
    },

    /**
     * Header-only fetch for the given UIDs.
     *
     * `BODY.PEEK[HEADER.FIELDS (…)]` returns just those headers and leaves the
     * `\Seen` flag alone; the alternative, `BODY[…]`, would mark every message
     * this plugin looks at as read.
     */
    async fetch(uids, options2 = {}) {
      const list = uids.filter((uid) => Number.isInteger(uid));
      if (!list.length) return [];
      const reply = await command(
        `UID FETCH ${list.join(",")} (UID FLAGS INTERNALDATE ENVELOPE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`,
        { timeoutMs: options2.timeoutMs ?? defaultTimeoutMs },
      );
      return reply.untagged
        .filter((record) => record.kind === "fetch" && Number.isInteger(record.item.uid))
        .map((record) => record.item);
    },

    /**
     * Fetch one whole message, capped.
     *
     * Only the Inbox panel calls this, and only for the message the user opened:
     * `BODY.PEEK[]<0.N>` downloads at most N bytes and, like every peek form,
     * leaves the `\Seen` flag alone. `RFC822.SIZE` comes along so the caller can
     * say "this one was truncated" instead of pretending it has the whole mail.
     */
    async fetchMessage(uid, options2 = {}) {
      const maxBytes = options2.maxBytes ?? 0;
      if (!Number.isInteger(uid)) {
        throw Object.assign(new Error("fetchMessage needs an integer UID"), { code: "INVALID_ARGUMENT" });
      }
      const range = maxBytes > 0 ? `<0.${maxBytes}>` : "";
      const reply = await command(
        `UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[]${range})`,
        { timeoutMs: options2.timeoutMs ?? defaultTimeoutMs },
      );
      const record = reply.untagged.find(
        (entry) => entry.kind === "fetch" && entry.item.uid === uid,
      );
      if (!record) {
        throw Object.assign(new Error(`message ${uid} is not in the mailbox`), { code: "IMAP_NOT_FOUND" });
      }
      if (!record.item.body) {
        throw Object.assign(new Error(`the server sent no body for message ${uid}`), { code: "IMAP_NO_BODY" });
      }
      const size = Number.isInteger(record.item.size) ? record.item.size : record.item.body.length;
      return {
        uid,
        size,
        body: record.item.body,
        // A capped fetch always comes back as a partial section, so the section
        // marker alone would report every message as truncated. The real question
        // is whether the server said the message is bigger than what it sent.
        truncated: size > record.item.body.length,
        flags: record.item.flags,
      };
    },

    /**
     * Set or clear one flag on one message: `UID STORE <uid> +FLAGS (…)`.
     *
     * Both the add and the remove list are written into the same command when
     * both are non-empty, so a caller cannot accidentally spend two round trips
     * (and two chances to fail) on one user click. The server's own `FLAGS`
     * reply is returned when it sends one; otherwise the caller keeps what it
     * computed, because the two agree by construction.
     */
    async storeFlags(uid, change, options2 = {}) {
      if (!Number.isInteger(uid)) {
        throw Object.assign(new Error("storeFlags needs an integer UID"), { code: "INVALID_ARGUMENT" });
      }
      const add = (change?.add ?? []).filter((flag) => typeof flag === "string" && flag.startsWith("\\"));
      const remove = (change?.remove ?? []).filter((flag) => typeof flag === "string" && flag.startsWith("\\"));
      if (!add.length && !remove.length) {
        throw Object.assign(new Error("storeFlags needs at least one flag"), { code: "INVALID_ARGUMENT" });
      }
      const items = [];
      if (add.length) items.push(`+FLAGS (${add.join(" ")})`);
      if (remove.length) items.push(`-FLAGS (${remove.join(" ")})`);
      const reply = await command(`UID STORE ${uid} ${items.join(" ")}`, {
        timeoutMs: options2.timeoutMs ?? defaultTimeoutMs,
      });
      const record = reply.untagged.find(
        (entry) => entry.kind === "fetch" && entry.item.uid === uid && entry.item.flags.length,
      );
      return { uid, flags: record ? record.item.flags : null };
    },

    /**
     * Best-effort `LOGOUT`, then drop the socket. Never throws.
     *
     * Two callers can ask at once — a poll's teardown and a plugin unload — and a
     * second `LOGOUT` would leave the first one waiting for a reply that was
     * already spent. So the first call owns the teardown and the rest wait for it.
     */
    close() {
      if (closing) return closing;
      closing = (async () => {
        if (closed) return;
        await deadline(command("LOGOUT", { timeoutMs: 3_000 }), 3_000, "LOGOUT").catch(() => undefined);
        // A server that does not answer LOGOUT is already gone as far as this
        // plugin is concerned; the socket is dropped either way.
        fail(closedError());
      })();
      return closing;
    },

  };
}

module.exports = { createSession };