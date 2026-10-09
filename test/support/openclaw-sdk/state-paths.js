import path from "node:path";

export function resolveStateDir(env) {
  if (!env || typeof env !== "object" || !env.OPENCLAW_STATE_DIR) throw new Error("fake state-paths: OPENCLAW_STATE_DIR required");
  return path.resolve(env.OPENCLAW_STATE_DIR);
}
