"use strict";

/**
 * POP3 wire client, and nothing else.
 *
 * The host performs the sign-in — greeting, optional `STLS`, `CAPA`, `AUTH` or
 * `USER`/`PASS`, and the TLS handshake around them — so by the time
 * `net.tcp.connect` resolves the socket is in the transaction state and this
 * file owns everything after it:
 *
 *   CAPA, STAT, UIDL, TOP, RETR, QUIT — and no `DELE`, no `LIST`, no `RSET`.
 *
 * `DELE` is the one POP3 command that changes the user's mail, and this plugin
 * promises not to change it, so the command is not implemented at all: a caller
 * cannot send it by mistake. A message is read with `TOP n 0` while watching and
 * with a capped `RETR` when the user opens it.
 *
 * Parsing is the whole job here. A POP3 response is one status line and, for the
 * multi-line commands, a run of lines ended by a line containing a single dot;
 * any line that begins with a dot carries an extra one ("dot stuffing"), which
 * must be removed or every message with a line starting with "." is corrupted.
 * Chunks arrive split anywhere, including inside the terminating ".\r\n", so the
 * parser buffers and only hands out complete responses.
 *
 * Commands are serialised: POP3 is a lock-step protocol, one command at a time.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
/** A response line longer than this means the peer is not speaking POP3. */
const MAX_LINE_BYTES = 1024 * 1024;
const CRLF = Buffer.from("\r\n");

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param transport `{ send, close, onData, onClose }` — the socket the host
 *   owns, wrapped by `main.js` so this module never sees `pi.net.tcp` itself.
 */
