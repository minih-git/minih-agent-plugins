/**
 * Read-only Markdown rendering for the note drawer (obsidian-independence
 * design §2).
 *
 * The vault is plain Markdown with YAML frontmatter, `[[wikilinks]]`, and
 * Obsidian callouts, so this file covers exactly that subset and nothing
 * more. It is split in two so `node --test` can cover the whole conversion
 * without a DOM:
 *
 *   parseMarkdown(text, { resolveLink }) → tree of plain objects
 *   toDom(tree, { onWikilink, onExternal }) → the same tree as DOM nodes
 *
 * A node is `{ tag, attrs, children }` (children are nodes or strings) or
 * `{ tag: "text", text }` for a text run. Nothing here ever produces HTML
 * text: the adapter builds elements with `createElement` and `textContent`,
 * so note content can never become markup, and only http(s) URLs become
 * links at all.
 */

/** Heading levels shift down one: the drawer title stays the largest. */
const HEADING_SHIFT = 1;
const MAX_HEADING_LEVEL = 6;

/** Callout types Obsidian styles; anything else falls back to `note`. */
const CALLOUT_TYPES = new Set([
  "note",
  "abstract",
  "summary",
  "tldr",
  "info",
  "todo",
  "tip",
  "hint",
  "important",
  "success",
  "check",
  "done",
  "question",
  "help",
  "faq",
  "warning",
  "caution",
  "attention",
  "failure",
  "fail",
  "missing",
  "danger",
  "error",
  "bug",
  "example",
  "quote",
  "cite",
]);

const CALLOUT_ALIASES = { summary: "abstract", tldr: "abstract", hint: "tip", check: "success", done: "success", help: "question", faq: "question", caution: "warning", attention: "warning", fail: "failure", missing: "failure", error: "danger", bug: "danger", cite: "quote" };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const THEMATIC_BREAK = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const CALLOUT = /^\[!([A-Za-z-]+)\]([+-]?)\s*(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const EXTERNAL_LINK = /^([A-Za-z][A-Za-z0-9+.-]*):/;

// ---- inline ----

/**
 * One pass over an inline run. Group numbers, in order:
 *   1,2  code span (fence, body)
 *   3    wikilink target     4 heading     5 alias
 *   6    markdown link text  7 url
 *   8    bold  9 strike  10 italic
 * Embeds are matched separately (see `parseInline`), because `![[x]]` would
 * otherwise be read as an image marker plus a wikilink.
 */
const INLINE_PATTERN = new RegExp(
  [
    "(`+)([\\s\\S]*?)\\1",
    "\\[\\[([^\\][|#]+)(?:#([^\\][|]*))?(?:\\|([^\\][]*))?\\]\\]",
    "\\[([^\\]]*)\\]\\(([^()\\s]*)\\)",
    "\\*\\*([\\s\\S]+?)\\*\\*",
    "~~([\\s\\S]+?)~~",
    "\\*([^*\\n]+?)\\*",
  ].join("|"),
);

function textNode(text) {
  return { tag: "text", text };
}

/** A URL only becomes a link when it is http(s); a scheme means "decide". */
function safeUrl(url) {
  const value = String(url ?? "").trim();
  if (!value) return null;
  const scheme = EXTERNAL_LINK.exec(value);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    return protocol === "http" || protocol === "https" ? value : null;
  }
  // A vault-relative path in `[text](path)` stays text: the drawer only
  // follows wikilinks, which carry the vault's own resolution rules.
  return null;
}

function normalizeCalloutType(raw) {
  const type = String(raw ?? "").toLowerCase();
  if (!CALLOUT_TYPES.has(type)) return "note";
  return CALLOUT_ALIASES[type] ?? type;
}

function embedNode(raw) {
  return {
    tag: "span",
    attrs: { class: "md-embed", "data-embed": raw },
    children: [
      textNode(raw),
    ],
  };
}

function wikilinkNode(target, heading, alias, resolveLink) {
  const raw = String(target ?? "").trim();
  const resolved = resolveLink ? resolveLink(raw) : null;
  const label = alias ? alias.trim() : heading ? `${raw} › ${heading.trim()}` : raw;
  return {
    tag: resolved ? "a" : "span",
    attrs: {
      class: resolved ? "md-wikilink" : "md-wikilink is-missing",
      "data-target": raw,
      ...(heading ? { "data-heading": heading.trim() } : {}),
      ...(resolved ? { href: "#", role: "link" } : {}),
      ...(resolved ? {} : { title: raw }),
    },
    children: [textNode(label)],
  };
}

