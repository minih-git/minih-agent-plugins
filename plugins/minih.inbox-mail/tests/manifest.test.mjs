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
 * The desktop's `validateManifest` is the authority, but the devkit in a checkout
 * can be older than the host capability it validates, so this file pins the same
 * rules here: what the permissions may be, that every TCP endpoint is literal and
 * encrypted, that the credential slot reaches each provider host and keeps the
 * 0.1.0 field set, that the panel is declared as a sidebar view, and that the
 * schedule is one interval. A drift between the manifest and `lib/providers.js` —
 * the table the code actually dials — is the failure that would otherwise only
 * show up as a permission error at runtime.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mainSource = readFileSync(join(root, manifest.main), "utf8");
const exists = (file) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true;

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const CONTRIB_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const localized = (value) => Boolean(value && typeof value === "object" && value.en && value["zh-CN"]);

test("the plugin is published as minih.inbox-mail 0.5.1, versioned with its package", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "minih.inbox-mail");
  assert.equal(manifest.version, "0.5.1");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.main, "main.js");
  assert.ok(exists(manifest.main), "the entry point must be in the tree");
  assert.ok(exists("README.md"), "a user-facing plugin needs its own README");
  assert.ok(exists("CHANGELOG.md"), "a released plugin records what changed");
});

test("it asks for exactly the capabilities it uses, including writing and sending", () => {
  assert.deepEqual([...manifest.permissions].sort(), [
    "credentials.use",
    "fs.write",
    "mail.send",
    "net.tcp",
    "notify.center",
    "shell.openExternal",
    "ui.view",
  ]);
  // Polling is the plugin's own timer, so the host scheduler is not asked for.
  assert.equal(manifest.permissions.includes("scheduler"), false);
  // `mail.draft` is a different grant — drafting never sends — and this plugin
  // sends, so claiming it would describe the wrong thing.
  assert.equal(manifest.permissions.includes("mail.draft"), false);
  assert.equal(manifest.permissions.includes("renderer.extension"), false);
  assert.equal(manifest.renderer, undefined);
  // A view contribution without its permission is refused by the host.
  assert.equal(manifest.contributes.views.length > 0, manifest.permissions.includes("ui.view"));
});

