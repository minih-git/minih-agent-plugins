# Inbox mail

Watches your mailboxes — as many as you add — and does two things with them: puts
only the mail you care about into the app's notification centre, and shows all of
them in one **Inbox** panel in the sidebar. Nothing here calls a model.

A mailbox is either one of the providers listed below or **a mail server you type
in yourself** — IMAP or POP3, implicit TLS or STARTTLS — which is what makes a
company mailbox usable. A POP3 mailbox is polled and has no read or star state;
everything else works the same for both.

In the notification centre you get:

- **alert** — one entry per message that comes from an important sender, matches
  one of your keywords, or was marked urgent by the sender. The entry names the
  account it came from.
- **digest** — everything else, rolled up into one entry per account every N
  minutes. The same entry is updated instead of piling up.

In the panel you get every account's recent mail in one list, and one message at a
time in a reading pane. A message body is downloaded only when you open that
message, and opening it marks it read — one `STORE` of `\Seen` after the body has
actually arrived, never before. The star changes only when you click it, and
"mark unread" is always there to undo the read.

## Set it up

1. **Turn on IMAP (or POP3) in your mailbox** and generate an authorization code
   (some providers call it an app password). A normal account password usually
   does not work for third-party clients, and an app password is the safer thing
   anyway: it can be revoked without changing your login.
2. **Open the Inbox panel in the sidebar → "Add mailbox"**, then fill the host's
   form with your full email address and that code. Repeat for each mailbox you
   want; the same dialog also works in Settings → Plugins → Inbox mail.
3. **Pick your mail service in that same form** — QQ Mail, NetEase 163/126, Gmail,
   Tencent Exmail, or **Custom server**. The form is where the provider belongs:
   it is a required choice, so the plugin never has to guess from a domain. If your
   mail service is not in the list, choose **Custom server** and type the address
   your administrator gave you:

   | Field | What to enter |
   | --- | --- |
   | Protocol | `IMAP` or `POP3` |
   | Server | the bare host name or IP the administrator gave you (`mail.example.com`, `10.0.0.5`) — no `https://`, no port, no path |
   | Encryption | `SSL/TLS` (implicit, the default port) or `STARTTLS` (upgrade a plain connection) |
   | Port | defaults to 993 / 143 (IMAP) or 995 / 110 (POP3) until you change it |

   Nothing is dialled until you save the account. The server belongs to that one
   account: the app injects its password only into the endpoint stored beside it,
   so this plugin cannot send your password anywhere it likes. To change any of
   this later, edit the account in **Settings → Plugins → Inbox mail**; the account
   keeps its identity, its baseline and its read progress, and only a switch
   between IMAP and POP3 starts a fresh baseline (the two protocols do not share a
   cursor).
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

The five providers above are the only **preset** endpoints, and they are the only
ones the plugin declares for itself. A server you type is a different mechanism on
purpose: it is stored in that one credential instance, the host validates it
(a bare host, a port in 1..65535, IMAP or POP3, TLS or STARTTLS, never plaintext,
never a cloud-metadata address), and the password is injected into that stored
endpoint and no other. A LAN address is fine — that is where company mail servers
live.

## The Inbox panel

- **Mailboxes** — one card per account: the address, a small state dot (the word
  and, for a failure, the reason in one muted line and in the tooltip), and the
  number of accounts in the column head. **Click a card to filter the list**; the
  **All** entry above the list clears the filter. There is no provider picker, no
  "open web mailbox" and no remove button here: accounts are added, edited and
  removed in **Settings → Plugins → Inbox mail**, and the card shows what that
  form produced (`Custom server mail.example.com:993 · IMAP · SSL`, for instance).
  The panel states how many accounts you have and never a ceiling: the slot
  declares no limit (the app keeps its own safety bound of 100).
- **One list** — every account's mail, newest first, grouped into **Important**
  (the same rule as the alerts) and **Other**, with a filter per mailbox. Each row
  shows sender, subject, time, account, unread and star state where the protocol
  reports them.
- **One message** — the reading pane. An HTML message is shown as HTML, on white
  paper, with its own stylesheet; "show plain text" switches to the text
  alternative and back. A text-only message is shown as prose — proportional font,
  wrapped, links listed as buttons — not as a monospace block. Also the attachment
  names and sizes (listed only, never downloaded), and a list of the message's
  links, which open in your real browser rather than inside the panel.
- **Actions** — opening a message marks it read (one IMAP `STORE` of `\Seen` after
  the body arrived, and nothing at all when the message was already read), "mark
  unread" puts it back, and the star is one more click. A POP3 account has no flags
  on the server, so read is a mark this computer keeps (at most 500 of them) and a
  star is not offered; the reading pane says so in one line.

HTML bodies are sanitized with a vendored copy of
[DOMPurify](https://github.com/cure53/DOMPurify) (3.2.7, Apache-2.0 OR MPL-2.0 —
see `view/vendor/`) and rendered in an `<iframe sandbox="">`: no scripts, no
same-origin access, and its own `default-src 'none'` policy. Remote images stay
blocked until you press "show remote images" for that one message, so a tracking
pixel never learns that you opened the mail. The frame is white paper whatever the
app theme is, and the message keeps its own colors: a mail is designed for a white
page, and re-tinting it is how a newsletter becomes unreadable. DOMPurify removes
`<style>` blocks, so the message's stylesheet is taken out of the raw document,
scrubbed of `@import` (and of `expression()`/`javascript:`), and put after the
frame's own rules, where it wins. Nothing is forced onto the message's layout: no
border or padding on `td`/`th`, only a `max-width` on images and tables so a wide
mail cannot push the panel sideways.

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
have already read elsewhere, turn on **Only report unread mail**: the IMAP check
then asks the server for unseen messages only. It does not apply to a POP3
account, because POP3 reports no read state at all.

