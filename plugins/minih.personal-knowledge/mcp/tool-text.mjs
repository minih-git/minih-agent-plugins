/**
 * Tool text and tool metadata shared by the two places a knowledge tool can
 * run (ADR 0003 §2).
 *
 * The MCP server answers the tools in its own process; in `host` mode the
 * plugin's main process registers the same two retrieval tools through
 * `pi.agent.registerTool`, because only that process can turn a query into a
 * vector. Keeping names, schemas, and rendering here means the model sees one
 * tool either way, and the two paths cannot drift apart.
 */

/** The tools the main process registers when vectors come from a host model. */
export const MAIN_PROCESS_TOOLS = ["knowledge_search", "conversation_search"];

export const TOOL_SCHEMAS = {
  knowledge_search: {
    description:
      "Search Markdown notes and Obsidian Bases in the local knowledge vault with exact, deterministic term matching and safe snippets.",
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

/** Renderer for one of the main-process tools; `null` when it is not one. */
export function renderMainProcessTool(name, value) {
  if (name === "knowledge_search") return renderKnowledgeSearch(value);
  if (name === "conversation_search") return renderConversationSearch(value);
  return null;
}
