# Changelog

## 0.1.0

- First release. The plugin watches one IMAP mailbox in the background and writes
  what arrives into the notification centre: one alert per message that matches
  the user's important-sender list or keyword list, or that the sender marked
  urgent, and one rolling digest for everything else. Nothing calls a model, so
  collecting, de-duplicating, deciding and notifying are free.
- Read-only by construction: the only IMAP verbs the plugin sends are
  `CAPABILITY`, `ID`, `SELECT`, `UID SEARCH`, `UID FETCH` with `BODY.PEEK`, `IDLE`,
  `DONE` and `LOGOUT`. Message bodies are never fetched and no flag is changed, so
  reading mail here does not mark it read in the mailbox. Sending, drafting,
  moving and deleting are not implemented in the host and are not claimed here.
- Five providers are built in, with the endpoint of each taken from the
  provider's own documentation: QQ Mail, NetEase 163, NetEase 126, Gmail and
  Tencent Exmail. Outlook / Hotmail is listed with its documented endpoint but
  reports itself as unavailable: Microsoft now accepts only OAuth2 for IMAP on
  personal accounts and the app performs a password login.
- The first connection establishes a UID cursor from the server's own `UIDNEXT`
  and announces nothing already in the mailbox; a `UIDVALIDITY` change re-baselines
  the same way. Reported Message-IDs are remembered (bounded at 200) so a restart,
  a reconnect or a duplicate copy does not alert twice.
- `IDLE` is used when the server offers it (renewed every 25 minutes), with a
  15-minute scheduled poll as the fallback, exponential backoff on a dropped
  connection (5 seconds to five minutes), and a `DONE`/`IDLE` re-arm after every
  batch rather than a busy loop.
- A missing credential or a rejected sign-in produces one notification-centre
  entry that explains which happened and links to **Check the mailbox now**.
- Requires Minih-Agent-Desktop 1.8.0 or newer: `credentials.use` with an `imap`
  slot, `net.tcp`, `notify.center` and `scheduler` all have to be present.
