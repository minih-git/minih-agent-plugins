import { KnowledgeService } from "../../mcp/knowledge-core.mjs";

const initialize = KnowledgeService.prototype.initialize;
let attempt = 0;

// A real service still reads the isolated vault once the parent releases it.
KnowledgeService.prototype.initialize = async function (...args) {
  const id = ++attempt;
  const decision = new Promise((resolve) => {
    const listener = (message) => {
      if (message?.attempt !== id) return;
      process.off("message", listener);
      resolve(message.action);
    };
    process.on("message", listener);
  });
  process.send({ phase: "scan", attempt: id });
  if (await decision === "fail") throw new Error("temporary vault scan failure");
  return initialize.apply(this, args);
};
