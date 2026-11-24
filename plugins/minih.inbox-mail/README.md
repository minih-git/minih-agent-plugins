# Inbox mail

Watches up to **five** mailboxes and does two things with them: puts only the mail
you care about into the app's notification centre, and shows all of them in one
**Inbox** panel in the sidebar. Nothing here calls a model.

In the notification centre you get:

- **alert** — one entry per message that comes from an important sender, matches
  one of your keywords, or was marked urgent by the sender. The entry names the
  account it came from.
- **digest** — everything else, rolled up into one entry per account every N
  minutes. The same entry is updated instead of piling up.

In the panel you get every account's recent mail in one list, and one message at a
time in a reading pane. A message body is downloaded only when you open that
message; read state and the star change only when you click them.

## Set it up

1. **Turn on IMAP in your mailbox** and generate an authorization code (some
   providers call it an app password). A normal account password usually does not
   work for third-party clients, and an app password is the safer thing anyway:
   it can be revoked without changing your login.
2. **Open the Inbox panel in the sidebar → "Add mailbox"**, then fill the host's
   form with your full email address and that code. Repeat for up to five
   mailboxes; the same dialog also works in Settings → Plugins → Inbox mail.
3. The provider is inferred from the address (`qq.com`/`foxmail.com`, `163.com`,
   `126.com`, `gmail.com`/`googlemail.com`). A company address cannot be inferred,
   so the panel asks you to pick one; nothing is dialled until you do.
4. The first connection only records a starting point: it does not announce the
   mail already in the mailbox.

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
and the app performs the sign-in itself with a password only. The panel says so
instead of failing with a rejected login.

You cannot type a server of your own: the app only connects to endpoints the
plugin declares, and the plugin declares the five above (plus Outlook). That is
the price of a permission a reviewer can actually check.

## The Inbox panel

- **Mailboxes** — one card per account with its address, its provider (changeable
  in place), its state (connecting / connected / reconnecting / error with the
  reason / waiting for a provider), an "open the web mailbox" shortcut, and a
  remove button that asks once before it acts.
- **One list** — every account's mail, newest first, grouped into **Important**
  (the same rule as the alerts) and **Other**, with a filter per mailbox. Each row
  shows sender, subject, time, account, unread and star state.
- **One message** — the reading pane. Your choice of plain text or HTML, the
  attachment names and sizes (listed only, never downloaded), and a list of the
  message's links, which open in your real browser rather than inside the panel.
- **Actions** — mark read / unread and add / remove the star, each an explicit
  click, and each one IMAP `STORE` of `\Seen` or `\Flagged` on that one message.

HTML bodies are sanitized with a vendored copy of
[DOMPurify](https://github.com/cure53/DOMPurify) (3.2.7, Apache-2.0 OR MPL-2.0 —
see `view/vendor/`) and rendered in an `<iframe sandbox="">`: no scripts, no
same-origin access, and its own `default-src 'none'` policy. Remote images stay
blocked until you press "show remote images" for that one message, so a tracking
pixel never learns that you opened the mail.

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

The lists apply to every account. If you would rather not be told about mail you
have already read elsewhere, turn on **Only report unread mail**: the check then
asks the server for unseen messages only.

## What it reads, and what it keeps

- While watching, it selects the inbox and for new mail reads only the envelope
  and a few headers — `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID
  IMPORTANCE X-PRIORITY X-MSMail-Priority)]`. `PEEK` is the point: the other form
  would mark every message the plugin looks at as read.
- When you open a message it fetches that message only, with `BODY.PEEK[]<0.1048576>`:
  at most 1 MiB, truncated with a notice beyond that, held in memory for the
  panel and never written to disk. Attachments are listed by name and size and
  are never downloaded.
- It keeps one small file in its own data folder: per account `UIDVALIDITY`, the
  highest UID already handled, the Message-IDs it has already reported (at most
  200), the digest queue, the last error, and the envelope of the newest 200
  messages (sender, subject, time, flags). No message text is stored.
- It reads and star state only from your clicks, and each click sends exactly one
  `STORE`. It does not send mail, write drafts, delete, move, copy or archive
  messages. Its only network destination is the IMAP server of each account's
  provider; links you open go through the app to your browser.
- Your password never reaches the plugin. The app holds each credential instance
  and performs the IMAP login; the plugin gets an already-authenticated connection
  and only learns which accounts exist, their addresses and whether they are
  filled.

If a mailbox cannot connect, one entry appears in the notification centre saying
why, and it is updated in place rather than repeated. A mailbox that still needs
its provider gets one entry telling you to pick one in the panel.

## How it waits

Each account asks its server to push new mail (`IDLE`) and renews that request
every 25 minutes, because a server drops a longer one. If the server does not
offer `IDLE`, it falls back to a poll every 15 minutes. When a connection drops,
the next attempt waits 5 seconds, then 10, then 20, up to five minutes. A mailbox
whose `UIDVALIDITY` changed starts a fresh baseline instead of replaying itself.

One connection per mailbox, and the panel's own work runs on that connection
between two IDLEs, so five mailboxes cost five of the app's eight allowed
connections — never a sixth for opening a message.

**Check the mailboxes now**, from the command palette or from the link on any
notification, runs one check across every connected account.

## Upgrading from 0.1.0

The app turns your single mailbox into the first account of the new slot. On the
first run the plugin moves the old state file under that account, remembers the
provider you had chosen, and then deletes the old file. Re-running is safe. If two
accounts already exist there is no honest way to tell which one the old cursor
belonged to, so the old file is left alone and each account baselines itself.

## What is not here yet

- Folders, search, writing or replying, attachments, delete/move/archive.
- AI triage of what the deterministic rule missed.
- A mailbox server you type in yourself.
- Outlook/Hotmail, which needs XOAUTH2 in the host.

Published in this repository's catalog as `minih.inbox-mail` 0.2.0. It needs
Minih-Agent-Desktop 1.9.0 or newer — the first release with `multiple` credential
slots, `credentials.requestAdd` / `requestRemove`, `credentials:changed` and
sidebar `contributes.views`.
