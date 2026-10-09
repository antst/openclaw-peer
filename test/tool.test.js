import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import kit from "@sessionbus/kit";
import { createFakeDaemon } from "./support/fake-daemon.js";
import { createFakeRuntime, createStrictLogger } from "./support/fake-openclaw.js";
import { createPeerService } from "../src/service.js";
import { createToolFactory } from "../src/tool.js";

const SESSION_KEY = "agent:advisor:main";
const SELF_ID = "openclaw-advisor@testhost";

test("factory offer decisions log at debug, never info", () => {
  const calls = { debug: [], info: [] };
  const service = {
    started: true,
    bindingFor: () => ({ sessionKey: SESSION_KEY }),
    logger: {
      debug: (line) => calls.debug.push(line),
      info: (line) => calls.info.push(line),
    },
  };
  const factory = createToolFactory(service);
  assert.ok(factory({ agentId: "advisor", sessionKey: SESSION_KEY }));
  assert.equal(factory({ agentId: "advisor", sessionKey: "agent:advisor:other" }), null);
  assert.equal(calls.debug.length, 2);
  assert.match(calls.debug[0], /sessionbus: tool factory .*offered \(static agent:advisor\)$/);
  assert.match(calls.debug[1], /sessionbus: tool factory .*null \(bound agent:advisor:main\)$/);
  assert.deepEqual(calls.info, []);
});

test("action diagnostics name actions and ids without logging message or input bodies", async () => {
  const logs = { debug: [], info: [], warn: [], error: [] };
  const logger = Object.fromEntries(Object.keys(logs).map((level) => [level, (line) => logs[level].push(line)]));
  const service = {
    started: true,
    bindingFor: () => ({ sessionKey: SESSION_KEY }),
    logger,
    guard: { wouldExceed: () => false, record: () => {} },
    peerFor: () => ({ action: async (action) => {
      if (action === "list") return { self_info: { session_id: SELF_ID }, sessions: [{ session_id: SELF_ID }, { session_id: "peer@testhost" }] };
      if (action === "send") return { message_id: "msg-1", deliveries: [{ target: "peer@testhost", session_id: "peer@testhost", disposition: "written" }] };
      return { session_id: "lane@testhost", run_id: "run-1" };
    } }),
  };
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: SESSION_KEY });
  const markers = ["SECRET_SEND_BODY_4821", "SECRET_START_INPUT_4821", "SECRET_RUN_INPUT_4821"];
  const calls = [
    { action: "send", arguments: { target: "peer@testhost", message: markers[0] } },
    { action: "start", arguments: { session_id: "lane@testhost", input: markers[1] } },
    { action: "run", arguments: { session_id: "lane@testhost", input: markers[2] } },
  ];
  for (const params of calls) {
    const result = await tool.execute("c1", params);
    assert.equal(result.isError, undefined, `${params.action} should succeed`);
  }
  assert.ok(logs.debug.some((line) => line.startsWith("sessionbus: action send")));
  assert.ok(logs.debug.some((line) => line.startsWith("sessionbus: action start session_id=lane@testhost")));
  assert.ok(logs.debug.some((line) => line.startsWith("sessionbus: action run session_id=lane@testhost")));
  for (const line of Object.values(logs).flat()) {
    for (const marker of markers) assert.equal(line.includes(marker), false, `${marker} leaked into a log line`);
  }
});

test("tool advertises all actions and resolves daemon errors as isError results", async () => {
  const calls = [];
  const service = {
    started: true,
    bindingFor: () => ({ sessionKey: SESSION_KEY }),
    peerFor: () => ({ action: async (action, args) => {
      calls.push({ action, args });
      if (action === "wait") throw new kit.ProtocolError({ code: -32004, message: "not_running", data: { run_id: "r1" } });
      return { session_id: "lane@testhost" };
    } }),
    logger: { debug: () => {} },
  };
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: SESSION_KEY });
  assert.deepEqual(tool.parameters.properties.action.enum, [...kit.ACTIONS]);
  const spawned = await tool.execute("s", { action: "spawn", arguments: { product: "claude-peer", name: "child", open: {} } });
  assert.equal(spawned.isError, undefined);
  assert.equal(calls[0].args.auto_close_ms, 600000);
  const failed = await tool.execute("w", { action: "wait", arguments: { session_id: "lane@testhost" } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /sessionbus error -32004: not_running \{"run_id":"r1"\}/);
});

