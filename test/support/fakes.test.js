// Self-test of the fakes (not part of the `test/*.test.js` suite glob).
// Run: node --test --test-reporter=tap test/support/fakes.test.js
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import kit from "@sessionbus/kit";
import { createFakeDaemon, completionPointer, CODES, DaemonError, rawResult } from "./fake-daemon.js";
import { createFakeHost } from "./fake-openclaw.js";
import { loadPluginEntry } from "./openclaw-sdk.js";

const { connectPeer } = kit;

function peer(daemon, sessionId, groups, name) {
  const hello = { protocol: 1, product: "openclaw-peer", session_id: sessionId, groups, info: {} };
  if (name) hello.name = name;
  const deliveries = [];
  const handle = connectPeer(
    hello,
    // kit sdk/js/index.js:254 — deliver(signal, params, identity)
    async (_signal, params) => {
      deliveries.push(params);
      return { disposition: "queued_for_next_turn" };
    },
    { SESSIONBUS_SOCKET: "/tmp/fake.sock" },
    { connect: (p) => daemon.connect(p) },
  );
  return { handle, deliveries };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("until timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("list: group visibility, self_info with private group", async () => {
  const daemon = createFakeDaemon();
  const a = peer(daemon, "a", ["g"]);
  const b = peer(daemon, "b", ["g"]);
  const c = peer(daemon, "c", ["other"]);
  await Promise.all([a.handle.ready, b.handle.ready, c.handle.ready]);
  const listed = await a.handle.caller.action("list", {});
  assert.deepEqual(listed.self_info, { session_id: "a@testhost", product: "openclaw-peer", groups: ["g", "session:a@testhost"] });
  assert.deepEqual(listed.sessions.map((row) => row.session_id), ["a@testhost", "b@testhost"]);
  await assert.rejects(a.handle.caller.action("list", { session_id: "c" }), (error) => error.code === CODES.unknown_session);
  for (const p of [a, b, c]) p.handle.shutdown();
});

test("send: receipts, delivery to a connected peer, unknown target rejected", async () => {
  const daemon = createFakeDaemon();
  const a = peer(daemon, "a", ["g"]);
  const b = peer(daemon, "b", ["g"]);
  await Promise.all([a.handle.ready, b.handle.ready]);
  const receipt = await a.handle.caller.action("send", { targets: ["b", "nobody"], message: "hi" });
  assert.match(receipt.message_id, /^message-[a-z0-9]{12}$/);
  assert.equal(receipt.deliveries[0].session_id, "b@testhost");
  assert.equal(receipt.deliveries[0].disposition, "queued_for_next_turn");
  assert.deepEqual(receipt.deliveries[1], { target: "nobody", disposition: "rejected", reason: "unknown_session" });
  assert.equal(b.deliveries[0].body, "hi");
  assert.equal(b.deliveries[0].from.session_id, "a@testhost");
  a.handle.shutdown();
  b.handle.shutdown();
});

