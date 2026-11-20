/**
 * A scripted IMAP server, delivered through the same transport shape the plugin
 * uses in the app.
 *
 * The point is not to be a server: it is to be a witness. Every byte the plugin
 * writes lands in `sent`, so a test can assert what the plugin asked for — most
 * importantly that it never sends a `FETCH` without `BODY.PEEK`, which would mark
 * the user's mail as read. Responses can be delivered one byte at a time, which
 * is how the literal-chunking path gets exercised without a real network.
 *
 * The host performs the login in the real app, so this server starts after it:
 * the plugin's first write is `CAPABILITY`, never a credential.
 */

function quote(value) {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function addressList(entry) {
  const [mailbox, host] = String(entry?.address ?? "").split("@");
  return `((${quote(entry?.name ?? "")} NIL ${quote(mailbox ?? "")} ${quote(host ?? "")}))`;
}

/** One message as the fake server knows it. */
export function message({
  uid,
  from = { name: "", address: "sender@example.com" },
  subject = "Subject",
  rawSubject,
  rawName,
  messageId = `<${uid}@example.com>`,
  date = "14-Nov-2026 10:00:00 +0800",
  extraHeaders = [],
  flags = [],
} = {}) {
  return { uid, from, subject, rawSubject, rawName, messageId, date, extraHeaders, flags };
}

function envelopeOf(entry) {
  const name = entry.rawName ?? entry.from.name;
  const subject = entry.rawSubject ?? entry.subject;
  return [
    quote(entry.date),
    quote(subject),
    addressList({ ...entry.from, name }),
    addressList({ ...entry.from, name }),
    addressList({ ...entry.from, name }),
    "NIL",
    "NIL",
    "NIL",
    "NIL",
    quote(entry.messageId),
  ].join(" ");
}

function headersOf(entry) {
  const name = entry.rawName ?? entry.from.name;
  const subject = entry.rawSubject ?? entry.subject;
  const lines = [
    `From: ${name ? `"${name}" ` : ""}<${entry.from.address}>`,
    `Subject: ${subject}`,
    `Date: ${entry.date}`,
    `Message-ID: ${entry.messageId}`,
    ...entry.extraHeaders,
  ];
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function createFakeServer(options = {}) {
  const capabilities = options.capabilities ?? ["IMAP4rev1", "IDLE", "ID"];
  const server = {
    uidValidity: options.uidValidity ?? 7,
    uidNext: options.uidNext ?? 1,
    entries: options.messages ?? [],
    sent: [],
    connectCount: 0,
    chunkSize: options.chunkSize ?? 0,
    offline: false,
    failFetch: false,
    refuseId: false,
    /** Whether a `DONE` is ever answered, for the timeout path. */
    answerDone: options.answerDone ?? true,
    /** Commands this server accepts and never answers, for the timeout path. */
    mute: options.mute ?? [],
  };
  let dataListener = null;
  let closeListener = null;
  let idleTag = null;
  let open = false;

  function pushBuffer(buffer) {
    if (!open || !dataListener) return;
    const size = server.chunkSize > 0 ? server.chunkSize : buffer.length;
    for (let offset = 0; offset < buffer.length; offset += size) {
      dataListener(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    }
  }

  function push(text) {
    pushBuffer(Buffer.from(text, "utf8"));
  }

  function nextUid() {
    const uid = server.uidNext;
    server.uidNext += 1;
    return uid;
  }

  function sequenceOf(uid) {
    const index = server.entries.findIndex((entry) => entry.uid === uid);
    return index < 0 ? 0 : index + 1;
  }

  function selectReply(tag) {
    const lines = [
      `* ${server.entries.length} EXISTS`,
      "* 0 RECENT",
      `* OK [UIDVALIDITY ${server.uidValidity}] UIDs valid`,
      `* OK [UIDNEXT ${server.uidNext}] Predicted next UID`,
      `${tag} OK [READ-WRITE] SELECT completed`,
    ];
    push(`${lines.join("\r\n")}\r\n`);
  }

  function fetchReply(tag, set) {
    const wanted = set
      .split(",")
      .flatMap((part) => {
        const [from, to] = part.split(":");
        const start = Number(from);
        // "1" is one UID, "1:5" a range and "1:*" everything from 1 on.
        const end = to === undefined ? start : to === "*" ? Number.MAX_SAFE_INTEGER : Number(to);
        return server.entries.filter((entry) => entry.uid >= start && entry.uid <= end);
      })
      .filter((entry, index, list) => list.indexOf(entry) === index);
    if (server.failFetch) {
      push(`${tag} NO FETCH failed\r\n`);
      return;
    }
    for (const entry of wanted) {
      const headers = Buffer.from(headersOf(entry), "utf8");
      const lines = [
        `* ${sequenceOf(entry.uid)} FETCH (UID ${entry.uid}`,
        `FLAGS (${entry.flags.join(" ")})`,
        `INTERNALDATE "${entry.date}"`,
        `ENVELOPE (${envelopeOf(entry)})`,
        `BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IMPORTANCE X-PRIORITY X-MSMail-Priority)] {${headers.length}}\r\n`,
      ].join(" ");
      push(lines);
      pushBuffer(headers);
      push(")\r\n");
    }
    push(`${tag} OK FETCH completed\r\n`);
  }

  function searchReply(tag, rest) {
    const unseenOnly = /\bUNSEEN\b/i.test(rest);
    const range = /UID (\d+):(\S+)/i.exec(rest);
    const from = range ? Number(range[1]) : 1;
    const to = range && range[2] !== "*" ? Number(range[2]) : Number.MAX_SAFE_INTEGER;
    const uids = server.entries
      .filter((entry) => entry.uid >= from && entry.uid <= to)
      .filter((entry) => !unseenOnly || !entry.flags.includes("\\Seen"))
      .map((entry) => entry.uid);
    push(`* SEARCH${uids.length ? ` ${uids.join(" ")}` : ""}\r\n`);
    push(`${tag} OK SEARCH completed\r\n`);
  }

  const transport = {
    async send(data) {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
      server.sent.push(text);
      if (server.offline) return;
      for (const line of text.split("\r\n").filter(Boolean)) {
        if (line === "DONE") {
          if (!server.answerDone) continue;
          const tag = idleTag ?? "A0";
          idleTag = null;
          push(`${tag} OK IDLE terminated\r\n`);
          continue;
        }
        const match = /^(\S+) (.*)$/.exec(line);
        if (!match) continue;
        const [, tag, command] = match;
        const upper = command.toUpperCase();
        if (server.mute.some((prefixItem) => upper.startsWith(prefixItem.toUpperCase()))) continue;
        if (upper === "CAPABILITY") {
          push(`* CAPABILITY ${capabilities.join(" ")}\r\n${tag} OK CAPABILITY completed\r\n`);
        } else if (upper.startsWith("ID ")) {
          if (server.refuseId) push(`${tag} BAD ID not supported\r\n`);
          else push(`${tag} OK ID completed\r\n`);
        } else if (upper.startsWith("SELECT")) {
          selectReply(tag);
        } else if (upper.startsWith("UID SEARCH")) {
          searchReply(tag, command);
        } else if (upper.startsWith("UID FETCH")) {
          fetchReply(tag, /\s(\S+)\s+\(/.exec(command)?.[1] ?? "");
        } else if (upper === "IDLE") {
          idleTag = tag;
          push("+ idling\r\n");
        } else if (upper === "LOGOUT") {
          push(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
        } else {
          push(`${tag} OK ${command.split(" ")[0]} completed\r\n`);
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

  // The returned object *is* the server's state: a spread copy would leave the
  // command handlers reading stale values, which is exactly the kind of drift a
  // test must not have to notice.
  server.transport = transport;
  server.accept = () => {
    server.connectCount += 1;
    open = true;
    return transport;
  };
  server.deliver = (entry) => {
    server.entries.push(entry);
    if (idleTag) push(`* ${server.entries.length} EXISTS\r\n`);
    return entry;
  };
  /** Mail that arrives before the client is listening is only visible to SEARCH. */
  server.add = (entry) => {
    server.entries.push(entry);
    return entry;
  };
  server.nextUid = nextUid;
  /** Simulate the server dropping the socket under the client. */
  server.drop = (reason = "connection reset") => {
    open = false;
    dataListener = null;
    closeListener?.({ code: "CONNECT_FAILED", message: reason });
  };
  Object.defineProperty(server, "idling", { get: () => idleTag !== null });
  Object.defineProperty(server, "sentLines", {
    get: () => server.sent.join("").split("\r\n").filter(Boolean),
  });
  return server;
}
