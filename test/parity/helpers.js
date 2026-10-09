// Shared parity harness. Not a test file: the `test/parity/*.test.js` glob skips it.
//
// Builds the plugin exactly as the host does — the repo's index.js loaded through the
// openclaw/plugin-sdk shims onto a fake host — and connects it over a real unix
// socket to the fake daemon. Tests see only the public surface: the tool's
// `execute`, the fake daemon's request log and lane state, and the host's
// channel dispatches (what the agent is asked to do next).
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createFakeDaemon, CODES, DaemonError, rawResult, completionPointer } from "../support/fake-daemon.js";
import { createFakeHost } from "../support/fake-openclaw.js";
import { loadPluginEntry } from "../support/openclaw-sdk.js";

export { CODES, DaemonError, rawResult, completionPointer };

export const HOST = "testhost";
export const REMOTE_HOST = "host-b";

let socketSeq = 0;

export function sessionKeyFor(agentId) {
  return `agent:${agentId}:main`;
}

/** The daemon-qualified peer id the plugin's agent holds on the bus. */
export function selfIdFor(agentId, host = HOST) {
  return `openclaw-${agentId}@${host}`;
}

export async function until(predicate, { timeoutMs = 3000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function text(result) {
  return result?.content?.[0]?.text ?? "";
}

/** Parse a successful tool result's JSON text; fails loudly on a tool error. */
export function json(result) {
  if (result?.isError) throw new Error(`tool error: ${text(result)}`);
  return JSON.parse(text(result));
}

/**
 * @param {object} [options]
 * @param {Array<{id:string, groups:string[], name?:string, sessionKey?:string}>} [options.agents] bound agents (default one: advisor in ["g"])
 * @param {object} [options.scripted] fake daemon script (see test/support/fake-daemon.js)
 * @param {object} [options.daemon] fake daemon options (worker, products, …)
 * @param {boolean|object} [options.remote] link a second fake daemon on host "host-b" (object = its options)
 * @param {object} [options.botLoopProtection] channels.defaults.botLoopProtection
 * @param {boolean} [options.snapshot] also register an `activate:false` tool-discovery snapshot
 * @param {boolean} [options.start] start plugin services (default true)
 */
export async function createParity(options = {}) {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "oc-parity-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  // Each harness gets its own bridge endpoint so parallel test files never share the default one.
  const previousBridge = process.env.SESSIONBUS_OPENCLAW_BRIDGE;
  process.env.SESSIONBUS_OPENCLAW_BRIDGE = path.join(stateDir, "bridge", "bridge.sock");
  const restoreState = () => {
    try {
      if (previousBridge === undefined) delete process.env.SESSIONBUS_OPENCLAW_BRIDGE;
      else process.env.SESSIONBUS_OPENCLAW_BRIDGE = previousBridge;
      rmSync(stateDir, { recursive: true, force: true });
    } finally {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  };
  let daemon;
  let remote = null;
  let host;
  try {
    const agents = options.agents ?? [{ id: "advisor", groups: ["g"] }];
    const socket = path.join(os.tmpdir(), `oc-parity-${process.pid}-${++socketSeq}.sock`);
    daemon = createFakeDaemon(options.scripted ?? {}, { host: HOST, ...(options.daemon ?? {}) });
    await daemon.listen(socket);
    if (options.remote) {
      remote = createFakeDaemon({}, { host: REMOTE_HOST, ...(typeof options.remote === "object" ? options.remote : {}) });
      daemon.link(remote);
    }
    const bindings = {};
    for (const agent of agents) {
      bindings[agent.id] = { enabled: true, groups: agent.groups, sessionKey: agent.sessionKey ?? sessionKeyFor(agent.id), ...(agent.name ? { name: agent.name } : {}) };
    }
    const config = {
      agents: { entries: Object.fromEntries(agents.map((agent) => [agent.id, {}])) },
      channels: { sessionbus: { enabled: true }, ...(options.botLoopProtection ? { defaults: { botLoopProtection: options.botLoopProtection } } : {}) },
      plugins: { entries: { sessionbus: { enabled: true, config: { socket, agents: bindings } } } },
    };
    host = createFakeHost({ config });
    const entry = await loadPluginEntry();
    host.register(entry);
    if (options.snapshot) host.register(entry, { activate: false });

    const harness = {
      daemon,
      remote,
      host,
      runtime: host.runtime,
      socket,
      agents,
      /** Every request the fake daemon(s) received, in order: {method, params, session_id}. */
      get requests() {
        return [...daemon.requests, ...(remote ? remote.requests : [])];
      },
      requestsFor(method) {
        return harness.requests.filter((request) => request.method === method);
      },
      /** Channel turns the host was asked to run: {sessionKey, ctxPayload, steered}. */
      dispatches() {
        return host.runtime.dispatches;
      },
      sessionKey(agentId = agents[0].id) {
        return bindings[agentId].sessionKey;
      },
      selfId(agentId = agents[0].id) {
        return selfIdFor(agentId);
      },
      async start() {
        await host.start();
        host.startChannel();
        await until(() => agents.every((agent) => daemon.hellos.some((hello) => hello.session_id === `openclaw-${agent.id}`)), { what: "plugin hello" });
        // Let the hello result reach the peer before the first call.
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      /** The tool the host offers this agent in its bound session (undefined when none). */
      tool(agentId = agents[0].id, ctx = {}, resolveOptions) {
        return host.tool({ agentId, sessionKey: bindings[agentId]?.sessionKey ?? sessionKeyFor(agentId), ...ctx }, "sessionbus", resolveOptions);
      },
      /** Call the tool: `execute(action, args, {agent, signal})`; raw params when `action` is an object. */
      async execute(action, args = {}, { agent, signal, toolCallId = "call" } = {}) {
        const tool = harness.tool(agent ?? agents[0].id);
        if (!tool) throw new Error(`no sessionbus tool offered to ${agent ?? agents[0].id}`);
        const params = typeof action === "object" && action !== null ? action : { action, arguments: args };
        return tool.execute(toolCallId, params, signal);
      },
      /** Like execute but returns the parsed JSON result; throws on a tool error. */
      async call(action, args = {}, opts) {
        return json(await harness.execute(action, args, opts));
      },
      /** Deliver a bus message to an agent as the daemon would (message.deliver). */
      async deliver(agentId, from, body) {
        return daemon.deliverTo(`openclaw-${agentId}`, { message_id: `message-${Date.now()}`, from, body });
      },
      async close() {
        try {
          await host.stop().catch(() => {});
          await daemon.close();
          if (remote) await remote.close();
        } finally {
          restoreState();
        }
      },
    };
    if (options.start !== false) await harness.start();
    return harness;
  } catch (error) {
    try {
      await host?.stop().catch(() => {});
      await Promise.allSettled([daemon?.close(), remote?.close()]);
    } finally {
      restoreState();
    }
    throw error;
  }
}
