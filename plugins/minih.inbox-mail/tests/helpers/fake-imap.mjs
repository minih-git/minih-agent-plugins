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

function addressEntry(entry) {
  const [mailbox, host] = String(entry?.address ?? "").split("@");
  return `(${quote(entry?.name ?? "")} NIL ${quote(mailbox ?? "")} ${quote(host ?? "")})`;
}

function addressList(entry) {
  return `(${addressEntry(entry)})`;
}

/** `((a)(b))` for a recipient list, `NIL` when it is empty. */
function addressSeq(list) {
  if (!Array.isArray(list) || !list.length) return "NIL";
  return `(${list.map(addressEntry).join("")})`;
}

/** One message as the fake server knows it. */
export function message({
  uid,
  from = { name: "", address: "sender@example.com" },
  to = [],
  cc = [],
  subject = "Subject",
  rawSubject,
  rawName,
  messageId = `<${uid}@example.com>`,
  date = "14-Nov-2026 10:00:00 +0800",
  extraHeaders = [],
  flags = [],
  raw,
  bodyText = "Hello from the test mailbox.",
  /** Whether the BODYSTRUCTURE should describe an attachment part. */
  attachment = false,
  /** The octet count the structure reports for that part, when a test needs one. */
  attachmentSize,
  /** A `BODYSTRUCTURE` to answer with instead of the default two-part one. */
  structure,
  /** Per-section bytes for a `BODY.PEEK[<part>]` fetch, keyed by section number. */
  parts,
} = {}) {
  return {
    uid,
    from,
    to,
    cc,
    subject,
    rawSubject,
    rawName,
    messageId,
    date,
    extraHeaders,
    flags,
    raw,
    bodyText,
    attachment,
    attachmentSize,
    structure,
    parts,
  };
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
    addressSeq(entry.to),
    addressSeq(entry.cc),
    "NIL",
    "NIL",
    quote(entry.messageId),
  ].join(" ");
}

/**
 * A `BODYSTRUCTURE` for one scripted message.
 *
 * `entry.attachment` adds a second part with an attachment disposition and a
 * file name, which is what the plugin's attachment icon is derived from without
 * downloading anything.
 */
function structureOf(entry) {
  // A test that needs a different tree (an inline image, a nested multipart) says
  // so; the default is one text part, plus an attachment when asked for.
  if (entry.structure) return entry.structure;
  const size = Buffer.byteLength(String(entry.bodyText ?? ""), "utf8");
  const text = `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${size} 3)`;
  if (!entry.attachment) return text;
  // `attachmentSize` lets a test describe an attachment the plugin must refuse
  // without building 50 MiB of bytes for it.
  const fileSize = entry.attachmentSize ?? 512;
  const file =
    `("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" ${fileSize} NIL ` +
    '("ATTACHMENT" ("FILENAME" "report.pdf")))';
  return `(${text}${file} "MIXED" ("BOUNDARY" "B0"))`;
}