/**
 * Inline run → node list. `*` that is not a complete emphasis pair stays a
 * literal asterisk, which is what the vault's prose expects.
 */
export function parseInline(source, { resolveLink } = {}) {
  const nodes = [];
  let rest = String(source ?? "");
  const flush = (text) => {
    if (text) nodes.push(textNode(text));
  };
  while (rest.length > 0) {
    // Embeds first: `![[x]]` must not be read as an image plus a wikilink.
    const embed = /!\[\[([^\][]+)\]\]/.exec(rest);
    const match = INLINE_PATTERN.exec(rest);
    if (embed && (!match || embed.index <= match.index)) {
      flush(rest.slice(0, embed.index));
      nodes.push(embedNode(embed[1]));
      rest = rest.slice(embed.index + embed[0].length);
      continue;
    }
    if (!match) {
      flush(rest);
      break;
    }
    flush(rest.slice(0, match.index));
    const consumed = match[0];
    if (match[2] !== undefined) {
      nodes.push({ tag: "code", attrs: {}, children: [textNode(match[2].trim())] });
    } else if (match[3] !== undefined) {
      nodes.push(wikilinkNode(match[3], match[4], match[5], resolveLink));
    } else if (match[6] !== undefined) {
      const url = safeUrl(match[7]);
      const label = match[6] || match[7];
      nodes.push(
        url
          ? {
              tag: "a",
              attrs: { class: "md-external", href: url, rel: "noreferrer noopener", target: "_blank" },
              children: parseInline(label, { resolveLink }),
            }
          : textNode(label),
      );
    } else if (match[8] !== undefined) {
      nodes.push({ tag: "strong", attrs: {}, children: parseInline(match[8], { resolveLink }) });
    } else if (match[9] !== undefined) {
      nodes.push({ tag: "del", attrs: {}, children: parseInline(match[9], { resolveLink }) });
    } else if (match[10] !== undefined) {
      nodes.push({ tag: "em", attrs: {}, children: parseInline(match[10], { resolveLink }) });
    } else {
      // Any other match is ambiguous (for example `[x](javascript:…)`): the
      // source stays literal instead of being half-consumed.
      flush(consumed);
    }
    rest = rest.slice(match.index + consumed.length);
  }
  return nodes;
}

// ---- blocks ----

/** Strip the frontmatter block; the drawer already shows class and galaxy. */
export function stripFrontmatter(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  const match = FRONTMATTER.exec(source);
  return match ? source.slice(match[0].length) : source;
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function listItemKind(marker) {
  return /\d/.test(marker) ? "ol" : "ul";
}

/**
 * Parse the vault's Markdown subset into a node tree.
 *
 * @param {string} text
 * @param {{ resolveLink?: (target: string) => string|null }} [options]
 * @returns {{ tag: "root", attrs: {}, children: object[] }}
 */
export function parseMarkdown(text, { resolveLink } = {}) {
  const lines = stripFrontmatter(text).split("\n");
  const root = { tag: "root", attrs: {}, children: [] };
  let index = 0;

  const inline = (value) => parseInline(value, { resolveLink });

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence (or end of text)
      root.children.push({
        tag: "pre",
        attrs: { class: "md-pre" },
        children: [{ tag: "code", attrs: {}, children: [textNode(body.join("\n"))] }],
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(MAX_HEADING_LEVEL, heading[1].length + HEADING_SHIFT);
      root.children.push({
        tag: `h${level}`,
        attrs: { class: "md-heading" },
        children: inline(heading[2].trim()),
      });
      index += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      root.children.push({ tag: "hr", attrs: {}, children: [] });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(QUOTE.exec(lines[index])[1]);
        index += 1;
      }
      const first = quoted[0] ?? "";
      const callout = CALLOUT.exec(first.trim());
      if (callout) {
        const type = normalizeCalloutType(callout[1]);
        const title = callout[3].trim() || callout[1].toUpperCase();
        const body = quoted.slice(1).join("\n");
        root.children.push({
          tag: "div",
          attrs: { class: `md-callout callout-${type}`, "data-callout": type },
          children: [
            { tag: "div", attrs: { class: "md-callout-title" }, children: [textNode(title)] },
            {
              tag: "div",
              attrs: { class: "md-callout-body" },
              children: parseMarkdown(body, { resolveLink }).children,
            },
          ],
        });
        continue;
      }
      root.children.push({
        tag: "blockquote",
        attrs: { class: "md-quote" },
        children: parseMarkdown(quoted.join("\n"), { resolveLink }).children,
      });
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      const header = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim() !== "" && lines[index].includes("|")) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      root.children.push({
        tag: "table",
        attrs: { class: "md-table" },
        children: [
          {
            tag: "thead",
            attrs: {},
            children: [
              {
                tag: "tr",
                attrs: {},
                children: header.map((cell) => ({ tag: "th", attrs: {}, children: inline(cell) })),
              },
            ],
          },
          {
            tag: "tbody",
            attrs: {},
            children: rows.map((row) => ({
              tag: "tr",
              attrs: {},
              children: header.map((_, column) => ({
                tag: "td",
                attrs: {},
                children: inline(row[column] ?? ""),
              })),
            })),
          },
        ],
      });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { node, next } = parseList(lines, index, { resolveLink });
      root.children.push(node);
      index = next;
      continue;
    }

    // Paragraph: consecutive plain lines, soft-wrapped the way Markdown reads.
    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        current.trim() === "" ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        THEMATIC_BREAK.test(current) ||
        QUOTE.test(current) ||
        LIST_ITEM.test(current) ||
        (current.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]))
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    root.children.push({
      tag: "p",
      attrs: {},
      children: inline(paragraph.join(" ")),
    });
  }

  return root;
}

