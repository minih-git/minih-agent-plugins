# Changelog

## 0.4.0

- **The Inbox panel has been rebuilt along the lines of a real mail client.** Three
  columns stay, but each one now earns its space. The mailbox column is a list of
  rows — status dot, address, unread count — with the fixed **All inboxes** row on
  top and a **⋯** menu per account (**Only this mailbox**, **Check this mailbox
  now**, **Open web mailbox**, **Remove this mailbox**, confirmed in the panel
  first). The list gained a search box (over sender, subject, preview and account,
  focused with `/`), four filters (All / Unread / Starred / Important) and
  **Today / Yesterday / This week / Earlier** headings; the old split into
  "Important" and "Other" is now the Important filter. Rows show a colored initials
  avatar, a short time that lengthens with age, the subject, a one-line preview,
  and star/attachment tags, and reveal read/unread, star and delete on hover or
  keyboard focus. The reading pane gained a large subject, the sender's avatar and
  address, a folded "to me and N more" recipient line, the full timestamp, an icon
  toolbar with tooltips and `aria-label`s, attachment cards, and a skeleton while
  the body loads.
- **Keyboard shortcuts, in the panel only:** `j`/`k` or the arrow keys move,
  `Enter` opens, `u` toggles read, `s` toggles the star, `#` or `Delete` deletes,
  `e` archives, `/` searches, `Esc` closes the reading pane or clears the search.
  None of them fire while you are typing in the search box.
- **Responsive:** three columns at 1100 px and above, a rail of status dots between
  700 and 1100, and a single pane below 700 with "back" as the way out of a
  message. The sidebar toggle hides the mailbox column at any width.
- **A one-line preview of every message, and it is stored.** A new message brings
  `BODY.PEEK[TEXT]<0.4096>` (IMAP) or `TOP n 12` (POP3) along with its envelope,
  which `lib/summary.js` turns into at most 140 characters of plain text: transfer
  encodings and charsets decoded, markup stripped, multipart read part by part, a
  base64 part skipped rather than previewed as noise. The envelope in the state
  file now also holds the message's To and Cc (up to 20 addresses each, from
  `ENVELOPE`) and whether it has an attachment (from `BODYSTRUCTURE`); nothing is
  downloaded to find that out.
- **Loading older mail.** With one mailbox selected, the list offers **Load older
  mail**: IMAP searches below the oldest UID it holds (`UID SEARCH 1:<n>`) and fetches
  the 50 nearest, POP3 walks back through the UIDLs in maildrop order. The pages are bounded by the same 200-message list, nothing is
  announced, and the UID cursor does not move.
- **Delete and archive.** New panel channels `inbox.delete` and `inbox.archive`,
  both acting on one message after a click. IMAP finds the trash with `LIST` — the
  special-use `\Trash` flag first, then names such as `Trash`, `Deleted Messages`
  or `已删除` — and sends one `UID MOVE`; a server without `MOVE` gets `UID COPY`,
  `UID STORE +FLAGS (\Deleted)` and `UID EXPUNGE <uid>` for that UID. A server with
  neither, or a mailbox with no trash, is refused with a clear error code; this
  plugin never sends a mailbox-wide `EXPUNGE`. Archive is the same into a
  special-use `\Archive` mailbox (or Gmail's All Mail) and is offered only when
  `LIST` found one, reported per account as `canArchive`/`canDelete`. POP3 delete
  is `DELE <n>` followed by `QUIT`, so it is final: the panel asks first and then
  says it cannot be undone. The folder probe is cached per account and re-run when
  the account's connection changes.
- **The stored file is written atomically** (temporary file + rename), so a crash
  cannot leave half a JSON document — and a UID cursor — behind.
- **Honest docs.** The manifest's safety notes, its description, the README and the
  manifest test now say what is really stored (the ≤140-character preview, the
  recipients, the attachment flag) and exactly which commands delete and archive
  send, instead of promising that no mail is ever moved.
- **A proxy per mailbox.** The credential slot declares `userProxy: { types:
  ["http", "socks5"] }` as a top-level key — not inside `userEndpoint`, because a
  1.10.0 host refuses an unknown key there and ignores an unknown top-level one,
  which is what lets this manifest still install on 1.10.0 (without a proxy). The
  host performs the handshake (HTTP `CONNECT` / SOCKS5, optional username and
  password) and then the usual TLS or STARTTLS login to the mail server, with the
  certificate checked against the mail host. There is no direct fallback: a
  failing proxy fails the account.
- `PROXY_FAILED` and `PROXY_AUTH_FAILED` are mapped: the panel banner, the
  one-time account notice (naming the proxy endpoint, e.g. `无法连接代理
  127.0.0.1:7897`) and the account card's tooltip (`经代理 127.0.0.1:7897`, from the
  published `proxyType`/`proxyHost`/`proxyPort`). The proxy username and password
  are never published, so the plugin cannot read them and does not ask.
- Requires Desktop 1.11.0 (`engines.minihAgent` is `>=1.11.0`), the release that
  ships `userProxy`. Not published to the catalog until that release exists.

## 0.3.0

