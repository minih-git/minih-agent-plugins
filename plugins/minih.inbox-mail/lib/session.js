"use strict";

/**
 * One authenticated IMAP session, in the plugin's own words.
 *
 * The host performs the login: by the time `net.tcp.connect` resolves, the
 * socket is inside TLS, the server has accepted the credential and the greeting,
 * the capability reply and the login exchange have all been consumed. This file
 * therefore starts at `CAPABILITY` and owns everything after it:
 *
 *   CAPABILITY, ID, SELECT, UID SEARCH, UID FETCH with BODY.PEEK (whole message,
 *   header block, text fragment, BODYSTRUCTURE, or one numbered MIME part),
 *   UID STORE of `\Seen` / `\Flagged`, LIST, UID MOVE or UID COPY + UID EXPUNGE,
 *   APPEND, LOGOUT.
 *
 * `APPEND` is the one command here that writes something the user did not pick up
 * from the mailbox: one copy of a message this plugin just sent, into the
 * account's Sent mailbox. It is only reachable from a successful send, and a
 * failure to file it is reported without changing the fact that the message went
 * out. There is no `COPY` other than the one a delete needs on a server without
 * `MOVE`, and no `EXPUNGE` other than `UID EXPUNGE <one uid>`: nothing here
 * removes mail unless the user clicked delete or archive on that one message, and
 * nothing here can empty a mailbox. A bare `EXPUNGE` — the command that removes
 * every `\Deleted` message in the selected mailbox, including ones another client
 * flagged — is deliberately not implemented.
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
 * opened is a `BODY.PEEK[]` for the same reason, and the summary fragment a new
 * message brings along is `BODY.PEEK[TEXT]<0.N>` — capped, and still a peek.
 *
 * Commands are serialised: IMAP allows one command in flight, and a plugin that
 * pipelined them would have to match untagged responses to two commands at once.
 */

const { createParser, kindOf, parseTagged, parseUntagged } = require("./protocol");

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Header fields fetched for one message.
 *
 * `CONTENT-TYPE` and `CONTENT-TRANSFER-ENCODING` are here for the preview: the
 * first bytes of the text are useless without knowing which charset and which
 * transfer encoding they were written in.
 */
const HEADER_FIELDS =
  "FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING IMPORTANCE X-PRIORITY X-MSMail-Priority";
/**
 * How much of a new message's text is read for the list's preview.
 *
 * Four kilobytes is one screenful of prose — far more than the 140 characters
 * kept — but it is also enough to get past the header block of a multipart body
 * and into the text part. A capped section still leaves `\Seen` alone.
 */
