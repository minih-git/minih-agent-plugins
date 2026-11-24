# Changelog

## 0.3.0

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
