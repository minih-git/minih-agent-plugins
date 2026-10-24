/**
 * Personal Knowledge plugin backend.
 *
 * The plugin is declarative: the host starts the bundled MCP server itself
 * (contributes.mcpServers) and indexes the bundled skills
 * (contributes.skills), so this module owns nothing and exposes no hooks. It
 * exists because the manifest schema requires an entry point; it returns a
 * small descriptor so a load error can never come from missing exports.
 */
module.exports = {
  name: "personal-knowledge",
  declarative: true,
};