const PREVIEW_BYTES = 4096;
/** How many older envelopes one "load older" round asks for. */
const OLDER_LIMIT = 50;

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
    // A continuation is the server inviting a literal: `APPEND` waits for one
    // before it sends the message. The command that asked for it owns the reply,
    // and answers it exactly once.
    if (kind === "cont") {
      if (inflight?.onContinuation) {
        const accept = inflight.onContinuation;
        inflight.onContinuation = null;
        try {
          accept();
        } catch (error) {
          fail(Object.assign(error, { code: error?.code ?? "IMAP_SEND_FAILED" }));
        }
      }
      return;
    }
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
      const entry = { tag, untagged: [], resolve, reject, timer: null, onContinuation: options2.onContinuation ?? null };
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
     * One envelope fetch for the given UIDs.
     *
     * Every section is a `BODY.PEEK`: `BODY.PEEK[HEADER.FIELDS (…)]` returns just
     * those headers, `BODY.PEEK[TEXT]<0.N>` the first N bytes of the body, and
     * the non-peek form of either would mark every message this plugin looks at
     * as read. `BODYSTRUCTURE` rides along because it is the only way to know a
     * message carries an attachment without downloading it.
     *
     * `preview: false` drops the text section, for a caller that only wants the
     * envelope (nothing does today, but the option is what keeps this one
     * command rather than two).
     */
    async fetch(uids, options2 = {}) {
      const list = uids.filter((uid) => Number.isInteger(uid));
      if (!list.length) return [];
      const preview = options2.preview === false ? "" : ` BODY.PEEK[TEXT]<0.${PREVIEW_BYTES}>`;
      const reply = await command(
        `UID FETCH ${list.join(",")} (UID FLAGS INTERNALDATE ENVELOPE RFC822.SIZE BODYSTRUCTURE ` +
          `BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})]${preview})`,
        { timeoutMs: options2.timeoutMs ?? defaultTimeoutMs },
      );
      return reply.untagged
        .filter((record) => record.kind === "fetch" && Number.isInteger(record.item.uid))
        .map((record) => record.item);
    },

    /**
     * The envelopes just below `beforeUid`, newest of those first in the reply.
     *
     * "Load older" walks backwards from the oldest message the panel already
     * holds, so the search is `UID 1:<beforeUid - 1>` and only the highest
     * `limit` of that set is fetched: the messages furthest back in the mailbox
     * are the ones nobody is looking for, and a mailbox with 40 000 messages
     * must not become a 40 000-message fetch.
     */
    async fetchOlder({ beforeUid, limit = OLDER_LIMIT, timeoutMs } = {}) {
      if (!Number.isInteger(beforeUid) || beforeUid <= 1) return [];
      const ceiling = beforeUid - 1;
      const reply = await command(`UID SEARCH 1:${ceiling}`);
      const uids = reply.untagged
        .filter((record) => record.kind === "search")
        .flatMap((record) => record.uids)
        .filter((uid) => Number.isInteger(uid) && uid >= 1 && uid <= ceiling);
      const wanted = [...new Set(uids)].sort((a, b) => b - a).slice(0, Math.max(1, limit));
      if (!wanted.length) return [];
      return this.fetch(wanted, { timeoutMs });
    },

    /**
     * Every mailbox this account can see.
     *
     * `LIST (SPECIAL-USE) "" "*"` asks a server that supports RFC 6154 to say
     * which mailbox is the trash and which is the archive; a server that does not
     * gets the plain `LIST`, and the caller falls back to matching names. The
     * reply is small and cached by the caller, not here.
     */
    async listMailboxes({ specialUse = false } = {}) {
      const reply = await command(specialUse ? 'LIST (SPECIAL-USE) "" "*"' : 'LIST "" "*"');
      return reply.untagged
        .filter((record) => record.kind === "list" && record.name)
        // `name` is the server's own spelling, which is what a move has to send;
        // `label` is that name in modified UTF-7 decoded, which is what a human
        // (and a name match) can read.
        .map((record) => ({
          name: record.name,
          label: record.label ?? record.name,
          flags: record.flags,
          delimiter: record.delimiter,
        }));
    },

    /** `UID MOVE <uid> <mailbox>`: a move the server does atomically. */
    async moveMessage(uid, mailbox) {
      if (!Number.isInteger(uid)) {
        throw Object.assign(new Error("moveMessage needs an integer UID"), { code: "INVALID_ARGUMENT" });
      }
      return command(`UID MOVE ${uid} ${quote(mailbox)}`);
    },

    /**
     * `UID COPY <uid> <mailbox>`: one half of a move on a server without `MOVE`.
     *
     * The copy is deliberately not followed by a delete here: the caller does
     * that in two more commands so a failure in the middle leaves a copy rather
     * than a hole. Nothing else in this plugin sends `COPY`.
     */
    async copyMessage(uid, mailbox) {
      if (!Number.isInteger(uid)) {
        throw Object.assign(new Error("copyMessage needs an integer UID"), { code: "INVALID_ARGUMENT" });
      }
      return command(`UID COPY ${uid} ${quote(mailbox)}`);
    },

    /**
     * `UID EXPUNGE <uid>`: remove exactly the one message the user deleted.
     *
     * UIDPLUS is what makes this safe. Without it there is no way to expunge one
     * message, and the bare `EXPUNGE` that would do it removes every `\Deleted`
     * message in the mailbox — including ones another client flagged — so this
     * file does not implement that form at all.
     */
    async expungeUid(uid) {
      if (!Number.isInteger(uid)) {
        throw Object.assign(new Error("expungeUid needs an integer UID"), { code: "INVALID_ARGUMENT" });
      }
      return command(`UID EXPUNGE ${uid}`);
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
     * The server's own statement of a message's structure.
     *
     * `BODYSTRUCTURE` costs one command and no message body, and it is what tells
     * a download which numbered part holds an attachment: the number the server
     * uses is the number `BODY.PEEK[<part>]` answers to.
     */
    async fetchStructure(uid, options2 = {}) {
      if (!Number.isInteger(uid)) {
        throw Object.assign(new Error("fetchStructure needs an integer UID"), { code: "INVALID_ARGUMENT" });
      }
      const reply = await command(`UID FETCH ${uid} (UID BODYSTRUCTURE)`, {
        timeoutMs: options2.timeoutMs ?? defaultTimeoutMs,
      });
      const record = reply.untagged.find((entry) => entry.kind === "fetch" && entry.item.uid === uid);
      if (!record) {
        throw Object.assign(new Error(`message ${uid} is not in the mailbox`), { code: "IMAP_NOT_FOUND" });
      }
      return record.item.structure;
    },

    /**
     * One MIME part of one message, capped: `BODY.PEEK[<section>]`.
     *
     * The peek form is mandatory here for the same reason as everywhere else: the
     * non-peek form would mark the message as read, and a user who saves an
     * attachment has not read anything. The reply's section number is checked
     * against the request, so a server that answered about another part is an
     * error rather than a file with the wrong bytes in it.
     */
    async fetchPart(uid, section, options2 = {}) {
      if (!Number.isInteger(uid)) {
        throw Object.assign(new Error("fetchPart needs an integer UID"), { code: "INVALID_ARGUMENT" });
      }
      const part = String(section ?? "").trim();
      if (!/^\d+(\.\d+)*$/.test(part)) {
        throw Object.assign(new Error("fetchPart needs a section number"), { code: "INVALID_ARGUMENT" });
      }
      const maxBytes = options2.maxBytes ?? 0;
      const range = maxBytes > 0 ? `<0.${maxBytes}>` : "";
      const reply = await command(`UID FETCH ${uid} (UID BODY.PEEK[${part}]${range})`, {
        timeoutMs: options2.timeoutMs ?? defaultTimeoutMs,
      });
      const record = reply.untagged.find(
        (entry) =>
          entry.kind === "fetch" &&
          entry.item.uid === uid &&
          entry.item.section === part &&
          entry.item.data,
      );
      if (!record) {
        throw Object.assign(new Error(`the server sent no part ${part} of message ${uid}`), {
          code: "IMAP_NO_BODY",
        });
      }
      return { uid, section: part, data: record.item.data, truncated: maxBytes > 0 && record.item.data.length >= maxBytes };
    },

    /**
     * `APPEND <mailbox> (flags) {bytes}`: one copy of a message into a mailbox.
     *
     * This is how a sent message reaches the account's Sent folder, because SMTP
     * delivery does not file one. The literal waits for the server's continuation
     * before the bytes go out, as the grammar requires; the flags are the `\Seen`
     * this plugin files with, so the copy does not look like new mail.
     *
     * A server that answers `NO` is reported as a failure — the caller decides
     * whether that is fatal. Here it never is: the message is already sent.
     */
    async appendMessage(mailbox, message, options2 = {}) {
      const target = String(mailbox ?? "");
      if (!target) throw Object.assign(new Error("appendMessage needs a mailbox"), { code: "INVALID_ARGUMENT" });
      const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message ?? []);
      if (!bytes.length) throw Object.assign(new Error("appendMessage needs a message"), { code: "INVALID_ARGUMENT" });
      const flags = (options2.flags ?? ["\\Seen"]).filter((flag) => typeof flag === "string" && flag.startsWith("\\"));
      const flagList = flags.length ? ` (${flags.join(" ")})` : "";
      return command(`APPEND ${quote(target)}${flagList} {${bytes.length}}`, {
        timeoutMs: options2.timeoutMs ?? defaultTimeoutMs,
        onContinuation: () => transport.send(Buffer.concat([bytes, Buffer.from("\r\n")])),
      });
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

module.exports = { HEADER_FIELDS, OLDER_LIMIT, PREVIEW_BYTES, createSession };