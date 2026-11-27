import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The vault every `knowledge_context` test starts from.
 *
 * It is deliberately small and fixed: the rendered text for `mode: "full"` is
 * compared against a snapshot taken from 0.7.2 (`knowledge-context-full.txt`),
 * so note text, frontmatter, and mapping names must not drift.
 */
export async function createContextVault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-test-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(path.join(vault, "02 Areas"), { recursive: true });
  await mkdir(path.join(vault, "01 Projects", "Demo"), { recursive: true });
  await mkdir(path.join(vault, "03 Resources", "Deploy"), { recursive: true });
  await writeFile(path.join(vault, "02 Areas", "Preferences.md"), `---
title: Preferences
type: area
status: active
verified: 2026-07-01
review_interval: on-change
---
# Preferences

Prefer evidence-backed work. See [[Project - Demo]].
`);
  await writeFile(path.join(vault, "01 Projects", "Project - Demo.md"), `---
title: Project - Demo
type: project
status: active
verified: 2026-01-01
review_interval: quarterly
---
# Demo

Demo architecture and release workflow.
`);
  await writeFile(path.join(vault, "01 Projects", "Demo", "Knowledge Map.md"), `---
title: Demo Knowledge Map
type: moc
status: active
review_interval: quarterly
---
# Demo Knowledge Map

Links to [[Project - Demo]].
`);
  await writeFile(path.join(vault, "03 Resources", "Deploy", "Infrastructure.md"), `---
title: Infrastructure
type: inventory
status: active
review_interval: monthly
---
# Infrastructure

EasyTier center node.
`);
  await writeFile(path.join(vault, "Secret.md"), `---
title: Secret
type: test
---
token: abcdefghijklmnopqrstuvwxyz
`);
  await writeFile(path.join(vault, "Dashboard.base"), "views: []\n");

  const config = {
    defaultNotes: ["02 Areas/Preferences.md"],
    projects: [{
      name: "Demo",
      repoPrefixes: ["/workspace/demo"],
      aliases: ["demo"],
      notes: ["01 Projects/Project - Demo.md", "01 Projects/Demo/Knowledge Map.md"],
    }],
    topicRoutes: [{
      name: "Infrastructure",
      aliases: ["server", "easytier"],
      notes: ["03 Resources/Deploy/Infrastructure.md"],
    }],
    ignoreFolders: ["Templates", "04 Archive"],
    backupRetentionDays: 0,
  };
  return { root, vault, config };
}

/**
 * A temporary vault holding exactly these files (`{ "path": "content" }`), for
 * packs that need their own layout rather than the shared fixture.
 */
export async function createVault(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-knowledge-ctx-"));
  const vault = path.join(root, "Knowledge");
  await mkdir(vault, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const absolute = path.join(vault, name);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return { root, vault };
}