function headersOf(entry) {
  const name = entry.rawName ?? entry.from.name;
  const subject = entry.rawSubject ?? entry.subject;
  const recipients = [];
  if (Array.isArray(entry.to) && entry.to.length) {
    recipients.push(`To: ${entry.to.map((one) => (one.name ? `"${one.name}" <${one.address}>` : one.address)).join(", ")}`);
  }
  if (Array.isArray(entry.cc) && entry.cc.length) {
    recipients.push(`Cc: ${entry.cc.map((one) => (one.name ? `"${one.name}" <${one.address}>` : one.address)).join(", ")}`);
  }
  const lines = [
    `From: ${name ? `"${name}" ` : ""}<${entry.from.address}>`,
    ...recipients,
    `Subject: ${subject}`,
    `Date: ${entry.date}`,
    `Message-ID: ${entry.messageId}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
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
    /** Every body fetch, so a test can assert the cap and that it happened once. */
    bodyFetches: [],
    /** Every STORE the plugin sent, as the raw command line. */
    stores: [],
    /** Every `BODY.PEEK[<part>]` fetch, so a test can prove only one part was asked for. */
    partFetches: [],
    /**
     * The mailboxes `LIST` reports.
     *
     * A test that exercises delete or archive sets these; the default is a single
     * inbox with no special-use mailbox at all, which is also a real server's
     * shape and is what proves the panel gets a clear error instead of a guess.
     */
    mailboxes: options.mailboxes ?? [],
    /** Every `UID MOVE`, `UID COPY` and `UID EXPUNGE`, as raw command lines. */
    moves: [],
    copies: [],
    expunges: [],
    /** Every `APPEND`: the mailbox, the flags and the exact bytes filed. */
    appends: [],
    /** What a one-part attachment fetch answers with, before base64 encoding. */
    attachmentData: options.attachmentData ?? "%PDF-1.4 fake attachment",
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

  /** The whole message as the server would send it, for a `BODY[]` fetch. */
  function rawMessage(entry) {
    if (typeof entry.raw === "string") return entry.raw;
    const lines = [
      `From: ${entry.rawName ?? entry.from.name ? `"${entry.rawName ?? entry.from.name}" ` : ""}<${entry.from.address}>`,
      `Subject: ${entry.rawSubject ?? entry.subject}`,
      `Date: ${entry.date}`,
      `Message-ID: ${entry.messageId}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      ...entry.extraHeaders,
    ];
    return `${lines.join("\r\n")}\r\n\r\n${entry.bodyText ?? ""}\r\n`;
  }

  function fetchReply(tag, set, command = "") {
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
    // A body fetch: the whole message, capped by the `<0.N>` octet range the
    // plugin asked for, exactly like a real server's partial section.
    if (/BODY\.PEEK\[\]/i.test(command)) {
      const cap = /<0\.(\d+)>/.exec(command);
      for (const entry of wanted) {
        const full = Buffer.from(rawMessage(entry), "utf8");
        // A test can claim the message is bigger than what it actually sends,
        // which is how the plugin's truncation notice is exercised.
        const size = server.sizeOverride ?? full.length;
        const body = cap ? full.subarray(0, Math.min(size, Number(cap[1]))) : full;
        server.bodyFetches.push({ uid: entry.uid, size, sent: body.length });
        push(
          `* ${sequenceOf(entry.uid)} FETCH (UID ${entry.uid} RFC822.SIZE ${size} ` +
            `${cap ? "BODY[]<0>" : "BODY[]"} {${body.length}}\r\n`,
        );
        pushBuffer(body);
        push(")\r\n");
      }
      push(`${tag} OK FETCH completed\r\n`);
      return;
    }
    // A one-part fetch: `BODY.PEEK[1.2]` is exactly one part's bytes. The fake
    // answers with the scripted payload in the encoding the structure declares, so
    // a test can check the plugin decodes rather than trusting the reply — and it
    // can script a different payload per section, which is how a test proves the
    // plugin fetched the part the user clicked rather than a neighbouring one.
    const partSection = /BODY\.PEEK\[(\d+(?:\.\d+)*)\]/i.exec(command);
    if (partSection) {
      const section = partSection[1];
      for (const entry of wanted) {
        const scripted = entry.parts?.[section];
        if (scripted === undefined && !entry.attachment) continue;
        const payload = Buffer.from(String(scripted ?? entry.attachmentData ?? server.attachmentData), "utf8").toString(
          "base64",
        );
        server.partFetches.push({ uid: entry.uid, section });
        push(`* ${sequenceOf(entry.uid)} FETCH (UID ${entry.uid} BODY[${section}] {${payload.length}}\r\n`);
        push(payload);
        push(")\r\n");
      }
      push(`${tag} OK FETCH completed\r\n`);
      return;
    }
    for (const entry of wanted) {
      const headers = Buffer.from(headersOf(entry), "utf8");
      const full = Buffer.from(String(entry.bodyText ?? ""), "utf8");
      // The capped `BODY[TEXT]` fragment the plugin asks for to build the list's
      // preview: the first bytes of the body, never the whole message.
      const textCap = /BODY\.PEEK\[TEXT\]<0\.(\d+)>/i.exec(command);
      const text = textCap ? full.subarray(0, Number(textCap[1])) : full;
      const lines = [
        `* ${sequenceOf(entry.uid)} FETCH (UID ${entry.uid}`,
        `FLAGS (${entry.flags.join(" ")})`,
        `INTERNALDATE "${entry.date}"`,
        `ENVELOPE (${envelopeOf(entry)})`,
        `RFC822.SIZE ${Buffer.byteLength(rawMessage(entry), "utf8")}`,
        `BODYSTRUCTURE ${structureOf(entry)}`,
        `BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING IMPORTANCE X-PRIORITY X-MSMail-Priority)] {${headers.length}}\r\n`,
      ].join(" ");
      push(lines);
      pushBuffer(headers);
      if (textCap) {
        push(` BODY[TEXT]<0> {${text.length}}\r\n`);
        pushBuffer(text);
      }
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

  /**
   * `UID STORE <set> +FLAGS (…) -FLAGS (…)`, applied to the scripted messages.
   *
   * The reply is the untagged `FETCH (FLAGS (…))` a real server sends, which is
   * what the plugin writes back into its own list.
   */
  function storeReply(tag, command) {
    server.stores.push(command);
    const match = /^UID STORE\s+(\S+)\s+(.*)$/i.exec(command);
    const set = match?.[1] ?? "";
    const rest = match?.[2] ?? "";
    const uids = set.split(",").flatMap((part) => {
      const [from, to] = part.split(":");
      const start = Number(from);
      const end = to === undefined ? start : to === "*" ? Number.MAX_SAFE_INTEGER : Number(to);
      return server.entries.filter((entry) => entry.uid >= start && entry.uid <= end).map((entry) => entry.uid);
    });
    for (const uid of uids) {
      const entry = server.entries.find((item) => item.uid === uid);
      if (!entry) continue;
      for (const item of rest.matchAll(/([+-])FLAGS(?:\.SILENT)?\s*\(([^)]*)\)/gi)) {
        const sign = item[1];
        const flags = item[2].split(/\s+/).filter(Boolean);
        for (const flag of flags) {
          const has = entry.flags.includes(flag);
          if (sign === "+" && !has) entry.flags.push(flag);
          if (sign === "-" && has) entry.flags.splice(entry.flags.indexOf(flag), 1);
        }
      }
      push(`* ${sequenceOf(entry.uid)} FETCH (UID ${entry.uid} FLAGS (${entry.flags.join(" ")}))\r\n`);
    }
    push(`${tag} OK STORE completed\r\n`);
  }

  /**
   * `LIST`, with the special-use flags a test scripted.
   *
   * A real server answers the plain form and the `(SPECIAL-USE)` form
   * differently, and the plugin asks for the second only when the capability is
   * advertised; both are answered from the same scripted list here, which is what
   * lets a test assert which form was sent without pretending to be two servers.
   */
  function listReply(tag, command) {
    const specialUseOnly = /\(SPECIAL-USE\)/i.test(command);
    const entries = specialUseOnly
      ? server.mailboxes.filter((entry) => entry.flags.some((flag) => /^\\?(Trash|Archive|Sent|Drafts|Junk)$/i.test(flag)))
      : server.mailboxes;
    for (const entry of entries) {
      const flags = entry.flags.length ? `(${entry.flags.join(" ")})` : "()";
      push(`* LIST ${flags} ${quote(entry.delimiter ?? "/")} ${quote(entry.name)}\r\n`);
    }
    push(`${tag} OK LIST completed\r\n`);
  }

  /** Remove one entry from the maildrop, as a move or an expunge would. */
  function dropEntry(uid) {
    const index = server.entries.findIndex((entry) => entry.uid === uid);
    if (index < 0) return null;
    const [entry] = server.entries.splice(index, 1);
    return entry;
  }

  function moveReply(tag, command, verb) {
    const [, , set, target] = /^UID (MOVE|COPY)\s+(\S+)\s+(.+)$/i.exec(command) ?? [];
    const uid = Number(set ?? 0);
    // The mailbox is a quoted string on the wire; the record keeps the name.
    const mailbox = String(target ?? "").replace(/^"|"$/g, "");
    if (verb === "MOVE") {
      server.moves.push({ uid, mailbox });
      dropEntry(uid);
      push(`* ${server.entries.length + 1} EXPUNGE\r\n`);
    } else {
      server.copies.push({ uid, mailbox });
    }
    push(`${tag} OK ${verb} completed\r\n`);
  }

  function expungeReply(tag, command) {
    const uid = Number(/^UID EXPUNGE\s+(\d+)/i.exec(command)?.[1] ?? 0);
    server.expunges.push({ uid, command });
    if (dropEntry(uid)) push(`${tag} OK EXPUNGE completed\r\n`);
    else push(`${tag} OK EXPUNGE completed\r\n`);
  }

  /**
   * The literal an `APPEND` is waiting for.
   *
   * A real server answers the command with `+ Ready for literal data` and only
   * then does the client send the message bytes. The fake keeps that shape so a
   * test can prove the plugin waits instead of writing the literal unsolicited.
   */
  let pendingAppend = null;

  const transport = {
    async send(data) {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
      server.sent.push(text);
      if (server.offline) return;
      if (pendingAppend) {
        const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : Buffer.from(data);
        pendingAppend.chunks.push(bytes);
        const total = pendingAppend.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        // The command's own trailing CRLF belongs to the command line, not to the
        // literal: the append is complete once the declared bytes are in.
        if (total < pendingAppend.size) return;
        const literal = Buffer.concat(pendingAppend.chunks).subarray(0, pendingAppend.size);
        server.appends.push({ mailbox: pendingAppend.mailbox, flags: pendingAppend.flags, message: literal });
        const tag = pendingAppend.tag;
        pendingAppend = null;
        push(`${tag} OK APPEND completed\r\n`);
        return;
      }
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
          fetchReply(tag, /\s(\S+)\s+\(/.exec(command)?.[1] ?? "", command);
        } else if (upper.startsWith("UID STORE")) {
          storeReply(tag, command);
        } else if (upper.startsWith("UID MOVE")) {
          moveReply(tag, command, "MOVE");
        } else if (upper.startsWith("UID COPY")) {
          moveReply(tag, command, "COPY");
        } else if (upper.startsWith("UID EXPUNGE")) {
          expungeReply(tag, command);
        } else if (upper.startsWith("LIST")) {
          listReply(tag, command);
        } else if (upper.startsWith("APPEND")) {
          // `APPEND "Sent" (\Seen) {123}`: answer with a continuation and wait for
          // the literal the plugin sends next.
          const literal = /\{(\d+)\+?\}$/.exec(command);
          const mailbox = /^APPEND\s+"((?:[^"\\]|\\.)*)"/i.exec(command)?.[1] ?? "";
          const flags = /\(([^)]*)\)/.exec(command)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
          pendingAppend = { tag, size: Number(literal?.[1] ?? 0), mailbox, flags, chunks: [] };
          push("+ Ready for literal data\r\n");
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
