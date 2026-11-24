/**
 * A scripted POP3 server, delivered through the same transport shape the plugin
 * uses in the app.
 *
 * The host performs the login in the real app, so this server starts in the
 * transaction state: the plugin's first write is `CAPA`, never a credential. As
 * with the IMAP fake, the point is to be a witness — every command the plugin
 * sends lands in `sent`, and every message the server sends is dot-stuffed the
 * way RFC 1939 requires, so the client's unstuffing is actually exercised.
 */

/** One message as the fake server knows it. */
export function popMessage({
  uidl,
  from = { name: "", address: "sender@example.com" },
  subject = "Subject",
  messageId = `<${uidl ?? "1"}@example.com>`,
  date = "Fri, 14 Nov 2026 10:00:00 +0800",
  extraHeaders = [],
  body = "Hello from the test maildrop.",
} = {}) {
  return { uidl, from, subject, messageId, date, extraHeaders, body };
}

/**
 * A header value the way a real server writes it: plain ASCII stays as-is, and
 * anything else becomes an RFC 2047 encoded word, which is what the plugin's
 * MIME decoder exists to read.
 */
function headerText(value) {
  const text = String(value ?? "");
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** The header block of one message, ending with the blank line before the body. */
function headersOf(entry) {
  const name = headerText(entry.from.name);
  return [
    `From: ${name ? `"${name}" ` : ""}<${entry.from.address}>`,
    `Subject: ${headerText(entry.subject)}`,
    `Date: ${entry.date}`,
    `Message-ID: ${entry.messageId}`,
    ...entry.extraHeaders,
    "",
    "",
  ].join("\r\n");
}

function rawOf(entry) {
  return `${headersOf(entry)}${entry.body ?? ""}`;
}

/** Dot-stuff and terminate one multi-line block, the way a POP3 server must. */
function multiLine(lines) {
  const stuffed = lines.map((line) => (line.startsWith(".") ? `.${line}` : line));
  return `${stuffed.join("\r\n")}\r\n.\r\n`;
}

export function createFakePop3Server(options = {}) {
  const server = {
    entries: options.messages ?? [],
    capabilities: options.capabilities ?? ["TOP", "UIDL", "USER", "RESP-CODES"],
    /** Seconds the server asks the client to wait between logins. */
    loginDelay: options.loginDelay ?? 0,
    /** `CAPA` refused: RFC 2449 makes the command optional. */
    refuseCapa: options.refuseCapa ?? false,
    /** `TOP` refused: the client has to fall back to a capped RETR. */
    refuseTop: options.refuseTop ?? false,
    /** `UIDL` refused, which is a session this plugin cannot use. */
    refuseUidl: options.refuseUidl ?? false,
    /** Bytes per delivery, so chunk splitting is exercised. */
    chunkSize: options.chunkSize ?? 0,
    offline: false,
    sent: [],
    connects: 0,
  };
  let dataListener = null;
  let closeListener = null;
  let open = false;

  function pushBuffer(buffer) {
    if (!open || !dataListener) return;
    const size = server.chunkSize > 0 ? server.chunkSize : buffer.length;
    for (let offset = 0; offset < buffer.length; offset += size) {
      dataListener(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    }
  }

  function push(text) {
    pushBuffer(Buffer.from(text, "latin1"));
  }

  function sizeOf() {
    return server.entries.reduce((total, entry) => total + Buffer.byteLength(rawOf(entry), "latin1"), 0);
  }

  function capaReply() {
    const lines = server.capabilities.slice();
    if (server.loginDelay > 0) lines.push(`LOGIN-DELAY ${server.loginDelay}`);
    push(`+OK capability list follows\r\n${multiLine(lines)}`);
  }

  function uidlReply() {
    if (server.refuseUidl) {
      push("-ERR UIDL not supported\r\n");
      return;
    }
    const lines = server.entries.map((entry, index) => `${index + 1} ${entry.uidl}`);
    push(`+OK ${server.entries.length} messages\r\n${multiLine(lines)}`);
  }

  function topReply(command) {
    if (server.refuseTop) {
      push("-ERR TOP not supported\r\n");
      return;
    }
    const number = Number(/^TOP\s+(\d+)/i.exec(command)?.[1] ?? 0);
    const entry = server.entries[number - 1];
    if (!entry) {
      push("-ERR no such message\r\n");
      return;
    }
    // `TOP n 0` is the headers plus the empty line that ends them.
    push(`+OK top of message ${number}\r\n${multiLine(headersOf(entry).split("\r\n"))}`);
  }

  function retrReply(command) {
    const number = Number(/^RETR\s+(\d+)/i.exec(command)?.[1] ?? 0);
    const entry = server.entries[number - 1];
    if (!entry) {
      push("-ERR no such message\r\n");
      return;
    }
    const raw = rawOf(entry);
    push(`+OK ${Buffer.byteLength(raw, "latin1")} octets\r\n${multiLine(raw.split("\r\n"))}`);
  }

  const transport = {
    async send(data) {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
      server.sent.push(text);
      if (server.offline) return;
      for (const line of text.split("\r\n").filter(Boolean)) {
        const upper = line.toUpperCase();
        if (upper === "CAPA") {
          if (server.refuseCapa) push("-ERR unknown command\r\n");
          else capaReply();
        } else if (upper === "STAT") {
          push(`+OK ${server.entries.length} ${sizeOf()}\r\n`);
        } else if (upper === "UIDL") {
          uidlReply();
        } else if (upper.startsWith("TOP ")) {
          topReply(line);
        } else if (upper.startsWith("RETR ")) {
          retrReply(line);
        } else if (upper === "QUIT") {
          push("+OK bye\r\n");
        } else if (upper.startsWith("DELE ")) {
          // A real server would mark the message; this one only records it, so a
          // test can prove the plugin never asks.
          push("+OK marked\r\n");
        } else {
          push("-ERR unknown command\r\n");
        }
      }
    },
    async close() {
      open = false;
      closeListener?.(null);
    },
    onData(listener) {
      dataListener = listener;
      return () => {
        dataListener = null;
      };
    },
    onClose(listener) {
      closeListener = listener;
      return () => {
        closeListener = null;
      };
    },
  };

  server.transport = transport;
  server.accept = () => {
    server.connects += 1;
    open = true;
    return transport;
  };
  /** Mail that arrives between two sessions. */
  server.deliver = (entry) => {
    server.entries.push(entry);
    return entry;
  };
  server.drop = (reason = "connection reset") => {
    open = false;
    dataListener = null;
    closeListener?.({ code: "CONNECT_FAILED", message: reason });
  };
  Object.defineProperty(server, "sentLines", {
    get: () => server.sent.join("").split("\r\n").filter(Boolean),
  });
  return server;
}