- **HTML mail is shown as HTML.** An HTML part is the default view (the "show plain
  text" toggle remains), the frame is white paper whatever the app theme is, and
  the message's own colours are never overridden. The forced `td`/`th` border and
  padding are gone, so a newsletter's layout tables are not drawn as a grid. The
  message's `<style>` blocks survive: DOMPurify drops them, so they are lifted out
  of the raw document, scrubbed of `@import` and `expression()`, and placed after
  the frame's defaults. A plain-text message is rendered as wrapped prose with its
  links as buttons that open through the host, instead of a monospace `<pre>`. The
  security model is unchanged: `sandbox=""`, the frame CSP, remote images blocked
  by default, links opened externally.
- **A notification opens the Inbox panel.** Alert, digest, account-error and
  provider/server rows carry `link: { view: "inbox" }` instead of pointing at the
  `check-now` command, so clicking one shows the message or the account that needs
  attention rather than silently re-checking. The command stays in the command
  palette (and behind the panel's "Check now"); it is no longer a notification's
  target.
- **Opening a message marks it read.** An IMAP account (preset or custom) sends one
  `UID STORE +FLAGS (\Seen)` on that message after the capped `BODY.PEEK[]` body
  has arrived — a failed or refused fetch marks nothing, and a message that is
  already read is not stored again. A failed `STORE` shows a line in the pane and
  the body is still shown. The list and the unread count update immediately, and
  "mark unread" stays available. POP3 has no flags on the server, so read there is
  a local mark (at most 500 entries, like the UIDL set), "mark unread" only drops
  that mark, and the pane says the state is kept on this computer.
- **No mailbox limit.** The credential slot declares `multiple: {}` — no `max` —
  so the number of accounts is decided by the host's own safety bound (100) rather
  than by this plugin. Requires the 1.10.0 manifest rule that allows `max` to be
  omitted.
- **Every account is polled, not connected.** The IDLE connection, its 25-minute
  renewal and the 15-minute fallback schedule are gone: once every three minutes
  each account opens one short session (connect → select → new headers → log out),
  at most four sessions exist at once through one shared gate, and starts are
  staggered 1.5 s apart. Opening a message or changing a star is one more short
  session. That is what makes an unlimited account list fit inside the host's
  eight-connection ceiling, and it removes the `scheduler` permission and the
  `poll` schedule contribution.
- **A mail server you type in yourself.** The `mailbox` credential slot declares
  `userEndpoint: { protocols: ["imap", "pop3"] }`, so the host's account dialog
  gains a "custom server" section — protocol, server, encryption, port — and the
  four non-secret fields come back in `credentials.list`. An account whose
  `publicFields.server` is set connects with its `credentialRef` only and no
  endpoint: the endpoint lives in that instance, the host injects the password
  into that endpoint and no other, and the plugin never names a host of its own
  choosing. Preset providers are unchanged, allowlist included. Requires Desktop
  1.10.0 (`engines.minihAgent` is `>=1.10.0`).
- **POP3 receiving**, for a typed server: a new polling watcher opens one short
  session every five minutes — never sooner than the server's `LOGIN-DELAY` —
  with `CAPA`, `STAT`, `UIDL`, `TOP n 0` for the headers of unseen mail and
  `QUIT`. The first poll records a baseline and announces nothing; what is
  remembered is the UIDL (at most 500), because a message number only holds
  inside one session. Opening a message is another short session that resolves
  the UIDL and keeps at most 1 MiB of the `RETR`, draining the rest. It never
  sends `DELE`: the command is not implemented at all.
- A POP3 account has no read or starred state, so the panel hides those actions
  and says why in one line, and "Only report unread mail" does not apply to it.
- A company domain the plugin cannot place now shows both the provider list and a
  hint that the server can be typed in the account dialog instead.
- New copy in both languages: the panel (`view/strings.js`), the notification
  reasons (including `STARTTLS_UNAVAILABLE` and a certificate that does not
  verify) and the manifest's `en` / `zh-CN` blocks, whose safety notes now
  describe the custom endpoint and POP3.
- The sidebar icon is now `mail` instead of `bell`. Desktop 1.10.0 adds that
  name to its icon list; an older host that does not know it draws a letter tile
  rather than failing.
- Not published to the catalog in this version: the host release that ships
  `userEndpoint` and the POP3 login comes first.

## 0.2.0

- Up to five mailboxes, each an instance of the host's `mailbox` credential slot
  (`multiple: { max: 5 }`, labelled by the email address). Requires Desktop 1.9.0.
- The mail provider is recorded per account instead of being one global setting:
  inferred from the address's domain when it is unambiguous, chosen in the panel
  otherwise, and stored in the plugin's own data file. The credential field set is
  unchanged, so an account migrated from 0.1.0 stays complete.
- New sidebar view **Inbox**: every account together, important and other mail
  grouped, one filter per account.
- Opening a message downloads that one body (`BODY.PEEK[]`, capped at 1 MiB) on
  the account's existing connection; nothing is written to disk. HTML bodies are
  sanitized with a vendored DOMPurify and rendered in an empty-sandbox iframe
  under a `default-src 'none'` policy: no script, no remote image until asked, no
  link navigation inside the panel.
- Mark read/unread and add/remove the star are explicit clicks, each one IMAP
  `STORE` of `\Seen` or `\Flagged`.
- Alerts and digests name their account, and de-duplication is per account.
- Upgrade path: the 0.1.0 state file is adopted by the single migrated instance
  on first run and then removed; re-running is safe.
- Permissions: adds `ui.view` (the panel) and `shell.openExternal` (opening a
  message's links and the web mailbox in the browser). `net.tcp`, its allowlist
  and the credential scope are unchanged.
- Fixed in the same version, before release: a docked view's `html`/`body` are
  made transparent by the host, so the panel's own surface has to be painted by
  the panel. The mail column and the notice banner now carry their own opaque
  theme colours instead of falling through to the host's white surface, and the
  page declares `color-scheme` per theme so native controls and scrollbars follow
  the dark palette.

## 0.1.0

- First release: one IMAP mailbox, read-only, notification-centre alerts for
  important senders, keywords and urgent headers, one rolling digest for the rest.