test("a formerly offered tool reports a missing peer clearly", async () => {
  const service = { started: true, bindingFor: () => ({ sessionKey: SESSION_KEY }), peerFor: () => undefined, logger: { debug: () => {} } };
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: SESSION_KEY });
  const result = await tool.execute("c1", { action: "list", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "sessionbus: this agent is not connected (plugin stopped or binding removed)");
});

function listResult() {
  return {
    self_info: { session_id: SELF_ID, product: "openclaw-peer", groups: ["g"] },
    sessions: [
      { session_id: SELF_ID, kind: "peer", product: "openclaw-peer", groups: ["g"], connected: true, running: false },
      { session_id: "alice@otherhost", kind: "peer", product: "claude-peer", name: "Alice", groups: ["g"], connected: true, running: false },
      { session_id: "bob@testhost", kind: "peer", product: "claude-peer", name: "Bob", groups: ["g", "team"], connected: true, running: false },
      { session_id: "carol@testhost", kind: "peer", product: "claude-peer", name: "Carol", groups: ["team"], connected: true, running: false },
    ],
  };
}

let nextDeliveryId = 1;

function sendResultFor(args) {
  const targets = args.targets ?? (args.target ? [args.target] : undefined);
  if (targets) {
    return {
      message_id: "msg_1",
      deliveries: targets.map((t) => ({
        target: t,
        session_id: resolveCanonical(t),
        delivery_id: `delivery-${nextDeliveryId++}`,
        disposition: "written",
      })),
    };
  }
  // group
  const rows = listResult().sessions.filter((row) => row.session_id !== SELF_ID && row.groups.includes(args.group));
  return {
    message_id: "msg_1",
    deliveries: rows.map((row) => ({
      target: args.group,
      session_id: row.session_id,
      delivery_id: `delivery-${nextDeliveryId++}`,
      disposition: "written",
    })),
  };
}

function resolveCanonical(label) {
  const rows = listResult().sessions;
  const row = rows.find((r) => r.session_id === label || r.session_id === `${label}@testhost` || r.name === label || `${r.name}@testhost` === label);
  return row ? row.session_id : label;
}

function buildFixture({ botLoopProtection, sessionEntries, adapters, list = listResult, send = sendResultFor, schedule = (call) => call() } = {}) {
  const daemon = createFakeDaemon({ list: () => list(), send });
  const runtime = createFakeRuntime({
    version: "2026.8.2",
    sessionEntries,
    adapters,
    config: {
      agents: { entries: { advisor: {} } },
      channels: botLoopProtection ? { defaults: { botLoopProtection } } : undefined,
      plugins: {
        entries: {
          sessionbus: { config: { socket: "/tmp/fake.sock", agents: { advisor: { enabled: true, groups: ["g"], sessionKey: SESSION_KEY } } } },
        },
      },
    },
  });
  const service = createPeerService(
    { runtime },
    { connect: (path) => daemon.connect(path), schedule, env: {}, uid: 1000 },
  );
  return { daemon, runtime, service };
}

async function ready(service) {
  service.start({ logger: createStrictLogger() });
  await service.peerFor("advisor").ready;
  return createToolFactory(service);
}

test("null for another session, another agent, or a disabled agent", async (t) => {
  const { service } = buildFixture();
  t.after(() => service.stop());
  const factory = await ready(service);
  assert.equal(factory({ agentId: "advisor", sessionKey: "agent:advisor:other" }), null);
  assert.equal(factory({ agentId: "someone-else", sessionKey: SESSION_KEY }), null);
  assert.equal(factory({ agentId: "disabled-agent", sessionKey: "agent:disabled-agent:main" }), null);
});

test("list returns sessions and self_info", async (t) => {
  const { service } = buildFixture();
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });
  const result = await tool.execute("c1", { action: "list", arguments: {} });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.self_info.session_id, SELF_ID);
  assert.ok(parsed.sessions.some((row) => row.session_id === "bob@testhost"));
});

test("send reaches the fake daemon", async (t) => {
  const { daemon, service } = buildFixture();
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });
  const result = await tool.execute("c1", { action: "send", arguments: { target: "alice@otherhost", message: "hi" } });
  assert.equal(daemon.sends.length, 1);
  assert.equal(daemon.sends[0].target, "alice@otherhost");
  assert.equal(JSON.parse(result.content[0].text).message_id, "msg_1");
});

