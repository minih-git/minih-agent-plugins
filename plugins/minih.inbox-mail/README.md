# Inbox mail

Watches one mailbox and puts only the mail you care about in the app's
notification centre. It is the first information source of a resident assistant:
the mail arrives while you are doing something else, and the app tells you about
it without opening a mail client.

Two kinds of entry, decided by your own rules, with no model in the loop:

- **alert** — one entry per message that comes from an important sender, subject
  or sender name matching one of your keywords, or that the sender marked urgent.
- **digest** — everything else, rolled up into one entry every N minutes. The same
  entry is updated instead of piling up.

A notification carries the sender, the subject and the time. The body of the mail
is never fetched, so it is never shown, stored or forwarded.

## Set it up

1. **Turn on IMAP in your mailbox** and generate an authorization code (some
   providers call it an app password). A normal account password usually does not
   work for third-party clients, and an app password is the safer thing anyway:
   it can be revoked without changing your login.
2. **Settings → Plugins → Inbox mail.** Pick your provider, then fill the one
   credential slot with your full email address and that code.
3. That is all. The first connection only records a starting point: it does not
   announce the mail already in the mailbox.

| Provider | IMAP server | Enable it / get a code |
| --- | --- | --- |
| QQ Mail | `imap.qq.com:993` | Settings → Account → enable IMAP; the 16-digit authorization code — [help](https://help.mail.qq.com/detail/108/1090/) |
| NetEase 163 | `imap.163.com:993` | Settings → POP3/SMTP/IMAP → enable IMAP; client authorization code — [help](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac22b85ac2e7c90cd63) |
| NetEase 126 | `imap.126.com:993` | Same as 163 — [help](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac22b85ac2e7c90cd63) |
| Gmail | `imap.gmail.com:993` | Turn on 2-step verification, then create an app password — [help](https://developers.google.com/gmail/imap/imap-smtp) |
| Tencent Exmail | `imap.exmail.qq.com:993` | Settings → mail client; use the client-specific password — [help](https://open.work.weixin.qq.com/help2/pc/19886) |

**Outlook / Hotmail is listed but cannot connect yet.** Microsoft now accepts only
OAuth2 for IMAP on personal accounts
([settings page](https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040)),
and the app performs the sign-in itself with a password only. The provider will
work as soon as the host learns XOAUTH2; until then the plugin says so instead of
failing with a rejected login.

You cannot type a server of your own: the app only connects to endpoints the
plugin declares, and the plugin declares the five above (plus Outlook). That is
the price of a permission a reviewer can actually check, and it is why a
self-hosted server is a later slice rather than a setting.

## How importance is decided

Nothing here calls a model, so the rule is short enough to predict:

| Situation | Result |
| --- | --- |
| the sender is on your **important senders** list | alert |
| the subject or the sender's name contains one of your **keywords** | alert |
| the message carries `Importance: high`, `X-Priority: 1` or `X-MSMail-Priority: High` | alert |
| anything else | digest, every *digest interval* minutes |

An important-sender entry can be a full address (`boss@example.com`), a domain
(`@example.com`, which matches everyone there) or a bare word, which matches the
start of the address (`finance@…`) or anywhere in the display name. Keywords are
plain substrings, case-insensitive, checked against the subject and the sender's
name — not the body, which is not fetched.

If you would rather not be told about mail you have already read elsewhere, turn
on **Only report unread mail**: the check then asks the server for unseen messages
only. Reading is never the plugin's doing — it changes no flags at all.

## What it reads, and what it keeps

- It selects the inbox and reads the mailbox's UID cursor, then for new mail only
  the envelope and a few headers — `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE
  MESSAGE-ID IMPORTANCE X-PRIORITY X-MSMail-Priority)]`. `PEEK` is the point: the
  other form would mark every message the plugin looks at as read.
- It keeps one small file in its own data folder: `UIDVALIDITY`, the highest UID
  already handled, the Message-IDs it has already reported (at most 200), the
  queue for the current digest, and the last error. No message text is stored.
- It does not send mail, write drafts, delete, move or copy messages, or change
  read state. Its only network destination is the IMAP server of the provider you
  picked, and its only stored output is notification-centre entries.
- Your password never reaches the plugin. The app holds the credential and
  performs the IMAP login; the plugin gets an already-authenticated connection
  and only ever learns whether the slot is filled.

If the mailbox is not configured, or the server rejects the sign-in, one entry
appears in the notification centre saying which of the two happened. It is
updated in place rather than repeated.

## How it waits

The plugin asks the server to push new mail (`IDLE`) and renews that request every
25 minutes, because a server drops a longer one. If the server does not offer
`IDLE`, it falls back to a poll every 15 minutes. When the connection drops, the
next attempt waits 5 seconds, then 10, then 20, up to five minutes: a laptop that
comes back from sleep reconnects in seconds, and a network that is simply down
does not cost a handshake every few seconds. A mailbox whose `UIDVALIDITY` changed
starts a fresh baseline instead of replaying itself.

**Check the mailbox now**, from the command palette or from the link on any
notification, runs one check immediately.

## What is not here yet

- AI triage of what the deterministic rule missed. The classification is already
  one function with one return value, so a model can be added behind it without
  changing the collector.
- A mailbox server you type in yourself.
- Outlook/Hotmail, which needs XOAUTH2 in the host.
- Publishing to the marketplace: this plugin needs Desktop 1.8.0, so it is not in
  `catalog.json` until that version ships.

Requires Minih-Agent-Desktop 1.8.0 or newer.
