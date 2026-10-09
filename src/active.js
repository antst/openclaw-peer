// OpenClaw runs register() more than once per process: the Gateway registry starts the
// service, while tool discovery loads the plugin again with activate:false and never starts
// it (openclaw-v2026.8.2 src/plugins/tools.ts:1230-1233). A later load may also be a fresh
// module instance, so the started service is published on globalThis, not in module scope.
const KEY = Symbol.for("openclaw-sessionbus-peer.activeService");

/** Marks `service` as the process's started service. */
export function setActiveService(service) {
  globalThis[KEY] = service;
}

/** Clears the slot only if `service` still owns it. */
export function clearActiveService(service) {
  if (globalThis[KEY] === service) delete globalThis[KEY];
}

/** `service` itself when it was started, else the process's started service, else `service`. */
export function resolveService(service) {
  if (service.started) return service;
  return globalThis[KEY] ?? service;
}

// The channel runtime (what `startAccount` receives) belongs to the Gateway process, not to one plugin
// generation: 8.2 swaps every plugin's service on any `plugins.*` hot reload but restarts only the channels
// whose own entry changed, so the new service must find the runtime the running channel already attached.
const CHANNEL = Symbol.for("openclaw-sessionbus-peer.channelRuntime");
const channelState = () => (globalThis[CHANNEL] ??= { rt: null, waiters: [] });

export function attachChannelRuntime(rt) {
  const state = channelState();
  state.rt = rt;
  const waiters = state.waiters;
  state.waiters = [];
  for (const resolve of waiters) resolve(rt);
}

/** Clears the slot only if `rt` is still the attached runtime (a newer startAccount may have replaced it). */
export function detachChannelRuntime(rt) {
  const state = channelState();
  if (state.rt === rt) state.rt = null;
}

/** The attached channel runtime; waits up to `timeoutMs` for startAccount, else null. */
export function channelRuntimeReady(timeoutMs) {
  const state = channelState();
  if (state.rt) return Promise.resolve(state.rt);
  return new Promise((resolve) => {
    const waiter = (rt) => {
      clearTimeout(timer);
      resolve(rt);
    };
    const timer = setTimeout(() => {
      state.waiters = state.waiters.filter((item) => item !== waiter);
      resolve(null);
    }, timeoutMs);
    state.waiters.push(waiter);
  });
}

/** Test helper: forget any attached runtime and waiters. */
export function resetChannelRuntimeForTest() {
  delete globalThis[CHANNEL];
}

// Dedupe ledgers and recorded channel routes belong to the same lifetime as the channel runtime: a plugin generation
// swap replaces the service but not the running channel, and the old dispatches keep running, so a retransmission after
// the swap must still find its ledger entry and the backlog counter must still count them. Keyed by the attached
// channel runtime (a new startAccount, i.e. a real channel restart, starts clean). The WeakMap lives on globalThis for
// the same reason as the slot above.
const SHARED = Symbol.for("openclaw-sessionbus-peer.channelState");

/** The attached channel runtime right now, or null (no waiting). */
export function currentChannelRuntime() {
  return channelState().rt;
}

/** {ledgers: Map<agentId, ledger>, routes: Map<agentId, Set<sessionKey>>} of one channel runtime. */
export function sharedChannelState(rt) {
  const states = (globalThis[SHARED] ??= new WeakMap());
  if (!states.has(rt)) states.set(rt, { ledgers: new Map(), routes: new Map() });
  return states.get(rt);
}
