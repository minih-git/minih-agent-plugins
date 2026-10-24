import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  defaultProfile,
  detectShellProfiles,
  findProfile,
  isLocalDirectory,
} = require("../lib/shells.js");

test("detects installed shells and never invents one", () => {
  const profiles = detectShellProfiles({
    platform: "darwin",
    env: { SHELL: "/bin/zsh" },
    isFile: (file) => ["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/bash"].includes(file),
  });
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["zsh", "bash"],
  );
  for (const profile of profiles) {
    assert.ok(profile.file.startsWith("/"), profile.file);
    assert.deepEqual(profile.args, ["-l"], "a POSIX shell is started as a login shell");
  }
});

test("a missing login shell is skipped instead of substituted silently", () => {
  const profiles = detectShellProfiles({
    platform: "darwin",
    env: { SHELL: "/opt/nowhere/zsh" },
    isFile: (file) => file === "/bin/bash",
  });
  assert.deepEqual(profiles.map((profile) => profile.id), ["bash"]);
});

test("two installs of one shell collapse to the first, so a profile id stays stable", () => {
  const profiles = detectShellProfiles({
    platform: "darwin",
    env: { SHELL: "/opt/homebrew/bin/bash" },
    isFile: () => true,
  });
  assert.equal(profiles[0].id, "bash");
  assert.equal(profiles[0].file, "/opt/homebrew/bin/bash");
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, profiles.length);
});

test("windows offers PowerShell, cmd, and Git Bash only when installed", () => {
  const profiles = detectShellProfiles({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    isFile: (file) =>
      file === "C:\\Program Files\\PowerShell\\7\\pwsh.exe" ||
      file === "C:\\Windows\\System32\\cmd.exe",
  });
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["pwsh", "cmd"],
  );
});

test("a POSIX shell starts as a login shell; a Windows one takes no flag", () => {
  const posix = detectShellProfiles({
    platform: "linux",
    env: { SHELL: "/bin/zsh" },
    isFile: (file) => file === "/bin/zsh",
  });
  // Login shells are the only ones that read `/etc/zprofile`, `~/.zprofile`,
  // and `~/.profile`, which is where the user's PATH setup lives; without the
  // flag an app inherits launchd's minimal PATH and the first `fnm` line in
  // `~/.zshrc` fails with "command not found".
  assert.deepEqual(posix[0].args, ["-l"]);
  const windows = detectShellProfiles({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    isFile: (file) => file === "C:\\Windows\\System32\\cmd.exe",
  });
  assert.deepEqual(windows[0].args, []);
});

test("each profile owns its flag list, so one spawn cannot rewrite another", () => {
  const profiles = detectShellProfiles({
    platform: "darwin",
    env: {},
    isFile: (file) => file === "/bin/zsh" || file === "/bin/bash",
  });
  assert.equal(profiles.length, 2);
  assert.notEqual(profiles[0].args, profiles[1].args);
  assert.deepEqual(profiles[1].args, ["-l"]);
});

test("no installed shell yields an empty catalog rather than a fake default", () => {
  assert.deepEqual(detectShellProfiles({ platform: "linux", env: {}, isFile: () => false }), []);
  assert.equal(defaultProfile([]), null);
});

test("a profile id this machine lost is refused, not replaced", () => {
  const profiles = [{ id: "zsh", label: "zsh", file: "/bin/zsh", args: [] }];
  assert.equal(findProfile(profiles, "zsh")?.file, "/bin/zsh");
  assert.equal(findProfile(profiles, "pwsh"), null);
  assert.equal(findProfile(profiles, undefined)?.id, "zsh");
});

test("only an existing local directory can host a terminal", () => {
  assert.equal(isLocalDirectory("/work", (path) => path === "/work"), true);
  assert.equal(isLocalDirectory("/remote/only", () => false), false);
  assert.equal(isLocalDirectory("", () => true), false);
  assert.equal(isLocalDirectory(null, () => true), false);
});
