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

In the panel you get every account's recent mail in one list — grouped by day,
with a one-line preview of each message, a search box and four filters — and one
message at a time in a reading pane. A message body is downloaded only when you
open that message, and opening it marks it read — one `STORE` of `\Seen` after the
body has actually arrived, never before. The star changes only when you click it,
"mark unread" is always there to undo the read, and delete and archive act on the
one message you picked (see below for exactly what they send).

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

## When a mailbox needs a proxy

Some mail servers are simply not reachable from where you are. Gmail's IMAP is the
common case on a mainland-China network: the connection is reset no matter what
the account is set to, and a system-wide TUN proxy is the only other way out.
Each mailbox can now go through its own proxy:

1. Open **Settings → Plugins → Inbox mail** and add (or edit) the account.
2. Open the **Proxy** section of that form: pick **HTTP** or **SOCKS5**, type the
   host and port, and — only if the proxy asks for them — a username and password.
   For a local Clash or Mihomo, that is `HTTP`, `127.0.0.1`, `7897`.
3. Save. The account is dialled through the proxy from then on; the mail server,
   the port and the encryption stay what you set in the rest of the form.

A few properties are deliberate:

- **The proxy belongs to the account.** It is stored in that credential instance,
  and only a connection carrying that instance can use it — the same rule as a
  custom server. Two accounts can use two different proxies, and one can use none.
- **No fallback.** If the proxy is down or refuses the credentials, the account
  fails; it is never quietly retried direct, which would leak the mail server
  address onto the network that blocks it. The notice names the proxy
  (`无法连接代理 127.0.0.1:7897`) so the fix is obvious, and the account card's
  tooltip says which proxy it goes through.
- **The app performs the handshake.** HTTP `CONNECT` or SOCKS5, then the ordinary
  TLS (or STARTTLS) login to the **mail** server: the certificate is checked
  against the mail host, never the proxy, and the mail password never crosses the
  proxy hop unencrypted. The plugin only learns the proxy type, host and port —
  the proxy username and password stay in the app's credential store.
- **Proxy credentials are not encrypted to the proxy.** That is how HTTP and
  SOCKS5 authentication works; it is fine for a proxy on your own machine or LAN,
  and it is why a proxy username and password have to be re-entered when you edit
  the account (they are stored as secrets and never read back into the form).

## The Inbox panel

- **Mailboxes (left)** — a fixed **All inboxes** row, then one row per account: a
  state dot, the address, and a badge with its unread count. A row filters the
  list; its **⋯** menu offers **Only this mailbox**, **Check this mailbox now**,
  **Open web mailbox** (only for a provider this plugin knows) and **Remove this
  mailbox**, which asks for confirmation in the panel first. A failed mailbox
  explains itself in one folded line, with the account's stored error in the
  tooltip. Below 1100 px the column collapses to a rail of dots and the panel's
  own button hides it entirely.
- **List (middle)** — a search box (press <kbd>/</kbd>, <kbd>Esc</kbd> clears it)
  over sender, subject, preview and account; four filters — **All**, **Unread**,
  **Starred**, **Important**; and mail grouped under **Today / Yesterday / This
  week / Earlier**. Each row shows a colored initials avatar (one colour per
  sender address, in both themes), the sender, a short time (a clock time today, a
  weekday this week, a date this year, a full date before that), the subject, one
  line of the message's own text, and small tags for a star and an attachment.
  Hovering a row — or reaching it from the keyboard — reveals its quick actions:
  read/unread, star, delete. With one mailbox selected, **Load older mail** at the
  bottom walks further back (50 at a time, up to the 200-message list limit).
- **Reading pane (right)** — the subject, the sender's avatar, name and address,
  the full timestamp, the account, and a folded **to me / to me and N more** line
  that expands into the To and Cc lists. The toolbar is icon buttons with tooltips
  and `aria-label`s: read/unread, star, delete, archive (only when the mailbox has
  an archive folder), HTML/text, and "show remote images". Attachments are cards
  with a type, a name and a size — listed, not downloaded. While a body is on its
  way the pane shows a skeleton rather than a line of text.
- **Keyboard** — <kbd>j</kbd>/<kbd>k</kbd> or the arrow keys move, <kbd>Enter</kbd>
  opens, <kbd>u</kbd> toggles read, <kbd>s</kbd> toggles the star, <kbd>#</kbd> or
  <kbd>Delete</kbd> deletes, <kbd>e</kbd> archives, <kbd>/</kbd> focuses the
  search, <kbd>Esc</kbd> closes the reading pane (or clears the search). None of
  them fire while you are typing in the search box, and a modified key belongs to
  the app, not to this panel.
- **Looking at mail** — opening a message marks it read (one IMAP `STORE` of
  `\Seen` after the body arrived, and nothing at all when it was already read),
  "mark unread" puts it back, and the star is one more click. A POP3 account has no
  flags on the server, so read is a mark this computer keeps (at most 500 of them),
  a star is not offered, and the reading pane says so in one line.
