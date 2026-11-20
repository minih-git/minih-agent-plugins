import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const providers = require("../lib/providers.js");

/**
 * The manifest this plugin publishes, checked against the host's own rules.
 *
 * The desktop's `validateManifest` is the authority, but the devkit build in a
 * checkout can be older than the host capability it validates, so this file
 * pins the same rules here: what the permissions may be, that every TCP
 * endpoint is literal and encrypted, that the credential slot reaches each
 * provider host, and that the schedule is one interval. A drift between the
 * manifest and `lib/providers.js` — the table the code actually dials — is the
 * failure that would otherwise only show up as a permission error at runtime.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mainSource = readFileSync(join(root, manifest.main), "utf8");
const exists = (file) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true;

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const CONTRIB_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

test("the plugin is published as minih.inbox-mail, versioned with its package", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "minih.inbox-mail");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.main, "main.js");
  assert.ok(exists(manifest.main), "the entry point must be in the tree");
  assert.ok(exists("README.md"), "a user-facing plugin needs its own README");
});

test("it asks for the four capabilities it uses and nothing else", () => {
  assert.deepEqual([...manifest.permissions].sort(), [
    "credentials.use",
    "net.tcp",
    "notify.center",
    "scheduler",
  ]);
  // Sending is not implemented by the host and must not be claimed.
  assert.equal(manifest.permissions.includes("mail.draft"), false);
  // This slice has no panel and no renderer slot.
  assert.equal(manifest.permissions.includes("ui.view"), false);
  assert.equal(manifest.permissions.includes("renderer.extension"), false);
  assert.equal(manifest.renderer, undefined);
  assert.equal(manifest.contributes.views, undefined);
});

test("it declares the app version that actually has these host capabilities", () => {
  assert.equal(manifest.engines.minihAgent, ">=1.8.0");
  assert.equal(manifest.activationEvents.includes("onStartup"), true, "a watcher has to start with the app");
});

test("every TCP endpoint is a literal host on an encrypted port", () => {
  const entries = manifest.net.tcp;
  assert.ok(Array.isArray(entries) && entries.length > 0, "net.tcp is the whole allowlist");
  const seen = new Set();
  for (const entry of entries) {
    assert.equal(typeof entry.host, "string");
    assert.equal(entry.host, entry.host.toLowerCase());
    assert.doesNotMatch(entry.host, /\*/, "a wildcard endpoint is not reviewable");
    assert.match(entry.host, HOSTNAME);
    assert.equal(Number.isInteger(entry.port), true);
    assert.ok(entry.port >= 1 && entry.port <= 65535);
    assert.equal(entry.tls, true, "the host performs an IMAP login only over implicit TLS");
    const key = `${entry.host}:${entry.port}`;
    assert.equal(seen.has(key), false, `${key} is listed twice`);
    seen.add(key);
  }
});

test("the manifest allowlist and the provider table are the same list", () => {
  assert.deepEqual(
    manifest.net.tcp.map((entry) => `${entry.host}:${entry.port}`).sort(),
    providers.endpoints().map((entry) => `${entry.host}:${entry.port}`).sort(),
  );
  for (const provider of providers.PROVIDERS) {
    assert.ok(
      manifest.net.tcp.some((entry) => entry.host === provider.host && entry.port === provider.port),
      `${provider.id} has no declared endpoint`,
    );
  }
});

test("the credential slot is one IMAP account the user fills in", () => {
  assert.equal(manifest.contributes.credentials.length, 1);
  const [slot] = manifest.contributes.credentials;
  assert.match(slot.id, CONTRIB_ID);
  assert.equal(slot.kind, "imap");
  assert.ok(Array.isArray(slot.fields) && slot.fields.length >= 2);
  const keys = slot.fields.map((field) => field.key);
  assert.deepEqual([...keys].sort(), ["password", "username"]);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(slot.fields.find((field) => field.key === "password").secret, true);
  for (const field of slot.fields) {
    assert.match(field.key, CONTRIB_ID);
    assert.ok(field.label.en && field.label["zh-CN"], "a field label needs both contract locales");
  }
  assert.ok(slot.title.en && slot.title["zh-CN"]);
});

