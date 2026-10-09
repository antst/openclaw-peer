import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFakeDaemon } from "./support/fake-daemon.js";
import { createFakeRuntime, createStrictLogger } from "./support/fake-openclaw.js";
import { resolveDefaultModelForAgent } from "./support/openclaw-sdk/agent-runtime.js";
import { createPeerService } from "../src/service.js";
import { createToolFactory } from "../src/tool.js";

// The plugin side of a lane's bus voice, over the worker bridge: a session whose key a worker registered
// on the bridge gets the `sessionbus` tool, and its calls run in that worker as `bus.action`.
// The static interactive binding is unchanged.

const ADVISOR_KEY = "agent:advisor:main";
const SELF_ID = "openclaw-advisor@testhost";
const LANE_KEY = "agent:lane:sb-3f2b8c1e-7a4d-4e21-9b6f-0c5d8e7a1b24";

/** A raw bridge worker that registers `key` and answers `bus.action` through `onAction`. */
async function worker(t, socketPath, { key = LANE_KEY, onAction } = {}) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  await new Promise((resolve) => socket.once("connect", resolve));
  t.after(() => socket.destroy());
  const actions = [];
  let buffer = "";
  const waiting = new Map();
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (frame.method === "bus.action") {
        actions.push(frame.params);
        const body = onAction(frame.params);
        socket.write(`${JSON.stringify({ v: 1, id: frame.id, ...body })}\n`);
      } else if (waiting.has(frame.id)) waiting.get(frame.id)(frame);
    }
  });
  socket.write(`${JSON.stringify({ v: 1, id: "w:1", method: "lane.register", params: { sessionKey: key, agentId: "lane", acpSessionId: "acp" } })}\n`);
  const reply = await new Promise((resolve) => waiting.set("w:1", resolve));
  assert.deepEqual(reply.result, { ready: true });
  return { actions };
}

function answer({ action, arguments: args }) {
  if (action === "list") {
    return { result: { result: { self_info: { session_id: `${LANE_KEY}@testhost`, product: "openclaw-peer", groups: ["g"] }, sessions: [{ session_id: "parent@testhost", kind: "peer", product: "claude-peer", groups: ["g"], connected: true, running: false }] } } };
  }
  if (action === "send") {
    return { result: { result: { message_id: "lane-msg", deliveries: [{ target: args.target, session_id: "parent@testhost", delivery_id: "d1", disposition: "written" }] } } };
  }
  return { error: { code: "action_failed", message: "unknown action" } };
}

async function fixture(t, { botLoopProtection } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, "d", "bridge.sock");
  const daemon = createFakeDaemon({
    list: () => ({
      self_info: { session_id: SELF_ID, product: "openclaw-peer", groups: ["g"] },
      sessions: [{ session_id: SELF_ID, kind: "peer", product: "openclaw-peer", groups: ["g"], connected: true, running: false }],
    }),
  });
  const runtime = createFakeRuntime({
    version: "2026.8.2",
    config: {
      agents: { entries: { advisor: {}, lane: {} } },
      channels: botLoopProtection ? { defaults: { botLoopProtection } } : undefined,
      plugins: { entries: { sessionbus: { config: {
        socket: "/tmp/fake.sock",
        agents: { advisor: { enabled: true, groups: ["g"], sessionKey: ADVISOR_KEY } },
        lanes: { agents: { lane: {} }, credentialDir: "/c" },
      } } } },
    },
  });
  const service = createPeerService({ runtime }, {
    connect: (p) => daemon.connect(p),
    schedule: (call) => call(),
    env: { SESSIONBUS_OPENCLAW_BRIDGE: socketPath },
    uid: 1000,
    harness: { resolveActiveEmbeddedRunSessionId: () => undefined, queueAgentHarnessMessage: () => false },
    lanes: { resolveStateDir: () => dir, resolveAgentWorkspaceDir: () => "/w", resolveDefaultModelForAgent },
  });
  t.after(() => service.stop());
  await service.start({ logger: createStrictLogger() });
  await service.peerFor("advisor").ready;
  return { daemon, service, socketPath, factory: createToolFactory(service) };
}

function parsed(result) {
  assert.notEqual(result.isError, true, `tool error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

test("a registered lane key gets the sessionbus tool; calls run in its worker", async (t) => {
  const { factory, socketPath } = await fixture(t);
  assert.equal(factory({ agentId: "lane", sessionKey: LANE_KEY }), null, "no tool before the worker registers");
  const w = await worker(t, socketPath, { onAction: answer });
  const tool = factory({ agentId: "lane", sessionKey: LANE_KEY });
  assert.ok(tool);
  assert.equal(tool.name, "sessionbus");
  const listed = parsed(await tool.execute("c1", { action: "list", arguments: {} }));
  assert.equal(listed.self_info.session_id, `${LANE_KEY}@testhost`);
  assert.deepEqual(w.actions[0], { action: "list", arguments: {} });
  const sent = parsed(await tool.execute("c2", { action: "send", arguments: { target: "parent@testhost", message: "from the lane" } }));
  assert.equal(sent.message_id, "lane-msg");
  assert.equal(w.actions.filter((a) => a.action === "send").length, 1);
});

test("the send-loop guard applies on the lane path: budget 1, the second send is refused before the worker", async (t) => {
  const { factory, socketPath } = await fixture(t, { botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 } });
  const w = await worker(t, socketPath, { onAction: answer });
  const tool = factory({ agentId: "lane", sessionKey: LANE_KEY });
  parsed(await tool.execute("c1", { action: "send", arguments: { target: "parent@testhost", message: "one" } }));
  const second = await tool.execute("c2", { action: "send", arguments: { target: "parent@testhost", message: "two" } });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /loop guard/);
  assert.equal(w.actions.filter((a) => a.action === "send").length, 1, "the refused send reached the worker");
});

test("a worker error frame comes back as a tool error naming its message", async (t) => {
  const { factory, socketPath } = await fixture(t);
  await worker(t, socketPath, { onAction: answer });
  const tool = factory({ agentId: "lane", sessionKey: LANE_KEY });
  const result = await tool.execute("c1", { action: "status", arguments: { session_id: "x" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown action/);
});

test("the interactive static binding resolves exactly as before, with a lane registered", async (t) => {
  const { daemon, factory, socketPath } = await fixture(t);
  const w = await worker(t, socketPath, { onAction: answer });
  const tool = factory({ agentId: "advisor", sessionKey: ADVISOR_KEY });
  assert.ok(tool);
  assert.equal(parsed(await tool.execute("c1", { action: "list", arguments: {} })).self_info.session_id, SELF_ID);
  assert.ok(daemon.lists.length >= 1);
  assert.equal(w.actions.length, 0, "the static binding went to a lane worker");
  assert.equal(factory({ agentId: "advisor", sessionKey: "agent:advisor:other" }), null);
});