test("spawn → start → pointer → wait → ack → auto-close; lane groups and owner-only visibility", async () => {
  const daemon = createFakeDaemon();
  const owner = peer(daemon, "owner", ["g"]);
  const other = peer(daemon, "other", ["g"]);
  await Promise.all([owner.handle.ready, other.handle.ready]);
  const spawned = await owner.handle.caller.action("spawn", { name: "w", product: "claude-peer", open: {} });
  assert.equal(spawned.policy.auto_close_ms, 60000);
  assert.equal(spawned.policy.owner_session_id, "owner@testhost");
  assert.equal(spawned.policy.trace, "off");
  const lane = daemon.lane(spawned.session_id);
  assert.deepEqual(lane.row.groups, ["session:owner@testhost", "session:owner@testhost/w"]);
  assert.equal(lane.row.name, "/w@testhost");
  assert.ok((await owner.handle.caller.action("list", {})).sessions.some((row) => row.session_id === spawned.session_id));
  assert.ok(!(await other.handle.caller.action("list", {})).sessions.some((row) => row.session_id === spawned.session_id));

  const ref = await owner.handle.caller.action("start", { session_id: spawned.session_id, input: "marker-123" });
  await until(() => owner.deliveries.length === 1);
  assert.equal(owner.deliveries[0].body, completionPointer(spawned.session_id, ref.run_id, "done"));
  assert.equal(owner.deliveries[0].from.session_id, spawned.session_id);
  const status = await owner.handle.caller.action("wait", { session_id: spawned.session_id, run_id: ref.run_id });
  assert.deepEqual(status.result, { outcome: "completed", result: "marker-123" });
  await owner.handle.caller.action("ack", ref);
  await assert.rejects(owner.handle.caller.action("status", ref), (error) => error.code === CODES.unknown_session);

  await owner.handle.caller.action("start", { session_id: spawned.session_id, input: "again" });
  await until(() => owner.deliveries.length === 2);
  await daemon.advance(60000);
  assert.equal(daemon.lane(spawned.session_id).row.connected, false);
  await assert.rejects(owner.handle.caller.action("status", { session_id: spawned.session_id }), (error) => error.code === CODES.not_connected);
  owner.handle.shutdown();
  other.handle.shutdown();
});

test("manual worker: busy while running, interrupt, not_running after", async () => {
  const daemon = createFakeDaemon({}, { worker: "manual" });
  const owner = peer(daemon, "owner", ["g"]);
  await owner.handle.ready;
  const { session_id } = await owner.handle.caller.action("spawn", { name: "w", product: "claude-peer", open: {}, auto_close_ms: 0 });
  await owner.handle.caller.action("start", { session_id, input: "x" });
  await assert.rejects(owner.handle.caller.action("start", { session_id, input: "y" }), (error) => error.code === CODES.busy);
  const waiting = owner.handle.caller.action("wait", { session_id });
  const status = await owner.handle.caller.action("status", { session_id });
  assert.equal(status.state, "running");
  await owner.handle.caller.action("interrupt", { session_id });
  assert.equal((await waiting).result.outcome, "interrupted");
  await assert.rejects(owner.handle.caller.action("interrupt", { session_id }), (error) => error.code === CODES.not_running);
  await owner.handle.caller.action("forget", { session_id });
  assert.equal(daemon.lane(session_id), undefined);
  owner.handle.shutdown();
});

test("host forwarding: spawn on a linked daemon, pointer comes back to the owner", async () => {
  const local = createFakeDaemon({}, { host: "host-a" });
  const remote = createFakeDaemon({}, { host: "host-b" });
  local.link(remote);
  const owner = peer(local, "owner", ["g"]);
  await owner.handle.ready;
  const spawned = await owner.handle.caller.action("spawn", { name: "w", product: "claude-peer", open: {}, host: "host-b" });
  assert.match(spawned.session_id, /@host-b$/);
  assert.ok(remote.lane(spawned.session_id));
  const ref = await owner.handle.caller.action("start", { session_id: spawned.session_id, input: "x" });
  await until(() => owner.deliveries.length === 1);
  assert.equal(owner.deliveries[0].body, completionPointer(spawned.session_id, ref.run_id, "done"));
  assert.ok((await owner.handle.caller.action("list", {})).sessions.some((row) => row.session_id === spawned.session_id));
  await assert.rejects(owner.handle.caller.action("spawn", { name: "z", product: "claude-peer", open: {}, host: "nowhere" }), (error) => error.code === CODES.unknown_host);
  owner.handle.shutdown();
});

