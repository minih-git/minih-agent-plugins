# Changelog

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

## 0.1.0

- First release: one IMAP mailbox, read-only, notification-centre alerts for
  important senders, keywords and urgent headers, one rolling digest for the rest.
