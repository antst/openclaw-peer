import path from "node:path";

export function resolveAgentWorkspaceDir(cfg, agentId, env) {
  if (!cfg || typeof cfg !== "object" || typeof agentId !== "string" || !env || typeof env !== "object") throw new TypeError("fake health: expected cfg, agentId, env");
  if (!Object.hasOwn(cfg.agents?.entries ?? {}, agentId)) throw new Error(`unknown agent ${agentId}`);
  const explicit = cfg.agents.entries[agentId].workspace;
  if (explicit) return path.resolve(explicit);
  const fallback = cfg.agents.defaults?.workspace;
  if (fallback) return path.join(path.resolve(fallback), agentId);
  return path.join(env.OPENCLAW_STATE_DIR, `workspace-${agentId}`);
}
