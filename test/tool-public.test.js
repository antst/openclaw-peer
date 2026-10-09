// TW-P3b — public-surface tests for the `sessionbus` tool offer and lane voice
// (PLAN bus-0512, Test-writer stream). Spec: PLAN `## Interface` «Tool offer» (D7),
// «Bridge wire v1» (bus.action / rpc.cancel).
// The lane side runs against the real bridge the plugin starts (src/service.js → src/bridge.js):
// the test connects a worker over Bridge wire v1 at $SESSIONBUS_OPENCLAW_BRIDGE it sets itself.
import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPluginEntry } from "./support/openclaw-sdk.js";
import { createFakeHost } from "./support/fake-openclaw.js";
import { createFakeDaemon } from "./support/fake-daemon.js";

const AGENT = "advisor";
const SENDER = "other@host";
const OWNER_SESSION_KEY = `agent:${AGENT}:main`; // resolveConfig default binding sessionKey
const CHANNEL_SESSION_KEY = `agent:${AGENT}:sessionbus:direct:${SENDER}`;
// Lane key in the shape minted by the worker (Interface: `agent:<agentId>:sb-<uuid>`).
const LANE_KEY = "agent:advisor:sb-123e4567-e89b-42d3-a726-446655440000";

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Minimal JSON-lines worker speaking Bridge wire v1 (client side of the plugin's bridge). */
class Worker {
  static connect(socketPath) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => resolve(new Worker(socket)));
      socket.once("error", reject);
    });
  }
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.next = 0;
    this.waiters = new Map();
    this.incoming = [];
    this.incomingWaiters = [];
    this.unsolicited = [];
    this.closed = new Promise((resolve) => socket.once("close", resolve));
    socket.on("data", (chunk) => this.#data(chunk));
  }
  #data(chunk) {
    this.buffer += chunk;
    for (let nl; (nl = this.buffer.indexOf("\n")) >= 0;) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (typeof frame.method === "string") {
        if (this.incomingWaiters.length) this.incomingWaiters.shift()(frame);
        else this.incoming.push(frame);
      } else if (this.waiters.has(frame.id)) {
        const waiter = this.waiters.get(frame.id);
        this.waiters.delete(frame.id);
        if (frame.error) {
          const error = new Error(frame.error.message ?? frame.error.code);
          error.code = frame.error.code;
          waiter.reject(error);
        } else waiter.resolve(frame.result);
      } else this.unsolicited.push(frame);
    }
  }
  request(method, params) {
    const id = `w:${++this.next}`;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ v: 1, id, method, params })}\n`);
    });
  }
  reply(frame, result) {
    this.socket.write(`${JSON.stringify({ v: 1, id: frame.id, result })}\n`);
  }
  nextIncoming() {
    return this.incoming.length
      ? Promise.resolve(this.incoming.shift())
      : new Promise((resolve) => this.incomingWaiters.push(resolve));
  }
}

function busConfig(pluginConfigOverrides = {}, overrides = {}) {
  return {
    agents: { entries: { advisor: {} } },
    channels: { sessionbus: { enabled: true } },
    plugins: {
      entries: {
        sessionbus: {
          config: {
            socket: "/tmp/fake.sock",
            agents: { advisor: { enabled: true, groups: ["g"] } },
            lanes: {
              agents: { advisor: { description: "the advisor lane" } },
              credentialDir: "/creds",
            },
            ...pluginConfigOverrides,
          },
        },
      },
    },
    ...overrides,
  };
}

function senderRequest(overrides = {}) {
  return {
    message_id: "m1",
    from: { session_id: SENDER, product: "claude-peer", groups: ["g"] },
    body: "hello from the federation",
    ...overrides,
  };
}

/**
 * Fake host + fake daemon + the plugin's real bridge listening on a private
 * $SESSIONBUS_OPENCLAW_BRIDGE. Returns the connected worker double after
 * `lane.register` of LANE_KEY.
 */
async function startedFixture(t, config = busConfig()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-public-"));
  const bridgePath = path.join(dir, "bridge.sock");
  const savedBridgeEnv = process.env.SESSIONBUS_OPENCLAW_BRIDGE;
  const savedStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.SESSIONBUS_OPENCLAW_BRIDGE = bridgePath;
  process.env.OPENCLAW_STATE_DIR = path.join(dir, "state");

  const daemon = createFakeDaemon();
  const host = createFakeHost({ config, version: "2026.8.2", connect: (p) => daemon.connect(p) });
  t.after(() => {
    if (savedBridgeEnv === undefined) delete process.env.SESSIONBUS_OPENCLAW_BRIDGE;
    else process.env.SESSIONBUS_OPENCLAW_BRIDGE = savedBridgeEnv;
    if (savedStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = savedStateDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.after(() => host.stop());

  host.register(await loadPluginEntry());
  await host.start();
  await host.startChannel();
  await waitFor(() => daemon.hellos.length === 1);

  const worker = await Worker.connect(bridgePath);
  assert.deepEqual(
    await worker.request("lane.register", { sessionKey: LANE_KEY, agentId: AGENT, acpSessionId: "acp-1" }),
    { ready: true },
  );
  return { daemon, host, worker, bridgePath };
}

// ---------------------------------------------------------------- tool offer (D7)

test("tool offer: owner key, recorded channel route, live lane registration, nothing else", async (t) => {
  const { daemon, host } = await startedFixture(t);

  // (a) the owner's bound session key (resolveConfig default binding)
  const ownerTool = host.tool({ agentId: AGENT, sessionKey: OWNER_SESSION_KEY });
  assert.ok(ownerTool, "the tool must be offered in the owner session key");
  assert.equal(ownerTool.name, "sessionbus");

  // (b) a channel route recorded by a bus delivery to this agent (D7 source 2)
  const receipt = await daemon.deliver(senderRequest({ message_id: "offer-1" }));
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 1);
  assert.equal(host.runtime.dispatches[0].sessionKey, CHANNEL_SESSION_KEY);
  const channelTool = host.tool({ agentId: AGENT, sessionKey: CHANNEL_SESSION_KEY });
  assert.ok(channelTool, "the tool must be offered in the recorded channel route key");
  assert.equal(channelTool.name, "sessionbus");
  await host.release(CHANNEL_SESSION_KEY);

  // (c) a live lane registration on the bridge (D7 source 3): offered in the lane's own key
  const laneTool = host.tool({ agentId: AGENT, sessionKey: LANE_KEY });
  assert.ok(laneTool, "the tool must be offered in the lane-registered session key");
  assert.equal(laneTool.name, "sessionbus");

  // (d) nothing else: unbound keys and other agents get no tool at all
  assert.equal(host.tool({ agentId: AGENT, sessionKey: "agent:advisor:telegram:direct:123" }), undefined);
  assert.equal(
    host.tool({ agentId: AGENT, sessionKey: "agent:advisor:sb-123e4567-e89b-42d3-a726-446655440fff" }),
    undefined,
    "a lane key without a live bridge registration must not offer the tool",
  );
  assert.equal(host.tool({ agentId: "other", sessionKey: "agent:other:main" }), undefined);
});

// ---------------------------------------------------------------- lane voice through the bridge

test("lane action goes through the bridge connection and cancels on abort", async (t) => {
  const { host, worker } = await startedFixture(t);
  const tool = host.tool({ agentId: AGENT, sessionKey: LANE_KEY });
  assert.ok(tool, "the tool must be offered in the lane-registered session key");

  // A lane action is a bus.action on the lane's bridge connection (Interface «Tool offer»).
  const call = tool.execute("call1", { action: "list", arguments: {} });
  const frame = await worker.nextIncoming();
  assert.equal(frame.method, "bus.action");
  assert.match(frame.id, /^p:/);
  assert.deepEqual(frame.params, { action: "list", arguments: {} });
  worker.reply(frame, { result: { self_info: { session_id: "lane-1" }, sessions: [] } });
  const result = await call;
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), { self_info: { session_id: "lane-1" }, sessions: [] });

  // An aborting call: the plugin answers rpc.cancel for exactly that request id, the
  // tool surfaces the abort reason instead of hanging.
  const controller = new AbortController();
  const abortReason = new Error("lane gave up waiting");
  const cancelled = tool.execute("call2", { action: "wait", arguments: { session_id: "lane-1" } }, controller.signal);
  const pendingFrame = await worker.nextIncoming();
  assert.equal(pendingFrame.method, "bus.action");
  assert.deepEqual(pendingFrame.params, { action: "wait", arguments: { session_id: "lane-1" } });
  controller.abort(abortReason);
  const outcome = await cancelled;
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /lane gave up waiting/);
  const cancelFrame = await worker.nextIncoming();
  assert.equal(cancelFrame.method, "rpc.cancel");
  assert.deepEqual(cancelFrame.params, { id: pendingFrame.id });
});