test("the slot's scope admits every provider host it will be injected into", () => {
  const scope = manifest.contributes.credentials[0].scope.domains;
  assert.ok(Array.isArray(scope) && scope.length > 0, "a slot with no scope authorizes nothing");
  for (const entry of scope) {
    assert.doesNotMatch(entry, /\*/, "the scope is a literal list, not a wildcard");
  }
  for (const provider of providers.PROVIDERS) {
    assert.ok(scope.includes(provider.host), `${provider.host} is not in the credential scope`);
  }
});

test("the fallback poll is one interval, at least a minute long", () => {
  assert.equal(manifest.contributes.schedules.length, 1);
  const [schedule] = manifest.contributes.schedules;
  assert.match(schedule.id, CONTRIB_ID);
  assert.ok(schedule.title.en && schedule.title["zh-CN"]);
  const hasEvery = schedule.every !== undefined;
  const hasCron = schedule.cron !== undefined;
  assert.equal(hasEvery !== hasCron, true, "exactly one of every or cron");
  assert.equal(schedule.every, "15m");
  const [, amount, unit] = /^([1-9][0-9]*)([smhd])$/.exec(schedule.every);
  const minutes = { s: 1 / 60, m: 1, h: 60, d: 1440 }[unit] * Number(amount);
  assert.ok(minutes >= 1, "the host's floor is one minute");
});

test("the command a notification links to is declared and registered", () => {
  const ids = manifest.contributes.commands.map((command) => command.id);
  assert.deepEqual(ids, ["check-now"]);
  // `notify.center` only accepts a link to a declared command, and the runtime
  // only answers one it registered: both halves have to exist.
  assert.match(mainSource, /const COMMAND_ID = "check-now";/);
  assert.match(mainSource, /commands\.register\(/);
  assert.match(mainSource, /link: \{ command: COMMAND_ID \}/);
});

test("every setting the code reads is declared, with the same defaults", () => {
  const settings = new Map(manifest.contributes.settings.map((entry) => [entry.key, entry]));
  assert.equal(settings.size, manifest.contributes.settings.length, "settings keys are unique");
  assert.deepEqual([...settings.keys()].sort(), [
    "digestMinutes",
    "importantSenders",
    "keywords",
    "provider",
    "unreadOnly",
  ]);
  assert.equal(settings.get("digestMinutes").type, "number");
  assert.equal(settings.get("digestMinutes").default, 30);
  assert.equal(settings.get("unreadOnly").type, "boolean");
  assert.equal(settings.get("unreadOnly").default, false);
  const provider = settings.get("provider");
  assert.equal(provider.type, "select");
  assert.deepEqual(
    [...provider.enum.map((option) => option.value)].sort(),
    [...providers.PROVIDERS.map((entry) => entry.id)].sort(),
  );
  assert.equal(provider.default, providers.DEFAULT_PROVIDER_ID);
});

test("both contract locales carry every display string", () => {
  for (const locale of ["en", "zh-CN"]) {
    const block = manifest.i18n[locale];
    assert.ok(block, `${locale} is missing`);
    assert.ok(block.name, `${locale}.name`);
    assert.ok(block.description, `${locale}.description`);
    assert.ok(block.safetyNotes, `${locale}.safetyNotes`);
  }
  assert.equal(manifest.name, manifest.i18n.en.name);
  assert.equal(manifest.safetyNotes, manifest.i18n.en.safetyNotes);
});

test("the safety notes say what is read, what is kept and what is never done", () => {
  const notes = `${manifest.i18n.en.safetyNotes} ${manifest.i18n["zh-CN"].safetyNotes}`;
  assert.match(notes, /BODY\.PEEK/);
  assert.match(notes, /read-only/i);
  assert.match(notes, /does not send mail/);
  assert.match(notes, /No model is called/);
  assert.match(notes, /不准|不发信|不会/);
});
