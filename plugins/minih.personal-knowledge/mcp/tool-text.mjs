/**
 * Tool text and tool metadata shared by the two places a knowledge tool can
 * run (ADR 0003 §2).
 *
 * The MCP server answers the tools in its own process; in `host` mode the
 * plugin's main process registers the same retrieval tools through
 * `pi.agent.registerTool`, because only that process can turn a query into a
 * vector. Keeping names, schemas, and rendering here means the model sees one
 * tool either way, and the two paths cannot drift apart.
 */

import { estimateTokens } from "../lib/tokens.mjs";
import {
  CONTEXT_NEXT_STEP,
  renderContextNote,
  renderContextSection,
  vectorLabel,
} from "./context-text.mjs";

/** The tools the main process registers when vectors come from a host model. */
export const MAIN_PROCESS_TOOLS = ["knowledge_search", "conversation_search", "knowledge_context"];

export const TOOL_SCHEMAS = {
  knowledge_search: {
    description:
      "Search Markdown notes and `.base` dashboards in the local knowledge vault with exact, deterministic term matching and safe snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        scope: { type: "string", description: "Optional vault-relative folder scope." },
        mode: {
          type: "string",
          enum: ["ranked", "all", "any"],
          default: "ranked",
          description: "ranked fuses BM25F, local vectors, and the link graph (default); all/any keep exact literal matching.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        include: {
          type: "array",
          items: { type: "string", enum: ["conversations"] },
          description:
            "Add an excluded collection. \"conversations\" also searches archived conversation summaries (09 Conversations); they are left out by default.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  conversation_search: {
    description:
      "Search the archived conversation summaries of this project: session id, date, title, the computer that produced it, the goal, and the matching snippet. Use it for what was done before, why a decision was made, or where the last session stopped; read the transcript only when the exact wording or the operations matter.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        scope: {
          type: "string",
          enum: ["project", "all"],
          default: "project",
          description: "project searches the current repository's conversations; all searches every project.",
        },
        cwd: { type: "string", description: "Current working directory, used to pick the project for scope \"project\"." },
        limit: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  knowledge_context: {
    description:
      "Load the smallest relevant context pack from the user's knowledge vault (local Markdown, Obsidian-compatible) by matching a repository path and task topic. The default `navigate` mode returns each matched note's abstract and outline plus the sections that match `topic`; `full` returns the notes themselves. Call it before non-trivial work involving the user's projects, preferences, stack, infrastructure, or prior decisions.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Current repository or working-directory path." },
        topic: {
          type: "string",
          description: "Short task topic, including relevant aliases, domains, or IPs; in navigate mode it selects the sections returned.",
        },
        mode: {
          type: "string",
          enum: ["navigate", "full"],
          default: "navigate",
          description:
            "navigate (default) returns abstracts, outlines, and the sections that match topic; full returns the routed notes themselves.",
        },
        maxChars: { type: "integer", minimum: 4000, maximum: 100000 },
        sectionLimit: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "navigate only: how many sections to return (default 6).",
        },
        sectionChars: {
          type: "integer",
          minimum: 200,
          maximum: 10000,
          description: "navigate only: characters per section excerpt (default 2000).",
        },
      },
      additionalProperties: false,
    },
  },
};

/** `knowledge_search` as the model reads it. */
export function renderKnowledgeSearch(value) {
  return value.results.length
    ? value.results.map((item) => `${item.path} | score=${item.score}\n${item.snippet}`).join("\n\n")
    : "No matching knowledge notes found.";
}

/** `conversation_search` as the model reads it, always with the caveat. */
export function renderConversationSearch(value) {
  const header = `Scope: ${value.scope}${value.project ? ` (${value.project})` : ""} · ${value.count} match(es)\n${value.caveat}`;
  if (value.results.length === 0) return `${header}\n\nNo archived conversation matched.`;
  const rows = value.results.map(
    (item) =>
      `\n## ${item.title}\nSession: ${item.sessionId}\nDate: ${item.date} · Device: ${item.device} · Project: ${item.project || "—"}\nGoal: ${item.goal || "—"}\nMatched: ${item.matchedFields.join(", ")}\nSnippet: ${item.snippet}`,
  );
  return `${header}${rows.join("\n")}`;
}