- **Deleting and archiving** — see [What it changes](#what-it-changes) below. Both
  act on one message, after your click, and nothing here can empty a mailbox.

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
- It sends **`DELE` only when you delete that message**, and then `QUIT` to
  commit it — POP3 has no trash, so the panel asks before the pair is sent. A poll
  never sends `DELE`, so a `QUIT` from watching commits nothing.
- Read state is a mark this computer keeps, not a flag the server stores: opening a
  POP3 message adds it to that local list (at most 500), "mark unread" removes it,
  and nothing is written back to the mailbox.
- A failure backs off 5 seconds doubling to five minutes, and a batch bigger than
  one session catches up a second later instead of waiting for the interval.

## What it reads, and what it keeps

- While watching, an IMAP account selects the inbox and for new mail reads the
  envelope, a few headers — `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE
  MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING IMPORTANCE X-PRIORITY
  X-MSMail-Priority)]` — its `BODYSTRUCTURE` (only to know whether it has an
  attachment) and the first 4 KiB of the text, all in one `FETCH`. `PEEK` is the
  point: the other form would mark every message the plugin looks at as read; the
  one `STORE` of `\Seen` happens only after a body you opened has arrived. A POP3
  account asks for the headers plus twelve body lines (`TOP n 12`, or a capped
  `RETR` when the server has no `TOP`).
- When you open a message it fetches that message only, capped at 1 MiB (IMAP:
  `BODY.PEEK[]<0.1048576>`, POP3: `RETR` with the same cap): truncated with a
  notice beyond that, held in memory for the panel and never written to disk.
  Attachments are listed by name and size and are never downloaded.
- It keeps one small file in its own data folder: per account `UIDVALIDITY` and
  the highest UID already handled (IMAP) or the UIDLs already handled (POP3, at
  most 500), the Message-IDs it has already reported (at most 200), the digest
  queue, the last error, and the envelope of the newest 200 messages (sender,
  subject, up to 20 To and 20 Cc addresses, time, flags, whether it has an
  attachment, and **at most 140 characters of plain-text summary** taken from
  those first bytes). The message body itself is still never written to disk, and
  the file is replaced atomically so a crash cannot leave half a JSON document
  behind.
- Opening a message marks that one message read, once, and after its body arrived:
  a failed fetch leaves it unread. "Mark unread" and the star are your clicks, each
  sending exactly one `STORE`. It does not send mail and writes no drafts. Its only
  network destination is the server each account is set to; links you open go
  through the app to your browser.
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

Clicking a notification — an alert, a digest, or the row that says an account
cannot connect — opens the **Inbox** panel, where the message or the broken account
is. It does not run a check: that is what **Check now** in the palette (and the
button in the panel) is for, and both poll every account immediately instead of
waiting for the interval.

## Upgrading from 0.1.0

The app turns your single mailbox into the first account of the new slot. On the
first run the plugin moves the old state file under that account, remembers the
provider you had chosen, and then deletes the old file. Re-running is safe. If two
accounts already exist there is no honest way to tell which one the old cursor
belonged to, so the old file is left alone and each account baselines itself.

## What it changes

Nothing, until you ask for it. Delete and archive are the only operations that
move or remove mail, they act on the one message you clicked, and this plugin never
sends a mailbox-wide `EXPUNGE` — the command that would also remove messages other
clients flagged for deletion.

| Action | IMAP | POP3 |
| --- | --- | --- |
| Delete | `LIST` finds the trash (special-use `\Trash`, else a name such as `Trash`, `Deleted Messages`, `已删除`), then one `UID MOVE <uid> Trash`. Without `MOVE`: `UID COPY <uid> Trash`, `UID STORE <uid> +FLAGS (\Deleted)`, `UID EXPUNGE <uid>`. | `DELE <n>` for that message, then `QUIT` to commit it. |
| Archive | The same three commands into a special-use `\Archive` mailbox (or Gmail's All Mail), and only when `LIST` found one. | Not offered: POP3 has no folders. |

A server with neither `MOVE` nor `UIDPLUS`, or a mailbox with no trash, is refused
with a message saying so and the mail stays where it is. On IMAP the message ends
up in the trash and the panel says "moved to the trash"; on POP3 the delete is
final, which is why the panel asks first and then says it cannot be undone.
Archiving is only offered for an account whose mailbox list actually has an
archive.

## What is not here yet

- Writing, replying and forwarding (they need the host to send mail), and
  downloading or saving an attachment (it needs the host to write a binary file).
- AI triage of what the deterministic rule missed.
- Anything about an account's own settings inside this panel: the host owns that
  form, and from 1.10.0 it offers an edit entry per account (the connection code
  fills in the values, and the authorization code has to be entered again).
- Outlook/Hotmail, which needs XOAUTH2 in the host.

`minih.inbox-mail` 0.4.0 needs Minih-Agent-Desktop 1.11.0 or newer — the first
release with a per-instance mail endpoint (`userEndpoint` on a credential slot),
the POP3 login behind `net.tcp.connect`, the `mail` sidebar icon, and a per-account
proxy (`userProxy`). The catalog in this repository still points at 0.3.0:
publishing 0.4.0 is a separate step that updates `catalog.json` and the release
history.
