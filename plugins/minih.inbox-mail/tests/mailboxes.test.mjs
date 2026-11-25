import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const mailboxes = require("../lib/mailboxes.js");

/**
 * Which mailbox is the trash, and which is the archive.
 *
 * Delete and archive are the first features in this plugin that move mail, so the
 * guess they depend on has to be the conservative one: a declared `\Trash` wins, a
 * known name is the fallback, a `\Noselect` mailbox is never a destination, and an
 * account whose list cannot name either gets `null` — which the panel turns into a
 * button that is not there rather than an operation that fails halfway.
 */

/**
 * One scripted `LIST` entry.
 *
 * `label` is what the protocol layer decoded from the raw name (modified UTF-7),
 * which is what matching uses; `name` is what a command has to send.
 */
const list = (...entries) =>
  entries.map(([name, flags = [], delimiter = "/", label = name]) => ({ name, label, flags, delimiter }));

test("the special-use flags win over every name", () => {
  const folders = mailboxes.resolveFolders(
    list(["INBOX"], ["Junk", ["\\Junk"]], ["Wastebasket", ["\\Trash"]], ["Archive 2026", ["\\Archive"]]),
  );
  assert.equal(folders.trash, "Wastebasket");
  assert.equal(folders.archive, "Archive 2026");
  assert.equal(folders.specialUse, true);
});

test("a server without special-use is matched by the names its web UI shows", () => {
  const deleted = mailboxes.resolveFolders(list(["INBOX"], ["Deleted Messages"], ["Sent"]));
  assert.equal(deleted.trash, "Deleted Messages");
  assert.equal(deleted.archive, null, "no archive folder is a null, not a guess");

  const chinese = mailboxes.resolveFolders(list(["INBOX"], ["已删除"], ["已发送"]));
  assert.equal(chinese.trash, "已删除");
});

test("Gmail's All Mail is the archive, and its nested path is still a leaf name", () => {
  const folders = mailboxes.resolveFolders(list(["INBOX"], ["[Gmail]/All Mail"], ["[Gmail]/Trash"], ["[Gmail]/Sent Mail"]));
  assert.equal(folders.archive, "[Gmail]/All Mail");
  assert.equal(folders.trash, "[Gmail]/Trash");
});

test("a mailbox that cannot hold a message is never a destination", () => {
  const folders = mailboxes.resolveFolders(list(["INBOX"], ["Trash", ["\\Noselect"]], ["Archive", ["\\NonExistent"]]));
  assert.equal(folders.trash, null);
  assert.equal(folders.archive, null);
});

test("a name that only resembles the trash is not the trash", () => {
  const folders = mailboxes.resolveFolders(list(["INBOX"], ["Trash/2024"], ["Saved Trash"], ["Archiver"]));
  assert.equal(folders.trash, null, "a nested or prefixed name is a different mailbox");
  assert.equal(folders.archive, null);
});

test("the shallowest match wins, so a folder called Trash inside another is not it", () => {
  const folders = mailboxes.resolveFolders(list(["INBOX"], ["Projects/Trash"], ["Trash"]));
  assert.equal(folders.trash, "Trash");
});

test("an account with nothing to offer names no destination at all", () => {
  // A mailbox called `Sent` is not a trash, an archive or a copy target of itself:
  // `sent` answers where a *copy* of an outgoing message goes, and a mailbox with
  // none of the three leaves every destination null.
  const folders = mailboxes.resolveFolders(list(["INBOX"], ["Projects"]));
  assert.deepEqual(folders, { trash: null, archive: null, sent: null, specialUse: false });
  assert.deepEqual(mailboxes.resolveFolders([]), { trash: null, archive: null, sent: null, specialUse: false });
  assert.deepEqual(mailboxes.resolveFolders(null), { trash: null, archive: null, sent: null, specialUse: false });
});

