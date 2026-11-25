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

test("a custom endpoint is read from the four non-secret fields, or not at all", () => {
  assert.deepEqual(
    providers.customEndpointOf({ server: "mail.example.com", port: "993", protocol: "imap", security: "tls" }),
    { id: "custom", host: "mail.example.com", port: 993, protocol: "imap", security: "tls" },
  );
  // Empty server is the preset path, which is the normal case.
  assert.equal(providers.customEndpointOf({ server: "", port: "993", protocol: "imap", security: "tls" }), null);
  assert.equal(providers.customEndpointOf({}), null);
  assert.equal(providers.customEndpointOf(undefined), null);
  // Anything the host would have refused is not turned into a guess: a wrong
  // endpoint is worse than no endpoint, because it is where a password would go.
  const bad = [
    { server: "https://mail.example.com", port: "993", protocol: "imap", security: "tls" },
    { server: "mail.example.com:993", port: "993", protocol: "imap", security: "tls" },
    { server: "mail example.com", port: "993", protocol: "imap", security: "tls" },
    { server: "mail.example.com", port: "0", protocol: "imap", security: "tls" },
    { server: "mail.example.com", port: "70000", protocol: "imap", security: "tls" },
    { server: "mail.example.com", port: "993", protocol: "smtp", security: "tls" },
    { server: "mail.example.com", port: "993", protocol: "imap", security: "plain" },
  ];
  for (const fields of bad) {
    assert.equal(providers.customEndpointOf(fields), null, JSON.stringify(fields));
  }
  // A LAN address is a company server, which is the whole point of the feature.
  assert.equal(
    providers.customEndpointOf({ server: "10.0.0.5", port: "143", protocol: "imap", security: "starttls" }).port,
    143,
  );
});

test("a custom account is labelled with its host, port, protocol and transport", () => {
  const endpoint = providers.customEndpointOf({
    server: "mail.example.com",
    port: "995",
    protocol: "pop3",
    security: "tls",
  });
  assert.equal(providers.customTitle(endpoint, "zh-CN"), "自定义服务器 mail.example.com:995 · POP3 · SSL");
  assert.equal(providers.customTitle(endpoint, "en"), "Custom server mail.example.com:995 · POP3 · SSL");
  const starttls = providers.customEndpointOf({
    server: "imap.example.com",
    port: "143",
    protocol: "imap",
    security: "starttls",
  });
  assert.match(providers.customTitle(starttls, "en"), /IMAP · STARTTLS$/);
});

test("the endpoint key changes when anything the connection depends on changes", () => {
  const base = { host: "mail.example.com", port: 993, protocol: "imap", security: "tls" };
  assert.equal(providers.endpointKey(base), providers.endpointKey({ ...base }));
  assert.notEqual(providers.endpointKey(base), providers.endpointKey({ ...base, port: 143 }));
  assert.notEqual(providers.endpointKey(base), providers.endpointKey({ ...base, security: "starttls" }));
  assert.notEqual(providers.endpointKey(base), providers.endpointKey({ ...base, protocol: "pop3" }));
  assert.notEqual(providers.endpointKey(base), providers.endpointKey({ ...base, host: "other.example.com" }));
  assert.equal(providers.endpointKey(null), "");
});

test("a custom server never widens the preset allowlist", () => {
  assert.equal(providers.PROVIDERS.some((provider) => provider.id === "custom"), false);
  assert.equal(providers.catalogue("en").some((provider) => provider.id === "custom"), false);
  assert.equal(providers.hosts().includes("mail.example.com"), false);
  assert.equal(providers.endpoints().some((endpoint) => endpoint.host === "mail.example.com"), false);
});

test("the account's provider is resolved in the order the addendum fixed", () => {
  const endpoint = providers.customEndpointOf({
    server: "mail.example.com",
    port: "993",
    protocol: "imap",
    security: "tls",
  });
  // 1. An endpoint in the instance wins over everything else.
  const custom = providers.resolveAccount({ endpoint, fieldProvider: "qq", storedProvider: "gmail", email: "a@gmail.com" });
  assert.equal(custom.custom.host, "mail.example.com");
  assert.equal(custom.provider, null);
  // 2. The `provider` field chosen in the account form.
  assert.equal(providers.resolveAccount({ fieldProvider: "netease163" }).provider.id, "netease163");
  // 3. `custom` with no server is a state of its own, not a guess.
  const needsServer = providers.resolveAccount({ fieldProvider: "custom" });
  assert.equal(needsServer.missingServer, true);
  assert.equal(needsServer.provider, null);
  // 4. What a 0.2.0 panel stored still counts.
  assert.equal(providers.resolveAccount({ storedProvider: "qq" }).provider.id, "qq");
  // 5. The domain is the last word, and only for the unambiguous ones.
  assert.equal(providers.resolveAccount({ email: "someone@163.com" }).provider.id, "netease163");
  assert.equal(providers.resolveAccount({ email: "ceo@example.com" }).provider, null);
  // A value the dropdown does not offer is not a provider choice.
  assert.equal(providers.resolveAccount({ fieldProvider: "outlook" }).provider, null);
  assert.equal(providers.resolveAccount({}).missingServer, false);
});

test("the proxy an account carries is read from its three non-secret fields", () => {
  assert.deepEqual(providers.proxyOf({ proxyType: "http", proxyHost: "127.0.0.1", proxyPort: "7897" }), {
    type: "http",
    host: "127.0.0.1",
    port: 7897,
  });
  assert.deepEqual(providers.proxyOf({ proxyType: "socks5", proxyHost: "LAN.Example", proxyPort: "1080" }), {
    type: "socks5",
    host: "lan.example",
    port: 1080,
  });
  // No type is no proxy, which is the normal case.
  assert.equal(providers.proxyOf({ proxyType: "" }), null);
  assert.equal(providers.proxyOf({}), null);
  assert.equal(providers.proxyOf(undefined), null);
  // Anything the host would have refused is not turned into a guess.
  for (const fields of [
    { proxyType: "https", proxyHost: "127.0.0.1", proxyPort: "7897" },
    { proxyType: "http", proxyHost: "", proxyPort: "7897" },
    { proxyType: "http", proxyHost: "http://127.0.0.1", proxyPort: "7897" },
    { proxyType: "http", proxyHost: "127.0.0.1", proxyPort: "0" },
    { proxyType: "http", proxyHost: "127.0.0.1", proxyPort: "70000" },
  ]) {
    assert.equal(providers.proxyOf(fields), null, JSON.stringify(fields));
  }
  // The username and password are never published, so nothing here can read them.
  assert.equal(providers.proxyLabel({ type: "http", host: "127.0.0.1", port: 7897 }), "http://127.0.0.1:7897");
  assert.equal(providers.proxyLabel(null), "");
});