/**
 * `knowledge_context` as the model reads it (ADR 0004 §5).
 *
 * `full` is the 0.7.2 text byte for byte. `navigate` names its own token
 * estimate in the mode line, so the text is rendered, measured, and rebuilt
 * until the number stops moving — it settles in two passes because only the
 * digits change. Either way the same estimate lands on `value.estimatedTokens`
 * for the structured result, so the two never disagree.
 */
export function renderKnowledgeContext(value) {
  if ((value.mode ?? "full") !== "navigate") {
    const text = renderFullContext(value);
    value.estimatedTokens = estimateTokens(text);
    return text;
  }
  let tokens = estimateTokens(renderNavigateContext(value, 0));
  for (let pass = 0; pass < 3; pass += 1) {
    const text = renderNavigateContext(value, tokens);
    const measured = estimateTokens(text);
    if (measured === tokens) {
      value.estimatedTokens = tokens;
      return text;
    }
    tokens = measured;
  }
  value.estimatedTokens = tokens;
  return renderNavigateContext(value, tokens);
}

/** The note block of `mode: "full"` — 0.7.2's rendering, unchanged. */
function renderFullContext(value) {
  const heading = [
    `Matched projects: ${value.matchedProjects.join(", ") || "none"}`,
    `Matched routes: ${value.matchedRoutes.join(", ") || "none"}`,
  ].join("\n");
  const notes = value.notes
    .map((note) => `\n## ${note.title}\nPath: ${note.path}\nVerified: ${note.metadata.verified || "unverified"}\n\n${note.content}`)
    .join("\n");
  return `${heading}${renderConversations(value)}${notes}`;
}

function renderNavigateContext(value, tokens) {
  const header = [
    `Matched projects: ${value.matchedProjects.join(", ") || "none"}`,
    `Matched routes: ${value.matchedRoutes.join(", ") || "none"}`,
    `Mode: navigate · Estimated tokens: ${tokens.toLocaleString("en-US")} · Vector: ${vectorLabel(value.retrieval)}`,
  ].join("\n");
  const blocks = [];
  const notes = value.notes ?? [];
  if (notes.length > 0) blocks.push(`## Notes\n${notes.map(renderContextNote).join("\n\n")}`);
  const sections = value.sections ?? [];
  if (value.topic) {
    const body = sections.length > 0
      ? sections.map(renderContextSection).join("\n\n")
      : "No section matched this topic.";
    blocks.push(`## Sections for "${value.topic}"\n${body}`);
  }
  blocks.push(CONTEXT_NEXT_STEP);
  return `${header}${renderConversations(value)}\n\n${blocks.join("\n\n")}`;
}

/** Recent archived conversations: titles and links only (ADR 0002 §5). */
function renderConversations(value) {
  if (!value.conversations?.count) return "";
  return [
    "",
    "## Recent conversations",
    `${value.conversationCaveat}`,
    ...(value.conversations.items ?? []).map(
      (item) => `- ${item.created} · ${item.title} · session ${item.sessionId}${item.goal ? ` — ${item.goal}` : ""}`,
    ),
    value.conversations.project ? `Project folder: ${value.conversations.project}` : "",
    "Ask conversation_search for more, or conversation_read with a session id.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Renderer for one of the main-process tools; `null` when it is not one. */
export function renderMainProcessTool(name, value) {
  if (name === "knowledge_search") return renderKnowledgeSearch(value);
  if (name === "conversation_search") return renderConversationSearch(value);
  if (name === "knowledge_context") return renderKnowledgeContext(value);
  return null;
}