test("send waits for a reconnect and reserves the recipient once", async (t) => {
  const { daemon, service } = buildFixture({ schedule: (call) => setTimeout(call, 20) });
  t.after(() => service.stop());
  const tool = (await ready(service))({ agentId: "advisor", sessionKey: SESSION_KEY });
  let reservations = 0;
  const record = service.guard.record.bind(service.guard);
  service.guard.record = (...args) => { reservations++; return record(...args); };
  daemon.drop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.peerFor("advisor").signal.aborted, false);
  const pending = tool.execute("c1", { action: "send", arguments: { target: "bob@testhost", message: "hi" } });
  const result = await pending;
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(daemon.sends.length, 1);
  assert.equal(reservations, 1);
});

test("send gives up after 5 s with the original error", async () => {
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const peer = { action: async () => { throw new Error("not connected"); } };
    const service = { started: true, bindingFor: () => ({ sessionKey: SESSION_KEY }), peerFor: () => peer, logger: { debug: () => {} } };
    const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: SESSION_KEY });
    const advance = setInterval(() => { now += 250; }, 1);
    try {
      const result = await tool.execute("c1", { action: "list", arguments: {} });
      assert.equal(result.content[0].text, "sessionbus: not connected");
      assert.equal(result.isError, true);
      assert.ok(now >= 5000);
    } finally { clearInterval(advance); }
  } finally { Date.now = originalNow; }
});

test("send abort ends the reconnect wait", async () => {
  const controller = new AbortController();
  const peer = { action: async () => { throw new Error("not connected"); } };
  const service = { started: true, bindingFor: () => ({ sessionKey: SESSION_KEY }), peerFor: () => peer, logger: { debug: () => {} } };
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: SESSION_KEY });
  const pending = tool.execute("c1", { action: "list", arguments: {} }, controller.signal);
  controller.abort(new Error("cancelled by agent"));
  const result = await pending;
  assert.equal(result.content[0].text, "sessionbus: cancelled by agent");
});

test("send other errors are not retried", async () => {
  let calls = 0;
  const peer = { action: async () => { calls++; throw new Error("connection closed"); } };
  const service = { started: true, bindingFor: () => ({ sessionKey: SESSION_KEY }), peerFor: () => peer, logger: { debug: () => {} } };
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: SESSION_KEY });
  const result = await tool.execute("c1", { action: "list", arguments: {} });
  assert.equal(result.content[0].text, "sessionbus: connection closed");
  assert.equal(calls, 1);
});

test("rejected delivery carries the no-resend hint", async (t) => {
  const { service } = buildFixture({ send: () => ({ message_id: "m1", deliveries: [
    { target: "bob", disposition: "rejected", reason: "busy" },
  ] }) });
  t.after(() => service.stop());
  const tool = (await ready(service))({ agentId: "advisor", sessionKey: SESSION_KEY });
  const result = await tool.execute("c1", { action: "send", arguments: { target: "bob", message: "hi" } });
  assert.match(result.content[0].text, /rejected: busy\. Resending the same message will be rejected again — change the message or target, or tell the owner\./);
});

test("unsupported action: tool error, nothing sent", async (t) => {
  const { daemon, service } = buildFixture();
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });
  const result = await tool.execute("c1", { action: "unknown", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected a Sessionbus action/);
  assert.equal(daemon.sends.length, 0);
});

test("bare id, id@host and name share one budget with inbound; exhausted budget blocks with no send", async (t) => {
  // budget 2: 1 inbound + 1 outbound fit; the 3rd event for this pair (in
  // any label form) must be the one that gets blocked pre-send.
  const { daemon, runtime, service } = buildFixture({ botLoopProtection: { maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60 } });
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  await daemon.deliver({ message_id: "m1", from: { session_id: "bob@testhost", product: "claude-peer", groups: ["g"] }, body: "hi" });

  const first = await tool.execute("c1", { action: "send", arguments: { target: "bob", message: "reply" } });
  assert.equal(first.isError, undefined);
  assert.equal(daemon.sends.length, 1);

  const second = await tool.execute("c2", { action: "send", arguments: { target: "bob@testhost", message: "again" } });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /loop guard/);
  assert.equal(daemon.sends.length, 1);

  const third = await tool.execute("c3", { action: "send", arguments: { target: "Bob", message: "once more" } });
  assert.equal(third.isError, true);
  assert.equal(daemon.sends.length, 1);
});