function createClient(transport, options = {}) {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  let buffer = Buffer.alloc(0);
  let pending = null;
  let closed = false;
  let closeCause = null;
  let chain = Promise.resolve();
  /** The teardown in progress, shared by every `close()` caller. */
  let closing = null;

  function fail(error) {
    if (closed) return;
    closed = true;
    closeCause = error ?? coded("POP3_CLOSED", "the POP3 connection is closed");
    if (pending) {
      const entry = pending;
      pending = null;
      clearTimeout(entry.timer);
      entry.reject(closeCause);
    }
    void transport.close?.().catch?.(() => undefined);
  }

  function finish(entry) {
    if (pending === entry) pending = null;
    clearTimeout(entry.timer);
    entry.resolve({
      ok: entry.ok,
      status: entry.first,
      lines: entry.lines,
      // Every byte the server sent for this command, including the lines a cap
      // made us drop: that is what "the message is bigger than what you kept"
      // is measured against.
      size: entry.size,
    });
  }

  /** One complete line, in name/argument form for the status line. */
  function step(line) {
    const entry = pending;
    if (!entry) {
      // POP3 has no unsolicited data; anything here belongs to a response whose
      // command already timed out.
      log("info", "POP3 data arrived with no command in flight");
      return;
    }
    if (entry.first === null) {
      entry.first = line;
      entry.ok = /^\+OK(?:\s|$)/i.test(line);
      if (!entry.ok) {
        // `-ERR` is the answer; the caller decides whether it is fatal, which is
        // how `CAPA` stays optional.
        finish(entry);
        return;
      }
      if (!entry.multi) finish(entry);
      return;
    }
    if (line === ".") {
      finish(entry);
      return;
    }
    // Dot stuffing: the server writes ".." for a line that starts with ".".
    const payload = line.startsWith(".") ? line.slice(1) : line;
    entry.size += Buffer.byteLength(payload, "latin1") + 2;
    if (entry.keepBytes === 0 || entry.size <= entry.keepBytes) entry.lines.push(payload);
  }

  function drain() {
    for (;;) {
      const index = buffer.indexOf(CRLF);
      if (index < 0) {
        if (buffer.length > MAX_LINE_BYTES) {
          fail(coded("POP3_PROTOCOL", "a POP3 response line is too long"));
        }
        return;
      }
      const line = buffer.subarray(0, index).toString("latin1");
      buffer = buffer.subarray(index + 2);
      if (!pending) {
        log("info", "POP3 response arrived with no command in flight");
        continue;
      }
      step(line);
      if (closed) return;
    }
  }

  transport.onData((chunk) => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
    drain();
  });
  transport.onClose((error) => {
    fail(error ?? coded("POP3_CLOSED", "the mail server closed the connection"));
  });

  /**
   * One command, resolved with the status line and the (capped) body lines.
   *
   * `keepBytes` bounds what is retained, not what is read: the rest of a huge
   * message still has to be drained to reach the terminating dot, and dropping
   * it while reading is what keeps a 50 MB mail from becoming 50 MB of memory.
   */
  function request(text, options2 = {}) {
    const timeoutMs = options2.timeoutMs ?? defaultTimeoutMs;
    const keepBytes = Number.isFinite(options2.keepBytes) ? Math.max(0, Math.trunc(options2.keepBytes)) : 0;
    const command = text.split(/\s/)[0];
    const run = () => new Promise((resolve, reject) => {
      if (closed) {
        reject(closeCause ?? coded("POP3_CLOSED", "the POP3 connection is closed"));
        return;
      }
      const entry = {
        first: null,
        ok: false,
        lines: [],
        size: 0,
        multi: options2.multi === true,
        keepBytes,
        resolve,
        reject,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        const error = coded("POP3_TIMEOUT", `POP3 ${command} timed out`);
        if (pending === entry) pending = null;
        reject(error);
        fail(error);
      }, timeoutMs);
      if (typeof entry.timer?.unref === "function") entry.timer.unref();
      pending = entry;
      transport.send(`${text}\r\n`).catch((error) => {
        if (pending === entry) pending = null;
        clearTimeout(entry.timer);
        reject(coded("POP3_SEND_FAILED", String(error?.message ?? "send failed")));
        fail(error ?? new Error("send failed"));
      });
    });
    const queued = chain.then(run, run);
    chain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** A `-ERR` here is a failure of that command, not of the connection. */
  function must(reply, what) {
    if (reply.ok) return reply;
    const detail = String(reply.status ?? "").slice(0, 200);
    throw coded("POP3_ERR", `POP3 ${what} was refused: ${detail}`);
  }

  return {
    get closed() {
      return closed;
    },

    /**
     * Capabilities, as `NAME -> [arg, …]`.
     *
     * RFC 2449 makes `CAPA` optional, and a server that answers `-ERR` is a
     * server this plugin still works with — only the polling delay it asks for
     * is lost, which is why a refusal is an empty map rather than an error.
     */
    async capabilities() {
      const reply = await request("CAPA", { multi: true });
      const map = new Map();
      if (!reply.ok) return map;
      for (const line of reply.lines) {
        const parts = line.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) continue;
        map.set(parts[0].toUpperCase(), parts.slice(1));
      }
      return map;
    },

    /** `STAT`: how many messages and how many octets. */
    async stat() {
      const reply = must(await request("STAT"), "STAT");
      const match = /^\+OK\s+(\d+)\s+(\d+)/i.exec(reply.status ?? "");
      if (!match) throw coded("POP3_PROTOCOL", `STAT answered ${String(reply.status ?? "").slice(0, 120)}`);
      return { count: Number(match[1]), size: Number(match[2]) };
    },

    /**
     * `UIDL`: one permanent name per message, in maildrop order.
     *
     * The number is what later commands address; the UIDL is what this plugin
     * remembers, because the number is only valid inside one session.
     */
    async uidl() {
      const reply = must(await request("UIDL", { multi: true }), "UIDL");
      const list = [];
      for (const line of reply.lines) {
        const match = /^(\d+)\s+(\S+)\s*$/.exec(line.trim());
        if (!match) continue;
        const name = match[2];
        if (!/^[\x21-\x7e]{1,70}$/.test(name)) continue;
        list.push({ number: Number(match[1]), uidl: name });
      }
      return list;
    },

    /** `TOP n 0`: the header block of one message, never its body. */
    async top(number, lines = 0) {
      if (!Number.isInteger(number) || number < 1) {
        throw coded("INVALID_ARGUMENT", "TOP needs a message number");
      }
      const reply = await request(`TOP ${number} ${lines}`, { multi: true });
      // `null` is "this server has no TOP" (RFC 2449 makes it optional), which
      // the caller answers by asking for the message with a capped RETR.
      if (!reply.ok) return null;
      return Buffer.from(reply.lines.length ? `${reply.lines.join("\r\n")}\r\n` : "", "latin1");
    },

    /**
     * `RETR n`, keeping at most `maxBytes` of it.
     *
     * The whole message is read — the connection only becomes usable again after
     * the terminating dot — but only the beginning is kept. `size` is the real
     * octet count, so the panel can say "this one was cut" instead of pretending
     * it has the whole mail. `0` means no cap.
     */
    async retr(number, options2 = {}) {
      if (!Number.isInteger(number) || number < 1) {
        throw coded("INVALID_ARGUMENT", "RETR needs a message number");
      }
      const maxBytes = Number.isFinite(options2.maxBytes) ? Math.max(0, Math.trunc(options2.maxBytes)) : 0;
      const reply = must(
        await request(`RETR ${number}`, {
          multi: true,
          keepBytes: maxBytes,
          timeoutMs: options2.timeoutMs ?? defaultTimeoutMs,
        }),
        "RETR",
      );
      const body = reply.lines.length ? Buffer.from(`${reply.lines.join("\r\n")}\r\n`, "latin1") : Buffer.alloc(0);
      return {
        number,
        size: reply.size,
        body,
        truncated: maxBytes > 0 && reply.size > body.length,
      };
    },

    /**
     * Best-effort `QUIT`, then drop the socket. Never throws.
     *
     * `QUIT` in the transaction state leaves every message in the maildrop: it
     * commits nothing, because nothing was marked.
     */
    close() {
      if (closing) return closing;
      closing = (async () => {
        if (closed) return;
        await request("QUIT", { timeoutMs: 3_000 }).catch(() => undefined);
        fail(coded("POP3_CLOSED", "the POP3 connection was closed"));
      })();
      return closing;
    },
  };
}

module.exports = { MAX_LINE_BYTES, createClient };