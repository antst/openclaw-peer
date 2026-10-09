// Shim for `openclaw/plugin-sdk/agent-harness-runtime`: stubs that record their calls.
// `harnessStub.active` maps sessionKey → sessionId; `harnessStub.accept` is queueAgentHarnessMessage's result.
export const harnessCalls = { resolve: [], queue: [] };
export const harnessStub = { active: new Map(), accept: true };

export function resolveActiveEmbeddedRunSessionId(sessionKey) {
  harnessCalls.resolve.push(sessionKey);
  return harnessStub.active.get(sessionKey);
}

export function queueAgentHarnessMessage(sessionId, text) {
  harnessCalls.queue.push({ sessionId, text });
  return harnessStub.accept;
}