test("group send with a blocked member: error naming it, no send", async (t) => {
  const { daemon, service } = buildFixture({ botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 } });
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  await daemon.deliver({ message_id: "m1", from: { session_id: "bob@testhost", product: "claude-peer", groups: ["team"] }, body: "hi" });
  await daemon.deliver({ message_id: "m2", from: { session_id: "bob@testhost", product: "claude-peer", groups: ["team"] }, body: "hi again" });

  const result = await tool.execute("c1", { action: "send", arguments: { group: "team", message: "hello team" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /bob@testhost/);
  assert.equal(daemon.sends.length, 0);
});

test("budget 1, one inbound — the outbound send that would exhaust it is refused, not sent", async (t) => {
  const { daemon, service } = buildFixture({ botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 } });
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  await daemon.deliver({ message_id: "m1", from: { session_id: "bob@testhost", product: "claude-peer", groups: ["g"] }, body: "hi" });

  const result = await tool.execute("c1", { action: "send", arguments: { target: "bob@testhost", message: "reply" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /loop guard/);
  assert.equal(daemon.sends.length, 0);
});

test("two concurrent sends at budget-1 free slots — exactly one reaches the daemon", async (t) => {
  const { daemon, service } = buildFixture({ botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 } });
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  const [a, b] = await Promise.all([
    tool.execute("c1", { action: "send", arguments: { target: "bob@testhost", message: "one" } }),
    tool.execute("c2", { action: "send", arguments: { target: "bob@testhost", message: "two" } }),
  ]);
  const errors = [a, b].filter((r) => r.isError);
  const oks = [a, b].filter((r) => !r.isError);
  assert.equal(oks.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(daemon.sends.length, 1);
});

test("group fan-out refused exactly at the boundary, before any cooldown starts", async (t) => {
  const { daemon, service } = buildFixture({ botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 } });
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  // One inbound from bob exactly meets (does not exceed) the budget of 1 —
  // guard.blocked(bob) is still false here; no cooldown has started.
  await daemon.deliver({ message_id: "m1", from: { session_id: "bob@testhost", product: "claude-peer", groups: ["team"] }, body: "hi" });

  const result = await tool.execute("c1", { action: "send", arguments: { group: "team", message: "hello team" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /bob@testhost/);
  assert.equal(daemon.sends.length, 0);
});

test("group send records each receipt id under the shared budget", async (t) => {
  const { daemon, service } = buildFixture({ botLoopProtection: { maxEventsPerWindow: 5, windowSeconds: 60, cooldownSeconds: 60 } });
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  const result = await tool.execute("c1", { action: "send", arguments: { group: "team", message: "hello team" } });
  assert.equal(result.isError, undefined);
  assert.equal(daemon.sends.length, 1);
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(
    parsed.deliveries.map((d) => d.session_id).sort(),
    ["bob@testhost", "carol@testhost"],
  );
});

test("group guard reserves recipients excluding self and respecting host", async () => {
  const recorded = [];
  const service = {
    started: true,
    bindingFor: () => ({ sessionKey: SESSION_KEY }),
    guard: { wouldExceed: () => false, record: (_local, id) => recorded.push(id) },
    logger: { debug: () => {}, info: () => {} },
    peerFor: () => ({ action: async (action) => action === "list" ? listResult() : { message_id: "group-1", deliveries: [] } }),
  };
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: SESSION_KEY });
  const all = await tool.execute("g1", { action: "send", arguments: { group: "g", message: "hello" } });
  assert.equal(all.isError, undefined);
  assert.deepEqual(recorded, ["alice@otherhost", "bob@testhost"]);
  recorded.length = 0;
  const hosted = await tool.execute("g2", { action: "send", arguments: { group: "g", host: "testhost", message: "hello" } });
  assert.equal(hosted.isError, undefined);
  assert.deepEqual(recorded, ["bob@testhost"]);
});

const LANE_KEY = "agent:lane:sb-3f2b8c1e-7a4d-4e21-9b6f-0c5d8e7a1b24";

test("tool offer: owner key, recorded channel route, live lane registration, nothing else", async (t) => {
  const { service } = buildFixture();
  t.after(() => service.stop());
  const factory = await ready(service);
  const conn = { request: async () => ({ result: {} }) };
  service.laneConn = (key) => (key === LANE_KEY ? conn : undefined);
  assert.ok(factory({ agentId: "advisor", sessionKey: SESSION_KEY }), "owner key");
  assert.equal(factory({ agentId: "advisor", sessionKey: "agent:advisor:sessionbus:direct:other@host" }), null, "unrecorded channel key");
  service.routeKeys("advisor").add("agent:advisor:sessionbus:direct:other@host");
  assert.ok(factory({ agentId: "advisor", sessionKey: "agent:advisor:sessionbus:direct:other@host" }), "recorded channel route");
  assert.equal(factory({ agentId: "other", sessionKey: "agent:advisor:sessionbus:direct:other@host" }), null, "another agent's id");
  assert.ok(factory({ agentId: "lane", sessionKey: LANE_KEY }), "live lane registration");
  assert.equal(factory({ agentId: "lane", sessionKey: "agent:lane:sb-00000000-0000-4000-8000-000000000000" }), null, "unregistered lane key");
  assert.equal(factory({ agentId: "advisor", sessionKey: "agent:advisor:other" }), null, "any other key");
});

test("lane action goes through the bridge connection and cancels on abort", async () => {
  const seen = [];
  const conn = {
    request(method, params, signal) {
      seen.push({ method, params });
      if (params.action === "wait") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return Promise.resolve({ result: { self_info: { session_id: LANE_KEY } } });
    },
  };
  const service = { started: true, bindingFor: () => undefined, laneConn: (key) => (key === LANE_KEY ? conn : undefined), logger: { debug: () => {} } };
  const tool = createToolFactory(service)({ agentId: "lane", sessionKey: LANE_KEY });
  const listed = await tool.execute("c1", { action: "list", arguments: {} });
  assert.equal(JSON.parse(listed.content[0].text).self_info.session_id, LANE_KEY);
  assert.deepEqual(seen[0], { method: "bus.action", params: { action: "list", arguments: {} } });
  const controller = new AbortController();
  const pending = tool.execute("c2", { action: "wait", arguments: { session_id: "x" } }, controller.signal);
  controller.abort(new Error("stop"));
  const result = await pending;
  assert.equal(result.isError, true);
});

test("daemon dropped and an aborted signal: tool error, nothing sent", async (t) => {
  const { daemon, service } = buildFixture();
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  const controller = new AbortController();
  controller.abort();
  const result = await tool.execute("c1", { action: "send", arguments: { target: "bob", message: "hi" } }, controller.signal);
  assert.equal(result.isError, true);
  assert.equal(daemon.sends.length, 0);
});

test("invalid addressing shapes are rejected before any peer call", async (t) => {
  const { daemon, service } = buildFixture();
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  const invalidShapes = [
    { targets: [] },
    { targets: ["bob", 5] },
    { targets: ["bob", "bob"] },
    { target: "" },
    { group: "" },
    { group: "team", host: "" },
  ];

  for (const shape of invalidShapes) {
    const result = await tool.execute("c1", { action: "send", arguments: { message: "hi", ...shape } });
    assert.equal(result.isError, true, `${JSON.stringify(shape)} should be a tool error`);
  }
  assert.equal(daemon.lists.length, 0);
  assert.equal(daemon.sends.length, 0);
});

test("send: duplicate labels for one recipient are forwarded, guard counted once", async (t) => {
  const { daemon, service } = buildFixture({
    botLoopProtection: { maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60 },
    send: (params) => ({
      message_id: "msg_1",
      deliveries: [{ target: params.targets?.[0] ?? params.target, session_id: "bob@testhost", delivery_id: `delivery-${nextDeliveryId++}`, disposition: "written" }],
    }),
  });
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  const args = { targets: ["bob@testhost", "Bob"], message: "hi" };
  const result = await tool.execute("c1", { action: "send", arguments: args });
  assert.equal(result.isError, undefined);
  assert.equal(daemon.sends.length, 1);
  assert.deepEqual(daemon.sends[0], args);
  assert.deepEqual(JSON.parse(result.content[0].text).deliveries.map((d) => d.session_id), ["bob@testhost"]);

  const second = await tool.execute("c2", { action: "send", arguments: { target: "bob@testhost", message: "hi again" } });
  assert.equal(second.isError, undefined);
  assert.equal(daemon.sends.length, 2);

  const third = await tool.execute("c3", { action: "send", arguments: { target: "bob@testhost", message: "third" } });
  assert.equal(third.isError, true);
  assert.match(third.content[0].text, /loop guard/);
  assert.equal(daemon.sends.length, 2);
});

test("send: an ambiguous name charges no lane; exact IDs win over names", async (t) => {
  // Sessionbus 0.5.11+: lane names are not unique; the daemon resolves exact IDs first and answers
  // rejected/ambiguous for several name matches (sessionbus v0.5.12 bus/docs/PROTOCOL.md, session.list).
  const twins = () => {
    const base = listResult();
    base.sessions.push(
      { session_id: "lane-a@testhost", kind: "lane", product: "claude-peer", name: "twin", groups: ["g"], connected: true, running: false },
      { session_id: "lane-b@testhost", kind: "lane", product: "claude-peer", name: "twin", groups: ["g"], connected: true, running: false },
      { session_id: "x@testhost", kind: "lane", product: "claude-peer", name: "lane-a", groups: ["g"], connected: true, running: false },
    );
    return base;
  };
  const { daemon, service } = buildFixture({
    botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
    list: twins,
    send: (params) => params.target === "twin"
      ? { message_id: "msg_1", deliveries: [{ target: "twin", disposition: "rejected", reason: "ambiguous" }] }
      : sendResultFor(params),
  });
  t.after(() => service.stop());
  const factory = await ready(service);
  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });

  const ambiguous = await tool.execute("c1", { action: "send", arguments: { target: "twin", message: "hi" } });
  assert.equal(ambiguous.isError, undefined);
  assert.match(ambiguous.content[0].text, /ambiguous/);
  assert.equal(daemon.sends.length, 1);

  for (const target of ["lane-a@testhost", "lane-b"]) {
    const result = await tool.execute("c2", { action: "send", arguments: { target, message: "by id" } });
    assert.equal(result.isError, undefined, target);
  }
  assert.equal(daemon.sends.length, 3);

  // "lane-a" is lane-a@testhost's ID part and x@testhost's name: the ID wins, and its budget is spent.
  const byIdPart = await tool.execute("c3", { action: "send", arguments: { target: "lane-a", message: "again" } });
  assert.equal(byIdPart.isError, true);
  assert.match(byIdPart.content[0].text, /pair budget exceeded for lane-a@testhost/);
  assert.equal(daemon.sends.length, 3);

  const other = await tool.execute("c4", { action: "send", arguments: { target: "x@testhost", message: "hi" } });
  assert.equal(other.isError, undefined);
  assert.equal(daemon.sends.length, 4);
});

