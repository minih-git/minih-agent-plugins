import test from "node:test";
import assert from "node:assert/strict";

import state from "../lib/console-state.js";

const { normalizeBaseUrl, parseSessionEnvelope, consoleTarget, readStatus } = state;

test("normalizeBaseUrl accepts a bare host and assumes https", () => {
  assert.deepEqual(normalizeBaseUrl("router.example.com"), {
    ok: true,
    baseUrl: "https://router.example.com",
  });
});

test("normalizeBaseUrl keeps plain http for a local instance and drops a trailing slash", () => {
  assert.deepEqual(normalizeBaseUrl(" http://127.0.0.1:3000/ "), {
    ok: true,
    baseUrl: "http://127.0.0.1:3000",
  });
});

test("normalizeBaseUrl keeps a sub-path so a gateway behind a prefix still works", () => {
  assert.deepEqual(normalizeBaseUrl("https://example.com/router/"), {
    ok: true,
    baseUrl: "https://example.com/router",
  });
});

test("normalizeBaseUrl refuses an empty address, a non-http scheme, and a query string", () => {
  assert.equal(normalizeBaseUrl("   ").code, "empty");
  assert.equal(normalizeBaseUrl(undefined).code, "empty");
  assert.equal(normalizeBaseUrl("ftp://example.com").code, "invalid-url");
  assert.equal(normalizeBaseUrl("https://example.com/?x=1").code, "invalid-url");
});

test("parseSessionEnvelope reads the control-plane envelope and keeps no credential", () => {
  const parsed = parseSessionEnvelope(
    JSON.stringify({
      code: 0,
      message: "ok",
      data: {
        authenticated: true,
        principal_type: "access_key",
        key_name: "laptop",
        key_prefix: "sk-abcd",
        key_suffix: "wxyz",
        status: "active",
        rpm_limit: 60,
        expires_at_ms: 1_800_000_000_000,
        secret: "sk-should-never-be-read",
      },
    }),
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.session, {
    principalType: "access_key",
    keyName: "laptop",
    keyPrefix: "sk-abcd",
    keySuffix: "wxyz",
    status: "active",
    rpmLimit: 60,
    expiresAtMs: 1_800_000_000_000,
  });
});

test("parseSessionEnvelope reports a body that is not a Router answer", () => {
  assert.equal(parseSessionEnvelope("<html>proxy</html>").code, "bad-response");
  assert.equal(parseSessionEnvelope("{}").code, "bad-response");
  assert.equal(
    parseSessionEnvelope(JSON.stringify({ data: { authenticated: false } })).code,
    "not-authenticated",
  );
});

test("consoleTarget keeps an access key on the key usage page", () => {
  assert.deepEqual(consoleTarget("https://router.example.com", "access_key"), {
    admin: false,
    url: "https://router.example.com/key-usage",
  });
  assert.deepEqual(consoleTarget("https://router.example.com", "admin"), {
    admin: true,
    url: "https://router.example.com/",
  });
});

test("readStatus stops before any request when the settings are incomplete", async () => {
  let called = 0;
  const request = async () => {
    called += 1;
    return { status: 200, bodyText: "{}" };
  };
  assert.equal((await readStatus({ baseUrl: "" }, request)).code, "empty");
  assert.equal(
    (await readStatus({ baseUrl: "https://router.example.com" }, request)).code,
    "no-credential",
  );
  assert.equal(called, 0);
});

test("readStatus returns the identity the panel may show", async () => {
  const seen = [];
  const request = async (input) => {
    seen.push(input);
    return {
      status: 200,
      bodyText: JSON.stringify({
        data: {
          authenticated: true,
          principal_type: "admin",
          key_name: "console",
          key_prefix: "ad-1",
          key_suffix: "9f",
          status: "active",
        },
      }),
    };
  };
  const status = await readStatus(
    { baseUrl: "https://router.example.com/", credential: "secret-value", openOnView: true },
    request,
  );
  assert.equal(status.ok, true);
  assert.equal(status.openOnView, true);
  assert.equal(status.identity.admin, true);
  assert.equal(status.identity.url, "https://router.example.com/");
  assert.equal(status.identity.keyHint, "ad-1…9f");
  assert.equal(seen[0].url, "https://router.example.com/api/auth/session");
  assert.equal(seen[0].headers.authorization, "Bearer secret-value");
  assert.ok(!JSON.stringify(status).includes("secret-value"));
});

test("readStatus separates a rejected credential from an unreachable gateway", async () => {
  const rejected = await readStatus(
    { baseUrl: "router.example.com", credential: "k" },
    async () => ({ status: 401, bodyText: "" }),
  );
  assert.equal(rejected.code, "unauthorized");
  assert.equal(rejected.configured, true);

  const broken = await readStatus(
    { baseUrl: "router.example.com", credential: "k" },
    async () => ({
      status: 200,
      bodyText: JSON.stringify({ data: { authenticated: false } }),
    }),
  );
  assert.equal(broken.code, "not-authenticated");

  const offline = await readStatus(
    { baseUrl: "router.example.com", credential: "k" },
    async () => {
      throw new Error("ECONNREFUSED");
    },
  );
  assert.equal(offline.code, "network");
  assert.equal(offline.detail, "ECONNREFUSED");

  const failure = await readStatus(
    { baseUrl: "router.example.com", credential: "k" },
    async () => ({ status: 502, bodyText: "" }),
  );
  assert.equal(failure.code, "http-error");
  assert.equal(failure.status, 502);
});
