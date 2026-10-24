/**
 * Knowledge Universe graph payload (ADR 0001 §10).
 *
 * Pure derivation over the shared vault index and ontology, so the view
 * backend, the tests, and the health mode all read the same numbers.
 */

function wikilinkTargets(value) {
  const links = Array.isArray(value) ? value : value ? [value] : [];
  const targets = [];
  for (const link of links) {
    const match = /\[\[([^\][#|]+)/.exec(String(link));
    if (match) targets.push(match[1].trim());
  }
  return targets;
}

function dateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/**
 * Build the `GraphPayload`. `options.now` drives staleness; `memory` is the
 * optional memory-satellite block (P4) and defaults to `unsupported` because
 * 0.2.0 does not declare `memory.read`.
 */
export function buildGraphPayload({ index, ontology, now = new Date(), vaultName = "", memory = { status: "unsupported", count: 0 } }) {
  const nodes = [];
  const links = [];
  const ghostMap = new Map();

  for (const relative of index.paths()) {
    if (!relative.endsWith(".md")) continue;
    const record = index.note(relative);
    if (!record) continue;
    const cls = ontology.resolveClass(record.metadata.type);
    const family = cls ? ontology.family(cls) : "entity";
    const projectLink = wikilinkTargets(record.metadata.project)[0];
    const projectTarget = projectLink ? index.resolveTarget(projectLink) : null;
    const issues = ontology.validate(record, {
      resolveTarget: (target) => index.resolveTarget(target),
      classOf: (notePath) => {
        const target = index.note(notePath);
        return target ? ontology.classOf(target) : null;
      },
      backlinkCount: index.backlinksOf(relative).length,
      now,
    });
    const outgoing = record.linkTargets.length;
    const incoming = index.backlinksOf(relative).length;
    nodes.push({
      id: relative,
      title: record.title,
      cls: cls ?? "unknown",
      family,
      project: projectTarget && projectTarget !== relative ? projectTarget : undefined,
      status: record.metadata.status ?? undefined,
      stability: record.metadata.stability ?? undefined,
      created: dateOnly(record.metadata.created),
      updated: dateOnly(record.metadata.updated),
      verified: dateOnly(record.metadata.verified),
      stale: issues.some((issue) => issue.code === "STALE"),
      archived: record.metadata.status === "archived" || relative.startsWith("04 Archive/"),
      degree: outgoing + incoming,
      chars: record.chars,
      issues: issues.map((issue) => issue.code),
    });

    // Typed predicate links first, then weak body links.
    const typedTargets = new Set();
    for (const [predicate, rule] of Object.entries(ontology.predicates)) {
      if (predicate === "related") continue;
      for (const target of wikilinkTargets(record.metadata[predicate])) {
        const resolved = index.resolveTarget(target);
        if (!resolved || resolved === relative) continue;
        typedTargets.add(resolved);
        links.push({ source: relative, target: resolved, predicate });
      }
    }
    for (const target of record.linkTargets) {
      const resolved = index.resolveTarget(target);
      if (!resolved) {
        const ghost = ghostMap.get(target) ?? { id: target, referencedBy: [] };
        ghost.referencedBy.push(relative);
        ghostMap.set(target, ghost);
        continue;
      }
      if (resolved === relative || typedTargets.has(resolved)) continue;
      links.push({ source: relative, target: resolved, predicate: "wikilink" });
    }
  }

  return {
    generatedAt: now.toISOString(),
    vaultName,
    nodes,
    links,
    ghosts: [...ghostMap.values()],
    memory,
  };
}