/**
 * One list at `start`, including its nested sublists. A task marker turns the
 * item into a disabled checkbox plus its text.
 */
function parseList(lines, start, { resolveLink }) {
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = first[1].length;
  const kind = listItemKind(first[2]);
  const ordered = kind === "ol";
  const items = [];
  let index = start;

  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match || match[1].length < baseIndent) break;
    if (match[1].length > baseIndent) {
      // A nested list belongs to the item just closed.
      const previous = items[items.length - 1];
      const nested = parseList(lines, index, { resolveLink });
      previous?.children.push(nested.node);
      index = nested.next;
      continue;
    }
    if (listItemKind(match[2]) !== kind) break;
    let body = match[3];
    const task = TASK_ITEM.exec(body);
    const children = [];
    if (task) {
      children.push({
        tag: "input",
        attrs: { type: "checkbox", disabled: true, class: "md-task", ...(task[1] !== " " ? { checked: true } : {}) },
        children: [],
      });
      body = task[2];
    }
    items.push({
      tag: "li",
      attrs: task ? { class: "md-task-item" } : {},
      children: [...children, ...parseInline(body, { resolveLink })],
    });
    index += 1;
  }

  return {
    node: {
      tag: ordered ? "ol" : "ul",
      attrs: { class: "md-list" },
      children: items,
    },
    next: index,
  };
}

// ---- DOM adapter ----

function setAttrs(element, attrs = {}) {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") element.className = String(value);
    else if (name === "checked") element.checked = true;
    else if (name === "disabled") element.disabled = true;
    else element.setAttribute(name, String(value));
  }
}

/**
 * Build DOM nodes for a parsed tree. Only element creation and `textContent`
 * are used; `onWikilink(target, heading, event)` and `onExternal(url, event)`
 * receive clicks.
 */
export function toDom(tree, handlers = {}) {
  const { onWikilink, onExternal, embedPrefix = "" } = handlers;
  const build = (node) => {
    if (typeof node === "string") return document.createTextNode(node);
    if (node.tag === "text") return document.createTextNode(node.text);
    if (node.tag === "root") {
      const fragment = document.createDocumentFragment();
      for (const child of node.children ?? []) fragment.appendChild(build(child));
      return fragment;
    }
    const element = document.createElement(node.tag === "input" ? "input" : node.tag);
    setAttrs(element, node.attrs);
    if (node.tag === "span" && node.attrs?.class === "md-embed") {
      const chip = document.createElement("span");
      setAttrs(chip, node.attrs);
      chip.textContent = `${embedPrefix}${node.attrs["data-embed"] ?? ""}`;
      chip.title = node.attrs["data-embed"] ?? "";
      return chip;
    }
    for (const child of node.children ?? []) element.appendChild(build(child));
    if (node.tag === "a") {
      const isWikilink = String(node.attrs?.class ?? "").split(" ").includes("md-wikilink");
      element.addEventListener("click", (event) => {
        event.preventDefault();
        if (isWikilink) onWikilink?.(node.attrs["data-target"] ?? "", node.attrs["data-heading"] ?? "", event);
        else onExternal?.(node.attrs.href ?? "", event);
      });
    }
    return element;
  };
  const root = build(tree);
  // A fragment cannot be returned as the drawer body: wrap it.
  if (root.nodeType === 11) {
    const container = document.createElement("div");
    container.className = "md-body";
    container.appendChild(root);
    return container;
  }
  return root;
}
