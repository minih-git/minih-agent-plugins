import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const messages = require("../lib/messages.js");

/**
 * What a row may say.
 *
 * The rule that matters is negative: a notification carries the sender, the
 * subject and the time, and nothing that was inside the message. These cases make
 * that explicit, plus the host's own length ceilings.
 */

const zh = messages.messages("zh-CN");
const en = messages.messages("en");

test("both contract locales are complete, with the same keys", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(zh.reasons).sort(), Object.keys(en.reasons).sort());
  for (const value of Object.values(en)) {
    if (typeof value === "string") assert.ok(value.length > 0);
  }
});

test("an alert body names the sender and the time, never the message text", () => {
  const body = messages.alertBody(
    { from: { name: "Boss", address: "boss@example.com" }, receivedAt: Date.UTC(2026, 10, 14, 2, 0) },
    en,
    "en",
  );
  assert.match(body, /^Boss · /);
  assert.equal(body.includes("body"), false);
});

test("a message without a sender name falls back to the address, then to a placeholder", () => {
  assert.match(messages.alertBody({ from: { address: "a@b.c" } }, en, "en"), /^a@b\.c$/);
  assert.equal(messages.alertBody({}, en, "en"), en.unknownSender);
  assert.equal(messages.alertBody({}, zh, "zh-CN"), zh.unknownSender);
});

test("a digest lists sender and subject lines, and summarises the overflow", () => {
  const entries = Array.from({ length: 11 }, (_, index) => ({
    from: { address: `sender${index}@example.com` },
    subject: `Subject ${index}`,
  }));
  const body = messages.digestBody(entries, en);
  const lines = body.split("\n");
  assert.equal(lines.length, messages.DIGEST_LINES + 1);
  assert.equal(lines[lines.length - 1], en.digestMore(3));
  assert.match(lines[0], /sender0@example\.com · Subject 0/);
});

test("a missing subject is named, not left blank", () => {
  assert.match(messages.digestBody([{ from: { address: "a@b" }, subject: "" }], en), /\(no subject\)/);
});

test("titles and bodies are cut to the host's limits", () => {
  const long = "x".repeat(500);
  assert.equal([...messages.clamp(long, messages.MAX_TITLE)].length, messages.MAX_TITLE);
  assert.equal(messages.MAX_TITLE, 200);
  assert.equal(messages.MAX_BODY, 2000);
  const many = Array.from({ length: 60 }, () => ({ from: { address: "a@b" }, subject: "y".repeat(80) }));
  assert.ok([...messages.digestBody(many, en)].length <= messages.MAX_BODY);
  // Collapsing whitespace keeps a multi-line subject from faking structure.
  assert.equal(messages.clamp("a\n\n  b", 20), "a b");
});

test("the setup reason names the actual failure", () => {
  assert.match(messages.setupReason("CREDENTIAL_NOT_CONFIGURED", en), /credential/);
  assert.match(messages.setupReason("CREDENTIAL_REJECTED", en), /refused/);
  assert.match(messages.setupReason("PROVIDER_NEEDS_OAUTH", en), /OAuth2/);
  assert.match(messages.setupReason("UNSUPPORTED", en), /capabilities/);
  assert.match(messages.setupReason("WHATEVER", en), /automatic/);
  assert.match(messages.setupReason("CREDENTIAL_NOT_CONFIGURED", zh), /凭据/);
});

test("the command's toast says what happened, in the user's language", () => {
  assert.equal(messages.checkedToast({ checked: true, handled: 0 }, en), en.checkedEmpty);
  assert.equal(messages.checkedToast({ checked: true, handled: 2 }, en), en.checkedWithMail(2));
  assert.equal(messages.checkedToast({ checked: false, watched: true }, en), en.checking);
  assert.equal(messages.checkedToast({ checked: false, watched: false }, en), en.notConnected);
  assert.equal(messages.checkedToast({ checked: true, handled: 1 }, zh), "已检查：新邮件 1 封");
});