test("the sent copy goes to the special-use Sent mailbox, then to its usual names", () => {
  const declared = mailboxes.resolveFolders(list(["INBOX"], ["Sent", ["\\Sent"], ["Sent Items"]]));
  assert.equal(declared.sent, "Sent");
  assert.equal(declared.specialUse, true);
  // A server that declares nothing falls back to the name table, in its order.
  const byName = mailboxes.resolveFolders(list(["INBOX"], ["Sent Items"], ["Sent"]));
  assert.equal(byName.sent, "Sent");
  // The Chinese and Taiwanese spellings providers actually use.
  assert.equal(mailboxes.resolveFolders(list(["INBOX"], ["已发送"])).sent, "已发送");
  assert.equal(mailboxes.resolveFolders(list(["INBOX"], ["寄件備份"])).sent, "寄件備份");
  // Gmail's All Mail is an archive, not a copy target: only `[Gmail]/Sent Mail` is.
  assert.equal(mailboxes.resolveFolders(list(["INBOX"], ["[Gmail]/All Mail"])).sent, null);
  assert.equal(mailboxes.resolveFolders(list(["INBOX"], ["[Gmail]/Sent Mail"])).sent, "[Gmail]/Sent Mail");
  // A junk folder that also claims `\Sent` is still never a destination.
  assert.equal(mailboxes.resolveFolders(list(["INBOX"], ["垃圾邮件", ["\\Sent", "\\Junk"]])).sent, null);
});

test("the cache is keyed by the connection it was learned from", () => {
  const cache = mailboxes.createFolderCache();
  assert.equal(cache.needs("acc_1", "preset:qq"), true);
  assert.equal(cache.get("acc_1", "preset:qq"), null);

  const folders = { trash: "Trash", archive: null, specialUse: false };
  cache.set("acc_1", "preset:qq", folders);
  assert.deepEqual(cache.get("acc_1", "preset:qq"), folders);
  assert.equal(cache.needs("acc_1", "preset:qq"), false);

  // An edited account is a different mailbox list: the old answer must not apply.
  assert.equal(cache.needs("acc_1", "mail.example.com:993"), true);
  assert.equal(cache.get("acc_1", "mail.example.com:993"), null);

  cache.forget("acc_1");
  assert.equal(cache.needs("acc_1", "preset:qq"), true);
});

test("a Chinese name spelled in modified UTF-7 is matched, and the raw name is what a move sends", () => {
  // 163 and 126 answer `LIST` with `&XfJSIJZk-` for 已删除; the decoded label is
  // what a name table can compare against, the raw name is what `UID MOVE` needs.
  const folders = mailboxes.resolveFolders(
    list(["INBOX"], ["&XfJSIJZk-", [], "/", "已删除"], ["&V4NXPpCuTvY-", [], "/", "垃圾邮件"]),
  );
  assert.equal(folders.trash, "&XfJSIJZk-");
});

test("the junk folder is never a delete or archive destination", () => {
  // Named like the trash, flagged as spam, and the only candidate: still no.
  const onlyJunk = mailboxes.resolveFolders(list(["INBOX"], ["垃圾箱", ["\\Junk"], "/", "垃圾箱"]));
  assert.equal(onlyJunk.trash, null);
  assert.equal(onlyJunk.archive, null);

  // `\Spam` is the same folder under another name.
  const spam = mailboxes.resolveFolders(list(["INBOX"], ["Trash", ["\\Spam"]]));
  assert.equal(spam.trash, null);

  // A real trash beside a junk folder is chosen over it, whatever LIST says.
  const both = mailboxes.resolveFolders(
    list(["INBOX"], ["Junk", ["\\Junk"]], ["Deleted Messages"], ["Trash"]),
  );
  assert.equal(both.trash, "Trash", "the name table decides the order, not LIST");
});

test("the name table is the priority order, and LIST order does not matter", () => {
  const straight = mailboxes.resolveFolders(list(["INBOX"], ["Trash"], ["Deleted Messages"]));
  const reversed = mailboxes.resolveFolders(list(["INBOX"], ["Deleted Messages"], ["Trash"]));
  assert.equal(straight.trash, "Trash");
  assert.equal(reversed.trash, "Trash", "Trash is listed first in the table");

  // A name the table does not know is never picked, even if it looks right.
  assert.equal(mailboxes.resolveFolders(list(["INBOX"], ["Bin"], ["Waste basket"])).trash, null);
});

test("a declared special-use flag still wins over every name", () => {
  const folders = mailboxes.resolveFolders(
    list(["INBOX"], ["Trash"], ["Wastebasket", ["\\Trash"]], ["All Mail", ["\\Archive"]]),
  );
  assert.equal(folders.trash, "Wastebasket");
  assert.equal(folders.archive, "All Mail");
});