test("scripted errors, raw invalid results, resume default", async () => {
  const daemon = createFakeDaemon({
    methods: {
      "turn.wait": () => {
        throw new DaemonError(CODES.not_running);
      },
      "lane.describe": () => rawResult({ nonsense: true }),
    },
  });
  const owner = peer(daemon, "owner", ["g"]);
  await owner.handle.ready;
  await assert.rejects(owner.handle.caller.action("wait", { session_id: "x" }), (error) => error.code === -32004 && error.message === "not_running");
  await assert.rejects(owner.handle.caller.action("describe", { product: "claude-peer" }), /invalid frame/);
  owner.handle.shutdown();

  const second = createFakeDaemon();
  const p = peer(second, "owner", ["g"]);
  await p.handle.ready;
  const spawned = await p.handle.caller.action("spawn", { name: "w", product: "claude-peer", open: {}, auto_close_ms: 5000 });
  await p.handle.caller.action("close", { session_id: spawned.session_id });
  const resumed = await p.handle.caller.action("spawn", { resume_session_id: spawned.session_id });
  assert.equal(resumed.session_id, spawned.session_id);
  assert.equal(resumed.policy.auto_close_ms, 60000);
  p.handle.shutdown();
});

test("host: index.js loads through the SDK shims, tool offered only in the bound session, snapshot never starts", async () => {
  const socket = path.join(os.tmpdir(), `fake-sb-${process.pid}.sock`);
  const daemon = createFakeDaemon();
  await daemon.listen(socket);
  const sessionKey = "agent:advisor:main";
  const host = createFakeHost({
    config: {
      agents: { entries: { advisor: {} } },
      plugins: { entries: { sessionbus: { hooks: { allowConversationAccess: true }, config: { socket, agents: { advisor: { enabled: true, groups: ["g"], sessionKey } } } } } },
    },
  });
  const entry = await loadPluginEntry();
  host.register(entry);
  const snapshot = host.register(entry, { activate: false });
  assert.equal(snapshot.mode, "tool-discovery");
  await host.start();
  assert.ok(snapshot.services.every((item) => !item.started));
  await until(() => daemon.hellos.length === 1);
  assert.equal(host.tool({ agentId: "advisor", sessionKey: "agent:advisor:other" }), undefined);
  const tool = host.tool({ agentId: "advisor", sessionKey }, "sessionbus", { registration: "snapshot" });
  assert.ok(tool);
  const result = await tool.execute("c1", { action: "list", arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).self_info.session_id, "openclaw-advisor@testhost");
  await host.emitAgentEnd({ success: true }, { agentId: "advisor", sessionKey });
  assert.deepEqual(host.diagnostics, []);
  await host.stop();
  await daemon.close();
});

test("host: agent_end dropped without allowConversationAccess; undeclared tool name rejected", async () => {
  const host = createFakeHost({ config: {}, manifest: { id: "p", contracts: { tools: ["a"] } } });
  host.register({
    id: "p",
    register(api) {
      api.on("agent_end", () => {});
      api.registerTool(() => null, { name: "b" });
    },
  });
  assert.deepEqual(
    host.diagnostics.map((item) => item.message),
    ["typed hook \"agent_end\" blocked because non-bundled plugins must set plugins.entries.p.hooks.allowConversationAccess=true", "plugin must declare contracts.tools for: b"],
  );
  assert.throws(() => host.runtime.logger.info({ not: "a string" }), TypeError);
});

test("a method the daemon does not serve gets invalid_frame and the connection closes; a dead daemon errors, never hangs", async () => {
  const daemon = createFakeDaemon();
  const owner = peer(daemon, "owner", ["g"]);
  await owner.handle.ready;
  // sessionbus@53c5f80 bus/internal/daemon/session.go:216-223,466-481
  await assert.rejects(owner.handle.call("message.deliver", { message_id: "m", from: { session_id: "x", product: "p", groups: [] }, body: "b" }), (error) => error.code === CODES.invalid_frame);
  owner.handle.shutdown();

  const socket = path.join(os.tmpdir(), `fake-sb-down-${process.pid}.sock`);
  const down = createFakeDaemon();
  await down.listen(socket);
  const p = connectPeer({ protocol: 1, product: "openclaw-peer", session_id: "p", groups: ["g"], info: {} }, async () => ({ disposition: "written" }), { SESSIONBUS_SOCKET: socket });
  await p.ready;
  const pending = p.caller.action("wait", { session_id: "nothing" });
  await down.close();
  await assert.rejects(pending);
  await assert.rejects(p.caller.action("list", {}));
  p.shutdown();
});
