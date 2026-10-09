// OpenClaw 8.2 model-selection-config.ts:8-25 and 9.7 agent-scope-config.ts:109-120
// resolve defaults in the agent's scope (including acp-runtime). The plugin must pass
// the SDK result through rather than parse aliases, bare ids, or profiles itself.
export const modelCalls = [];
export const modelResults = new Map();

export function resolveDefaultModelForAgent(params) {
  modelCalls.push(params);
  const result = modelResults.get(params.agentId) ?? { provider: "fake", model: "default" };
  if (result instanceof Error) throw result;
  return result;
}
