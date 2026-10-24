/**
 * Secret detection and redaction. Moved verbatim from `mcp/knowledge-core.mjs`
 * (0.1.2) so both the MCP server and the view backend share one implementation.
 */

function safePlaceholder(value) {
  return /^(?:\[?redacted\]?|\*+|x+|<[^>]+>|\$\{[^}]+\}|env|environment|stored|managed|none|n\/a)$/i.test(
    value,
  );
}

export function findSensitiveContent(content) {
  const findings = [];
  const fixedPatterns = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["api-token", /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ];
  for (const [kind, pattern] of fixedPatterns) {
    if (pattern.test(content)) findings.push({ kind });
  }

  const assignment = /\b(password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'`]{8,})/gi;
  for (const match of content.matchAll(assignment)) {
    const value = match[2];
    if (!safePlaceholder(value)) {
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      findings.push({ kind: "credential-assignment", line, key: match[1] });
    }
  }
  return findings;
}

export function redactSensitiveContent(content) {
  let redacted = content
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED ACCESS KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]");
  redacted = redacted.replace(
    /(\b(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["']?)([^\s"'`]{8,})/gi,
    (full, prefix, value) => (safePlaceholder(value) ? full : `${prefix}[REDACTED]`),
  );
  return redacted;
}

/**
 * A write fails when the resulting note introduces a `[REDACTED` marker the
 * stored note does not contain: a replacement built from a redacted read would
 * otherwise persist the placeholders (ADR 0001 §8).
 */
export function redactionViolation(storedContent, resultContent) {
  const count = (text) => (text.match(/\[REDACTED/g) ?? []).length;
  return count(resultContent) > count(storedContent);
}