// Acceptance diagnostic: OpenClaw re-runs register() in a separate tool-discovery registry
// (activate:false — openclaw-v2026.8.2 src/plugins/tools.ts:1230-1233) whose service is never started;
// the factory logged `null (bound none)`. A factory from any registration must use the started service.
test("a tool factory from an unstarted registration uses the started service", async (t) => {
  const { service, daemon } = buildFixture();
  t.after(() => service.stop());
  await ready(service);
  const discovery = createPeerService({ runtime: service.runtime }, { env: {}, uid: 1000 });
  const factory = createToolFactory(discovery);

  const tool = factory({ agentId: "advisor", sessionKey: SESSION_KEY });
  assert.ok(tool, "discovery-registry factory should offer the tool");
  const result = await tool.execute("t1", { action: "send", arguments: { target: "bob@testhost", message: "hi" } });
  assert.match(result.content[0].text, /bob@testhost/);
  assert.equal(daemon.sends.length, 1);

  await service.stop();
  assert.equal(factory({ agentId: "advisor", sessionKey: SESSION_KEY }), null);
});

test("a lane-shaped session without a live registration gets no tool and a warning that names the key (LV-1)", () => {
  const warnings = [];
  const service = { started: true, bindingFor: () => undefined, laneConn: () => undefined, logger: { debug: () => {}, warn: (m) => warnings.push(m) } };
  const factory = createToolFactory(service);
  assert.equal(factory({ agentId: "lane", sessionKey: LANE_KEY }), null);
  assert.deepEqual(warnings, [`sessionbus: tool not offered to lane session ${LANE_KEY}: no live lane registration on the bridge`]);
  // Other keys stay silent.
  assert.equal(factory({ agentId: "lane", sessionKey: "agent:lane:main" }), null);
  assert.equal(factory({ agentId: "lane", sessionKey: undefined }), null);
  assert.equal(warnings.length, 1);
});
