import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const providers = require("../lib/providers.js");

/**
 * Which service an account belongs to.
 *
 * The inference is deliberately narrow: a wrong guess sends the user's password
 * to a server that will refuse it, which reads as "your code is wrong". Only the
 * domains the brief names are inferred, and everything else waits for the panel.
 */

test("the four first-party domains map to their provider", () => {
  assert.equal(providers.inferProviderId("someone@qq.com"), "qq");
  assert.equal(providers.inferProviderId("someone@foxmail.com"), "qq");
  assert.equal(providers.inferProviderId("someone@163.com"), "netease163");
  assert.equal(providers.inferProviderId("someone@126.com"), "netease126");
  assert.equal(providers.inferProviderId("someone@gmail.com"), "gmail");
  assert.equal(providers.inferProviderId("someone@googlemail.com"), "gmail");
});

test("the domain is matched case-insensitively, and whitespace is ignored", () => {
  assert.equal(providers.inferProviderId("  Someone@QQ.COM "), "qq");
});

test("a company domain is not guessed", () => {
  assert.equal(providers.inferProviderId("ceo@example.com"), null);
  assert.equal(providers.inferProviderId("not-an-address"), null);
  assert.equal(providers.inferProviderId(""), null);
  assert.equal(providers.inferProviderId(undefined), null);
});

test("the panel's catalogue carries both languages and the availability flag", () => {
  const zh = providers.catalogue("zh-CN");
  const en = providers.catalogue("en");
  assert.equal(zh.length, en.length);
  const outlook = zh.find((entry) => entry.id === "outlook");
  assert.equal(outlook.available, false, "Outlook needs OAuth2 and is offered as unavailable");
  assert.match(outlook.title, /暂不支持/);
  assert.equal(en.find((entry) => entry.id === "qq").title, "QQ Mail");
  assert.equal(zh.find((entry) => entry.id === "qq").title, "QQ 邮箱");
  for (const entry of zh) {
    assert.ok(entry.webmail.startsWith("https://"), `${entry.id} has no web mailbox`);
    assert.equal(entry.available, providers.findProvider(entry.id).auth === "password");
  }
});

test("an unknown provider id resolves to nothing, not to a default server", () => {
  assert.equal(providers.providerFor("nope"), null);
  assert.equal(providers.providerFor(undefined), null);
  assert.equal(providers.providerFor("gmail").host, "imap.gmail.com");
});