## How a POP3 mailbox is watched

POP3 cannot push, and a POP3 session locks the mailbox while it lasts, so this
account is polled instead of connected:

- Every five minutes — never sooner than the `LOGIN-DELAY` the server advertises —
  the plugin opens **one short session**: `CAPA` (to read that delay), `STAT`,
  `UIDL`, `TOP n 0` for the header block of each message it has not seen, `QUIT`.
- The first session only records the UIDLs already in the mailbox. Nothing is
  announced for mail that was there before you added the account.
- What it remembers is the **UIDL**, the only name a POP3 server promises to keep
  (at most 500 of them). The message number is looked up again in every session,
  because it changes as soon as anything is deleted.
- Opening a message is another short session: `UIDL`, then `RETR` for that one
  message, keeping at most 1 MiB and draining the rest.
- It **never sends `DELE`** — the command is not implemented at all — so nothing
  is deleted, and `QUIT` commits nothing.
- Read state is a mark this computer keeps, not a flag the server stores: opening a
  POP3 message adds it to that local list (at most 500), "mark unread" removes it,
  and nothing is written back to the mailbox.
- A failure backs off 5 seconds doubling to five minutes, and a batch bigger than
  one session catches up a second later instead of waiting for the interval.

## What it reads, and what it keeps

- While watching, an IMAP account selects the inbox and for new mail reads only
  the envelope and a few headers — `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE
  MESSAGE-ID IMPORTANCE X-PRIORITY X-MSMail-Priority)]`. `PEEK` is the point: the
  other form would mark every message the plugin looks at as read; the one `STORE`
  of `\Seen` happens only after a body you opened has arrived. A POP3 account asks
  for the header block only (`TOP n 0`, or a capped `RETR` when the server has no
  `TOP`).
- When you open a message it fetches that message only, capped at 1 MiB (IMAP:
  `BODY.PEEK[]<0.1048576>`, POP3: `RETR` with the same cap): truncated with a
  notice beyond that, held in memory for the panel and never written to disk.
  Attachments are listed by name and size and are never downloaded.
- It keeps one small file in its own data folder: per account `UIDVALIDITY` and
  the highest UID already handled (IMAP) or the UIDLs already handled (POP3, at
  most 500), the Message-IDs it has already reported (at most 200), the digest
  queue, the last error, and the envelope of the newest 200 messages (sender,
  subject, time, flags). No message text is stored.
- Opening a message marks that one message read, once, and after its body arrived:
  a failed fetch leaves it unread. "Mark unread" and the star are your clicks, each
  sending exactly one `STORE`. It does not send mail, write drafts, delete, move,
  copy or archive
  messages. Its only network destination is the server each account is set to;
  links you open go through the app to your browser.
- Your password never reaches the plugin. The app holds each credential instance
  and performs the login; the plugin gets an already-authenticated connection and
  only learns which accounts exist, their addresses, whether they are filled, and
  — for a server you typed — its host, port, protocol and transport.

If a mailbox cannot connect, one entry appears in the notification centre saying
why, and it is updated in place rather than repeated. That includes the two
failures only a typed server can have: a server that does not offer `STARTTLS`,
and a certificate that does not verify. A mailbox that still needs its provider
gets one entry telling you to pick one in the panel.

## How it waits

Every account is **polled**, never connected: once every three minutes the plugin
opens one short session per account — connect, select the inbox, look for new
headers, log out — and closes it again before moving on. That is also true for an
IMAP server that offers `IDLE`, because the app allows one plugin eight TCP
connections while this one now has no account ceiling: a socket per mailbox would
not fit. Sessions are staggered (account *n* starts 1.5 s after account *n − 1*) and
at most four exist at once, so the plugin stays well inside that ceiling however
many mailboxes you add. Opening a message or changing a star is one more short
session of its own, through the same budget.

When a poll fails, that account waits 5 seconds, then 10, then 20, up to five
minutes, on its own schedule — a broken mailbox never delays another one. A mailbox
whose `UIDVALIDITY` changed starts a fresh baseline instead of replaying itself.
POP3 accounts follow the same rhythm and their server's `LOGIN-DELAY`.

**Check the mailboxes now**, from the command palette, the panel or the link on any
notification, polls every account immediately instead of waiting for the interval.

## Upgrading from 0.1.0

The app turns your single mailbox into the first account of the new slot. On the
first run the plugin moves the old state file under that account, remembers the
provider you had chosen, and then deletes the old file. Re-running is safe. If two
accounts already exist there is no honest way to tell which one the old cursor
belonged to, so the old file is left alone and each account baselines itself.

## What is not here yet

- Folders, search, writing or replying, attachments, delete/move/archive.
- AI triage of what the deterministic rule missed.
- Anything about an account's own settings inside this panel: the host owns that
  form, and from 1.10.0 it offers an edit entry per account (the connection code
  fills in the values, and the authorization code has to be entered again).
- Outlook/Hotmail, which needs XOAUTH2 in the host.

Published in this repository's catalog as `minih.inbox-mail` 0.3.0. It needs
Minih-Agent-Desktop 1.10.0 or newer — the first release with a per-instance mail
endpoint (`userEndpoint` on a credential slot), the POP3 login behind
`net.tcp.connect`, and the `mail` sidebar icon.

`minih.inbox-mail` 0.3.0 is not in the catalog yet: it needs Desktop 1.10.0, and it
will be published here once that release ships.