test("it declares the app version that actually has these host capabilities", () => {
  assert.equal(
    manifest.engines.minihAgent,
    ">=1.11.0",
    "a per-account proxy is the host capability of 1.11.0; 1.10.0 would ignore it",
  );
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
    // `tls: true` is implicit TLS; `tls: false` is STARTTLS, which `mail.send`
    // requires to succeed before it sends the credential.
    assert.equal(typeof entry.tls, "boolean");
    if (entry.tls === false) {
      assert.match(entry.host, /^smtp\./, "only a submission endpoint may declare STARTTLS");
      assert.equal(entry.port, 587);
    }
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

test("the credential slot has no account ceiling and keeps the 0.1.0 field set", () => {
  assert.equal(manifest.contributes.credentials.length, 1);
  const [slot] = manifest.contributes.credentials;
  assert.match(slot.id, CONTRIB_ID);
  assert.equal(slot.kind, "imap");
  // No plugin-declared ceiling: 1.10.0 accepts `multiple: {}`, and the host keeps
  // its own safety bound of 100 instances.
  assert.deepEqual(slot.multiple, {});
  assert.equal("max" in slot.multiple, false);
  assert.equal(slot.labelField, "username", "an instance is labelled by the address the user typed");
  const keys = slot.fields.map((field) => field.key);
  // `username` and `password` are the frozen 0.1.0 pair; `provider` was added in
  // 0.3.0 for the account form. The host keeps reporting an existing instance, so
  // an account created before the field existed still loads (see plugin.test).
  assert.deepEqual([...keys].sort(), ["password", "provider", "username"]);
  assert.equal(slot.fields.find((field) => field.key === "password").secret, true);
  const providerField = slot.fields.find((field) => field.key === "provider");
  assert.equal(providerField.secret, undefined, "a select cannot be secret");
  assert.equal(providerField.type, "select");
  // The dropdown offers the services that can actually log in, plus the custom
  // server; Outlook needs OAuth2 and is deliberately absent.
  assert.deepEqual(
    providerField.options.map((option) => option.value),
    ["qq", "netease163", "netease126", "gmail", "tencentExmail", "custom"],
  );
  for (const option of providerField.options) {
    assert.ok(localized(option.label), `${option.value} needs both locales`);
  }
  assert.equal(providerField.options.some((option) => option.value === "outlook"), false);
  assert.equal(slot.fields.find((field) => field.key === slot.labelField).secret, undefined);
  for (const field of slot.fields) {
    assert.match(field.key, CONTRIB_ID);
    assert.ok(localized(field.label), "a field label needs both contract locales");
  }
  assert.ok(localized(slot.title));
});

test("the slot declares a per-account proxy as its own top-level key", () => {
  const [slot] = manifest.contributes.credentials;
  // Top-level on purpose: 1.10.0 refuses an unknown key INSIDE `userEndpoint`
  // ("userEndpoint has an unsupported key"), and a top-level key it does not know
  // is ignored — which is what lets this manifest still install there.
  assert.deepEqual(slot.userProxy, { types: ["http", "socks5"] });
  assert.deepEqual(Object.keys(slot.userEndpoint).sort(), ["protocols"]);
  assert.equal("proxyType" in slot.userEndpoint, false);
  for (const reserved of ["proxyType", "proxyHost", "proxyPort", "proxyUsername", "proxyPassword"]) {
    assert.equal(
      slot.fields.some((field) => field.key === reserved),
      false,
      `${reserved} belongs to the host, not to the slot`,
    );
  }
});

test("the slot admits a server the user types, for both protocols, and nothing more", () => {
  const [slot] = manifest.contributes.credentials;
  // The host reserves these four non-secret instance fields for an instance that
  // carries its own endpoint. Declaring one here would be refused, and would also
  // break the frozen field set the 0.1.0 migration depends on.
  assert.deepEqual(slot.userEndpoint, { protocols: ["imap", "pop3"] });
  for (const reserved of ["server", "port", "protocol", "security"]) {
    assert.equal(
      slot.fields.some((field) => field.key === reserved),
      false,
      `${reserved} belongs to the host, not to the slot`,
    );
  }
  // The plugin's own table still knows nothing about a custom endpoint: an
  // endpoint that is not a preset is never part of the reviewed allowlist.
  assert.equal(providers.CUSTOM_PROVIDER_ID, "custom");
  assert.equal(providers.catalogue("en").some((entry) => entry.id === "custom"), false);
});

test("the slot collects an outgoing server for an account that has no preset", () => {
  const [slot] = manifest.contributes.credentials;
  // Top-level on purpose, like `userProxy`: a 1.10.0 host ignores a key it does
  // not know, so the same package still installs there and keeps the preset path.
  assert.deepEqual(slot.userSend, { security: ["tls", "starttls"] });
  assert.deepEqual(Object.keys(slot.userSend), ["security"]);
  for (const reserved of ["sendServer", "sendPort", "sendSecurity"]) {
    assert.equal(
      slot.fields.some((field) => field.key === reserved),
      false,
      `${reserved} belongs to the host, not to the slot`,
    );
  }
});

test("the slot's scope admits every provider host it will be injected into", () => {
  const scope = manifest.contributes.credentials[0].scope.domains;
  assert.ok(Array.isArray(scope) && scope.length > 0, "a slot with no scope authorizes nothing");
  for (const entry of scope) {
    assert.doesNotMatch(entry, /\*/, "the scope is a literal list, not a wildcard");
  }
  for (const provider of providers.PROVIDERS) {
    assert.ok(scope.includes(provider.host), `${provider.host} is not in the credential scope`);
    // A preset account sends through the provider's submission endpoint, and the
    // host checks that endpoint against this same scope.
    if (provider.smtp) {
      assert.ok(scope.includes(provider.smtp.host), `${provider.smtp.host} is not in the credential scope`);
    }
  }
});

test("the Inbox panel is one sidebar view with a localized title and a real entry", () => {
  assert.equal(manifest.contributes.views.length, 1);
  const [view] = manifest.contributes.views;
  assert.match(view.id, CONTRIB_ID);
  assert.equal(view.placement, "sidebar");
  // A sidebar icon the host knows: 1.10.0 adds "mail" to its list, and an older
  // host that does not know the name draws a letter tile instead of failing.
  assert.equal(view.icon, "mail");
  assert.ok(localized(view.title));
  assert.equal(view.title["zh-CN"], "收件箱");
  assert.ok(exists(view.entry), "the view entry must exist");
  assert.equal(view.entry, "view/index.html");
  assert.ok(exists("view/app.js"));
  assert.ok(exists("view/vendor/purify.es.mjs"));
});

test("the plugin polls itself instead of asking the host for a schedule", () => {
  // Every account is checked by the plugin's own timer (three minutes, staggered,
  // through one four-session gate), so a host schedule would be a second, slower
  // source of ticks for the same work.
  assert.equal(manifest.contributes.schedules, undefined);
  assert.equal(manifest.permissions.includes("scheduler"), false);
});

test("the command a notification links to is declared and registered", () => {
  const ids = manifest.contributes.commands.map((command) => command.id);
  assert.deepEqual(ids, ["check-now"]);
  assert.match(mainSource, /const COMMAND_ID = "check-now";/);
  assert.match(mainSource, /commands\.register\(/);
  assert.match(mainSource, /onPanelInvoke/);
});

test("every remaining setting is declared, localized, and matches the code's defaults", () => {
  const settings = new Map(manifest.contributes.settings.map((entry) => [entry.key, entry]));
  assert.equal(settings.size, manifest.contributes.settings.length, "settings keys are unique");
  // The provider is no longer a setting: it belongs to one account, not to all of them.
  assert.deepEqual([...settings.keys()].sort(), [
    "digestMinutes",
    "importantSenders",
    "keywords",
    "unreadOnly",
  ]);
  for (const entry of settings.values()) {
    assert.ok(localized(entry.title), `${entry.key} title needs both locales`);
    assert.ok(localized(entry.description), `${entry.key} description needs both locales`);
    assert.match(entry.key, /^[a-zA-Z][a-zA-Z0-9]*$/);
  }
  assert.equal(settings.get("digestMinutes").type, "number");
  assert.equal(settings.get("digestMinutes").default, 30);
  assert.equal(settings.get("unreadOnly").type, "boolean");
  assert.equal(settings.get("unreadOnly").default, false);
  assert.equal(settings.get("importantSenders").default, "");
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
  assert.equal(manifest.description, manifest.i18n.en.description);
  assert.equal(manifest.safetyNotes, manifest.i18n.en.safetyNotes);
});

test("the safety notes describe the panel honestly, in both languages", () => {
  const en = manifest.i18n.en.safetyNotes;
  const zh = manifest.i18n["zh-CN"].safetyNotes;
  // No account ceiling, and the panel.
  assert.match(en, /no mailbox limit in this plugin/i);
  assert.match(en, /Inbox panel/);
  // Bodies only on click, capped, in memory.
  assert.match(en, /only when you open that message/);
  assert.match(en, /1 MiB/);
  assert.match(en, /never written to disk/);
  // Header-only watching.
  assert.match(en, /BODY\.PEEK/);
  // Opening marks read (one STORE), and a click is one STORE more.
  assert.match(en, /Opening a message marks that one message read/);
  assert.match(en, /IMAP STORE/);
  assert.match(en, /read there is a mark kept on this computer/);
  // The frame: sanitized, no script, no remote images by default, and a link is
  // answered by the panel instead of navigating the frame.
  assert.match(en, /runs no script and, by default, loads nothing remote/);
  assert.match(en, /allow-scripts is never set/);
  assert.match(en, /same-origin only so that the panel can answer those clicks/);
  assert.match(en, /a mailto: link opens the panel's own composer/);
  assert.match(en, /remote images stay blocked/i);
  // The one-line preview and the recipients it now keeps, and their bounds.
  assert.match(en, /at most 140 characters of plain-text summary/);
  assert.match(en, /few headers \(sender, subject, to, cc, date, Message-ID/);
  assert.match(en, /up to 20 to and 20 cc addresses/);
  // Delete and archive: what they send, and what they refuse to send.
  assert.match(en, /UID MOVE <uid> <trash>/);
  assert.match(en, /UID COPY <uid> <trash>/);
  assert.match(en, /UID EXPUNGE <uid>/);
  assert.match(en, /never sends a mailbox-wide EXPUNGE|instead of falling back to a mailbox-wide EXPUNGE/);
  assert.match(en, /Archive works the same way/);
  // Sending: only on the click, by the app, from the account's own address, with
  // a Sent copy filed afterwards.
  assert.match(en, /nothing is sent on a timer, on arrival or from a rule/);
  assert.match(en, /The sender is locked to the account's own address/);
  assert.match(en, /never carries a Bcc header/);
  assert.match(en, /one copy appended to their Sent mailbox/);
  assert.match(en, /Gmail files what it sends already/);
  // Saving one attachment: on the click, into the dialog's path, capped.
  assert.match(en, /A file above 50 MiB is refused/);
  assert.match(en, /never written to this plugin's data folder/);
  // The old release claimed neither happened, and that claim is gone.
  assert.doesNotMatch(en, /does not send mail/);
  assert.doesNotMatch(en, /never downloaded/);
  assert.match(en, /No model is called/);
  // And the Chinese notes say the same things.
  assert.match(zh, /不设账号上限/);
  assert.match(zh, /只有你在「收件箱」面板里点开/);
  assert.match(zh, /打开一封邮件会把这封标为已读/);
  assert.match(zh, /不执行脚本/);
  assert.match(zh, /从不放开脚本/);
  assert.match(zh, /mailto 链接则打开面板自己的写信界面/);
  assert.match(zh, /远程图片默认拦截/);
  // The other way in: a server the user typed, and the protocol with no flags.
  assert.match(en, /a server you typed into the account form yourself/);
  assert.match(en, /the app injects the password only into the endpoint stored in the same instance/);
  assert.match(en, /once every three minutes the plugin opens one short session per account/);
  assert.match(en, /never more than four sessions at a time/);
  assert.match(en, /never polled sooner than the server's LOGIN-DELAY/);
  assert.match(en, /DELE <n>/);
  assert.match(en, /QUIT/);
  // The proxy is the account's own setting, and its credentials never reach the
  // plugin.
  assert.match(en, /HTTP or SOCKS5 proxy configured on that account/);
  assert.match(en, /only learns the proxy type, host and port/);
  assert.match(en, /A POP3 account has no flags on the server/);
  assert.match(zh, /自己填写的服务器/);
  assert.match(zh, /只会把该实例的密码注入同一个实例里记录的地址/);
  assert.match(zh, /同时最多 4 条/);
  assert.match(zh, /不会早于服务器要求的 LOGIN-DELAY/);
  assert.match(zh, /最多 140 个字符的纯文本摘要/);
  assert.match(zh, /UID MOVE/);
  assert.match(zh, /UID EXPUNGE/);
  assert.match(zh, /DELE <n>/);
  assert.match(zh, /本插件从不发送/);
  assert.match(zh, /本机 Clash/);
  assert.match(zh, /插件只知道代理类型、地址和端口/);
  assert.match(zh, /POP3 服务器没有任何标记/);
  assert.match(zh, /只有你按下「发送」才会发信/);
  assert.match(zh, /发件人被锁定为账号本人的地址/);
  assert.match(zh, /「已发送」/);
  assert.match(zh, /超过 50 MiB 的附件会被直接拒绝/);
  assert.doesNotMatch(zh, /不发信/);
  assert.doesNotMatch(zh, /从不下载/);
  assert.match(zh, /不调用模型/);
});
