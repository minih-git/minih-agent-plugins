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

const list = (...entries) =>
  entries.map(([name, flags = [], delimiter = "/"]) => ({ name, flags, delimiter }));

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

test("an account with nothing to offer says so twice", () => {
  const folders = mailboxes.resolveFolders(list(["INBOX"], ["Sent"]));
  assert.deepEqual(folders, { trash: null, archive: null, specialUse: false });
  assert.deepEqual(mailboxes.resolveFolders([]), { trash: null, archive: null, specialUse: false });
  assert.deepEqual(mailboxes.resolveFolders(null), { trash: null, archive: null, specialUse: false });
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