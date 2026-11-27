# Mail Assistant

Watches your mailboxes — as many as you add — shows them in one **Inbox** panel
in the sidebar, and sends mail from that same panel. Mail arrivals, digests and
account setup or connection errors no longer create notification-centre entries;
mail and account status remain visible in the panel. Existing notification history
is not deleted.

Since 0.6.0 it also hands the agent four tools — search mail, read one message,
reply, and write — so a conversation, or an automation you set up in the app, can
work through the mailbox for you. The plugin itself still calls no model: those
tools are the only way mail leaves this computer for one, and
[what each of them does](#reading-mail-from-the-agent) is written down below.

Since 0.5.0 the panel writes as well as reads: **write**, **reply**, **reply to
all** and **forward**, with attachments picked from your disk, delivered by the app
itself — it logs in with the account's own password, which this plugin never sees.
Every message you send is filed in the mailbox's Sent folder, and every attachment
you open can be saved wherever the save dialog points.

A mailbox is either one of the providers listed below or **a mail server you type
in yourself** — IMAP or POP3, implicit TLS or STARTTLS — which is what makes a
company mailbox usable. A POP3 mailbox is polled and has no read or star state;
everything else works the same for both.

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
   want; the same dialog also works in Settings → Plugins → Mail Assistant.
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
   this later, edit the account in **Settings → Plugins → Mail Assistant**; the account
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

## How a message leaves

Sending is performed by the app, not by this plugin: `pi.mail.send` names the
account, the envelope and the finished message, and the host dials, logs in with
that account's password and delivers. The plugin never holds the password, the
socket or the server's own words — only the outcome, as a code.

Where a message leaves from is the account's decision, and it is shown in the
account form:

- **a provider this plugin names** is reached at its published submission
  endpoint, which is the one entry in `manifest.net.tcp` for that host. The ports
  and transports below come from each provider's own documentation, and the same
  page is the source for the IMAP row above:

  | Provider | SMTP submission | TLS | Source |
  | --- | --- | --- | --- |
  | QQ Mail | `smtp.qq.com:465` | implicit TLS | [help.mail.qq.com](https://help.mail.qq.com/detail/108/1090/) |
  | NetEase 163 | `smtp.163.com:465` | implicit TLS | [help.mail.163.com](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac22b85ac2e7c90cd63) |
  | NetEase 126 | `smtp.126.com:465` | implicit TLS | [help.mail.163.com](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac22b85ac2e7c90cd63) |
  | Gmail | `smtp.gmail.com:465` | implicit TLS | [developers.google.com](https://developers.google.com/gmail/imap/imap-smtp) |
  | Tencent Exmail | `smtp.exmail.qq.com:465` | implicit TLS | [open.work.weixin.qq.com](https://open.work.weixin.qq.com/help2/pc/19886) |
  | Outlook / Hotmail | `smtp.office365.com:587` | STARTTLS | [support.microsoft.com](https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040) |

  A `587` entry is a STARTTLS entry: the host requires the upgrade to succeed
  before it sends the credential, so a declared submission endpoint is never used
  in the clear.
- **a mailbox whose server you typed** sends only through the outgoing server you
  typed in that same account (`Send server`, `Port`, `Encryption` in the host's
  form). One that has an incoming server but no outgoing one cannot send at all —
  the composer says so and points at the account form. That is deliberate: the
  password belongs to the server you typed, and it is not handed to a server this
  plugin chose.

What the plugin builds is one message the host accepts: the sender is the
account's own address, blind recipients travel in the SMTP envelope and never as a
`Bcc:` header, the text is quoted-printable, attachments are base64, names that are
not ASCII are encoded as RFC 2231, and the whole message is 7-bit — so a server
without `8BITMIME` can still take it. The host's own limits apply: 50 recipients,
25 MiB per message and 30 messages per hour for this plugin.

After a successful send the plugin appends one copy to the account's Sent mailbox
over IMAP (`LIST` finds `\Sent`, else `Sent`, `Sent Items`, `已发送`, …; then
`APPEND` with `\Seen`). Gmail files its own copy, so Gmail accounts skip this. A
failed copy is reported in one line and does not change the fact that the message
was sent.

## When a mailbox needs a proxy

Some mail servers are simply not reachable from where you are. Gmail's IMAP is the
common case on a mainland-China network: the connection is reset no matter what
the account is set to, and a system-wide TUN proxy is the only other way out.
Each mailbox can now go through its own proxy:

1. Open **Settings → Plugins → Mail Assistant** and add (or edit) the account.
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
  an archive folder), reply / reply to all / forward, HTML/text, and "show remote
  images". Attachments are cards with a type, a name, a size and a **Save** button
  that opens the app's own save dialog for exactly that one file. While a body is on
  its way the pane shows a skeleton rather than a line of text.
- **Keyboard** — <kbd>j</kbd>/<kbd>k</kbd> or the arrow keys move, <kbd>Enter</kbd>
  opens, <kbd>u</kbd> toggles read, <kbd>s</kbd> toggles the star, <kbd>#</kbd> or
  <kbd>Delete</kbd> deletes, <kbd>e</kbd> archives, <kbd>c</kbd> writes a new
  message, <kbd>r</kbd> replies, <kbd>a</kbd> replies to all, <kbd>f</kbd>
  forwards, <kbd>/</kbd> focuses the
  search, <kbd>Esc</kbd> closes the reading pane (or clears the search). None of
  them fire while you are typing in a field, and a modified key belongs to
  the app, not to this panel.
- **Looking at mail** — opening a message marks it read (one IMAP `STORE` of
  `\Seen` after the body arrived, and nothing at all when it was already read),
  "mark unread" puts it back, and the star is one more click. A POP3 account has no
  flags on the server, so read is a mark this computer keeps (at most 500 of them),
  a star is not offered, and the reading pane says so in one line.
- **Writing and answering** — the panel's **Write** button (or <kbd>c</kbd>) opens
  the composer: a from-account picker (only accounts that can send are offered;
  the rest say why), recipient chips for To/Cc/Bcc that accept a pasted list,
  a subject, a plain-text body and files chosen from your disk. Reply, reply-all
  and forward open it pre-filled from the message you are reading — the
  recipients, a `Re:`/`Fwd:` subject that is never doubled, the original quoted
  with `>` under an attribution line, and, for a forward, the original's
  attachments as a list you tick. The running total is shown, and anything above
  25 MiB is refused before the send. While sending, the buttons are disabled; a
  refusal keeps every field as it was and names the reason; discarding a
  half-written message asks first.
- **Saving an attachment** — each attachment card has **Save**, which asks the
  plugin for that one part and hands it to the app's save dialog. Nothing is
  written anywhere else, a file above 50 MiB is refused instead of truncated, and
  a cancelled dialog changes nothing.
- **Deleting and archiving** — see [What it changes](#what-it-changes) below. Both
  act on one message, after your click, and nothing here can empty a mailbox.

HTML bodies are sanitized with a vendored copy of
[DOMPurify](https://github.com/cure53/DOMPurify) (3.2.7, Apache-2.0 OR MPL-2.0 —
see `view/vendor/`) and rendered in an `<iframe sandbox="allow-same-origin">`.
Same-origin is what lets the panel read that document and answer a click inside it;
`allow-scripts` is never set, so nothing in a message runs — and the frame also
carries its own `default-src 'none'` policy, so nothing remote loads either. Remote
images stay blocked until you press "show remote images" for that one message, so a
tracking pixel never learns that you opened the mail.

**A link works where it is written.** Pressing one inside the body opens the address
in your browser, through the host (`inbox.openExternal`); a `mailto:` opens this
panel's composer with the recipient, subject and body the link named. Only an address
this panel acts on keeps its `href` — `http`, `https`, `mailto` — and every other one
is removed before the frame is built, with `target` dropped and
`rel="noreferrer noopener"` added. Hovering a link shows the real address in a status
line at the bottom of the pane, and says so when the link's own words name a different
site than the one it opens. There is no separate list of links under the body; a
plain-text message keeps its links as buttons in the text.

**Only a link takes over the keyboard and the mouse.** A click, a middle click or
<kbd>Enter</kbd> on a focused link is answered by the panel; everything else in a
message belongs to the browser, so text selected in the body can be copied with
⌘C/Ctrl+C, <kbd>Space</kbd> still scrolls, the arrow keys still move the caret, and a
`<details>` opens with Enter. A plain character typed while the body has focus is
handed to the panel's own shortcuts (j/k, r/a/f, c, /), so the keyboard keeps working
inside the message. An image map (`<area href>`) is treated as a link; its address is
held to the same rule.

The body's frame is as tall as the message (`scrollHeight`, re-measured by a
`ResizeObserver` and when an image loads), so the reading pane scrolls as one page —
subject, actions, body, attachments — and a mail wider than the pane scrolls sideways
inside the frame instead of pushing the panel. The frame is white paper whatever the
app theme is, and the message keeps its own colors: a mail is designed for a white
page, and re-tinting it is how a newsletter becomes unreadable. DOMPurify removes
`<style>` blocks, so the message's stylesheet is taken out of the raw document,
scrubbed of `@import` (and of `expression()`/`javascript:`), and put after the
frame's own rules, where it wins. Nothing is forced onto the message's layout: no
border or padding on `td`/`th`, only a `max-width` on images and tables so a wide
mail cannot push the panel sideways.

## Reading mail from the agent

Four tools, registered with `pi.agent.registerTool` and declared in the manifest so
that the install review shows exactly what they are:

| Tool | Risk | What it does |
| --- | --- | --- |
| `mail_list_messages` | `low` | Search every mailbox, or one: sender, subject, `since`/`before` day (the caller's own calendar day), unread, starred, `limit` 1–50 and `offset` for paging. Envelopes only — sender, subject, date, one-line summary, attachment flag. |
| `mail_read_message` | `low` | One message's text: the same 1 MiB `BODY.PEEK` fetch that opening it in the panel uses, cut to 20,000 characters. Never marks it read. |
| `mail_reply_message` | `high` | A threaded reply that quotes the original, sent through the app's SMTP session and filed in Sent. |
| `mail_send_message` | `high` | A new message from one account, with the same sender lock and Sent copy. |

**Why the reads are `low` risk.** Desktop answers a low-risk call with `AllowOnce`
and no card (`crates/host-core/src/permissions.rs`), and that is the only risk level
that can run in an app automation, where nobody is there to press a button. It is
also a promise the tools keep: a read changes nothing. Neither one sends
`STORE \Seen`, writes the plugin's data file, or keeps a body after the answer.
Opening a message in the panel still marks it read; asking the agent to read it does
not. The two tools that send are `high` risk on purpose — the host puts a card in
front of every call.

**Where the search actually runs.** The plugin's own envelope store holds the newest
200 messages per account, which is what the panel shows. A call that names a date
range, or whose local matches are fewer than the page it asked for, also asks an IMAP
server with one bounded `UID SEARCH` (`FROM`, `SUBJECT`, `SINCE`, `BEFORE`, `UNSEEN`,
`FLAGGED`) and fetches at most the newest 50 envelopes. That is what makes "last
month's invoices" an answer from the mailbox instead of from a three-day cache. A
POP3 mailbox has no search at all, and its answer says so and covers only what is
stored here.

**What reaches the model.** Whatever a tool returns becomes part of that
conversation, so it goes to the model provider the session is configured with —
envelopes, or one message's text, exactly as if you had pasted it yourself. Nothing
is sent on a timer, on arrival or from a rule: the plugin answers only when a session
calls a tool. Every answer that carries mail opens with `untrusted: true` and a
sentence saying the text is data and not instructions, and the tool descriptions say
the same, so a message cannot talk the agent into mailing something out.

**A word that is not ASCII.** A `SUBJECT "发票"` is not a legal IMAP search key — a
quoted string is 7-bit — so a Chinese keyword travels as a literal under an explicit
`CHARSET UTF-8`, which is the form the grammar has for it. A server that still
refuses (`NO [BADCHARSET]`) leaves the stored answer in place and says so in the
answer's own note, instead of pretending the mailbox was searched.

**A scheduled run can only read.** This plugin schedules nothing; the app's own
scheduled task does the timing, and such a run has nobody to approve anything. The
two `low`-risk reads answer it — that is the whole reason they are `low` — while
`mail_reply_message` and `mail_send_message` do not: a `high`-risk call puts a card
in front of the user and waits, so a run with no user stops at that call instead of
sending. Write a scheduled prompt that reads and summarizes. The same rule is why
the read tools do not ask either when you are in the conversation: a low-risk call
is answered without a card, in both cases.

## How importance is decided

The importance rule calls no model, so it is short enough to predict:

| Situation | Result |
| --- | --- |
| the sender is on your **important senders** list | important in the panel |
| the subject or the sender's name contains one of your **keywords** | important in the panel |
| the message carries `Importance: high`, `X-Priority: 1` or `X-MSMail-Priority: High` | important in the panel |
| anything else | ordinary in the panel |

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
  Attachments are listed by name and size; one is fetched only when you press
  **Save** on it — IMAP asks for that one MIME part
  (`UID FETCH <uid> BODY.PEEK[<part>]`, which never sets `\Seen`), POP3 fetches the
  message it already has to, and the bytes go straight from memory into the app's
  save dialog. A file above 50 MiB is refused rather than truncated.
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
  sending exactly one `STORE`. Sending happens only when you press **Send**, and
  the only places it goes are the submission server the account names and — after a
  successful send — the account's own Sent folder, over the same IMAP server it
  already reads. Links you open go through the app to your browser.
- Your password never reaches the plugin. The app holds each credential instance
  and performs the login; the plugin gets an already-authenticated connection and
  only learns which accounts exist, their addresses, whether they are filled, and
  — for a server you typed — its host, port, protocol and transport.

If a mailbox cannot connect, its account row in the Inbox panel explains why.
No notification-centre entry is created, including for missing credentials,
providers, TLS/STARTTLS failures or proxy errors.

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

**Check now** in the palette or panel polls the accounts immediately instead of
waiting for the interval. It does not publish notifications.

## Upgrading from 0.1.0

The app turns your single mailbox into the first account of the new slot. On the
first run the plugin moves the old state file under that account, remembers the
provider you had chosen, and then deletes the old file. Re-running is safe. If two
accounts already exist there is no honest way to tell which one the old cursor
belonged to, so the old file is left alone and each account baselines itself.

## What it changes

Opening a message marks it read after its body arrives. Other changes require
your explicit action, including **Mark all as read**, sending, saving attachments
and delete/archive. Delete
and archive act on the one message you clicked, and this plugin never sends a
mailbox-wide `EXPUNGE` — the command that would also remove messages other clients
flagged for deletion.

**Mark all as read** applies to the selected account, or all accounts when
**All inboxes** is selected. Search, filters and the 200-envelope display limit do
not narrow it. IMAP searches the entire inbox for unseen UIDs, then adds `\Seen`
in batches of at most 100; other flags are preserved, bodies are not fetched, and
mail arriving after the search is not included. POP3 marks only the messages
already collected on this computer, without a server change. The button is locked
while running. Successful accounts are saved even if another account fails; the
panel names failed accounts and their reasons. A changed UIDVALIDITY refuses the
action instead of marking renumbered messages.

| Action | IMAP | POP3 |
| --- | --- | --- |
| Send | `mail.send` through the host: the provider's submission endpoint, or the one you typed. Afterwards one `APPEND` of the same bytes into Sent with `\Seen`. | Same send; no Sent copy (POP3 has no folders). |
| Save an attachment | `UID FETCH <uid> (UID BODYSTRUCTURE)` to locate the part, then `UID FETCH <uid> BODY.PEEK[<part>]` — never a non-peek fetch, so nothing is marked read. | `RETR` of that one message (capped at 50 MiB), then the part is taken out of it. |
| Delete | `LIST` finds the trash (special-use `\Trash`, else a name such as `Trash`, `Deleted Messages`, `已删除`), then one `UID MOVE <uid> Trash`. Without `MOVE`: `UID COPY <uid> Trash`, `UID STORE <uid> +FLAGS (\Deleted)`, `UID EXPUNGE <uid>`. | `DELE <n>` for that message, then `QUIT` to commit it. |
| Archive | The same three commands into a special-use `\Archive` mailbox (or Gmail's All Mail), and only when `LIST` found one. | Not offered: POP3 has no folders. |

An attachment is named by its **section number** everywhere — in the reading pane's
list, in a save request (`inbox.saveAttachment` takes `{ part, filename }`) and in
a forwarded message. A row number is not a name: an inline `cid:` image or an
unnamed part makes the pane's list and the server's `BODYSTRUCTURE` count
differently, and a row that means two things saves or forwards a file the user did
not click. The number is checked against the server's structure, and a part whose
name disagrees with the one the pane showed is refused (`ATTACHMENT_MISMATCH`)
rather than written under the wrong name.

A server with neither `MOVE` nor `UIDPLUS`, or a mailbox with no trash, is refused
with a message saying so and the mail stays where it is. On IMAP the message ends
up in the trash and the panel says "moved to the trash"; on POP3 the delete is
final, which is why the panel asks first and then says it cannot be undone.
Archiving is only offered for an account whose mailbox list actually has an
archive.

## What is not here yet

- A rich-text composer: the body is plain text, and a reply quotes the original as
  text (an HTML-only message is converted for the quote). Signatures, drafts saved
  between launches, and scheduled send are not implemented either.
- AI triage built into the notifier itself: the rule that decides alert versus
  digest stays deterministic, and mail reaches a model only when a session calls one
  of the tools below.
- Anything about an account's own settings inside this panel: the host owns that
  form, and from 1.10.0 it offers an edit entry per account (the connection code
  fills in the values, and the authorization code has to be entered again).
- Outlook/Hotmail, which needs XOAUTH2 in the host.

`minih.inbox-mail` 0.6.0 needs Minih-Agent-Desktop 1.11.0 or newer — the first
release with a per-instance mail endpoint (`userEndpoint` on a credential slot), the
POP3 login behind `net.tcp.connect`, the `mail` sidebar icon, and a per-account
proxy (`userProxy`). Sending needs the `mail.send` grant (the host dials, logs in and
delivers) and `userSend` on the slot for an account with its own outgoing server;
saving an attachment needs `fs.saveAs`, which writes the one path the user picks.
The agent tools need `agent.tool.register`; agent tools predate 1.5.0, so they do not
raise the app floor. The catalog in this repository still points at 0.5.1: publishing
0.6.0 is a separate step that builds `packages/minih.inbox-mail-0.6.0.piplug` and
regenerates `catalog.json` and the release history.
