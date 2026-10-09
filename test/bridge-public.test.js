// TW-P3a — public-surface tests for the bridge server (`src/bridge.js`, createBridgeServer),
// PLAN bus-0512, Test-writer stream. Spec: PLAN `## Interface` «Bridge wire v1» + «Bridge endpoint».
// Everything runs over a real unix socket in os.tmpdir() with a minimal JSON-lines worker double
// built here (the test owns no files in test/support): requests {"v":1,"id":"w:<n>",...},
// replies {"v":1,"id":...,"result"|"error"} — exactly the wire the Interface defines.
import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/bridge.js";

// A lane key as minted by the worker (Interface: `agent:<agentId>:sb-…`, LANE_KEY shape).
const KEY = "agent:advisor:sb-123e4567-e89b-42d3-a726-446655440000";
const KEY2 = "agent:advisor:sb-123e4567-e89b-42d3-a726-446655440001";
const STEER_TEXT = "steer me mid-run";

const SETTINGS = () => ({
  agents: [
    { id: "advisor", workspace: "/w/advisor", description: "the advisor" },
    { id: "other", workspace: "/w/other" },
  ],
  credentialDir: "/creds",
  auditLog: "/audit",
});

/** Harness double: records calls; `resolve`/`queue` decide outcomes, may return promises. */
function harnessDouble({ resolve, queue } = {}) {
  const calls = { resolve: [], queue: [] };
  return {
    calls,
    resolveActiveEmbeddedRunSessionId: async (key) => {
      calls.resolve.push(key);
      return typeof resolve === "function" ? resolve(key) : resolve;
    },
    queueAgentHarnessMessage: async (sessionId, text) => {
      calls.queue.push([sessionId, text]);
      return typeof queue === "function" ? queue(sessionId, text) : queue;
    },
  };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Minimal JSON-lines worker speaking Bridge wire v1 from the client side of the socket. */
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
    this.incoming = []; // plugin→worker requests (bus.action, rpc.cancel)
    this.incomingWaiters = [];
    this.unsolicited = []; // frames addressed to no live request (error frames with id:null)
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

/** Bridge server on a fresh private dir in os.tmpdir(); logs collected for steer assertions. */
async function bridgeFixture(t, { settings = SETTINGS, harness = harnessDouble(), configuredModel } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-public-"));
  const socketPath = path.join(dir, "bridge.sock");
  const logs = [];
  const server = createBridgeServer({
    path: socketPath,
    settings,
    harness,
    ...(configuredModel ? { configuredModel } : {}),
    logger: { info: (m) => logs.push(m), error: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  t.after(async () => {
    await server.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await server.listen();
  return { server, socketPath, harness, logs };
}

async function registerKey(worker, sessionKey = KEY, agentId = "advisor") {
  return worker.request("lane.register", { sessionKey, agentId, acpSessionId: "acp-1" });
}

// ---------------------------------------------------------------- settings.get

test("settings.get returns the configured lanes settings", async (t) => {
  const { socketPath } = await bridgeFixture(t);
  const worker = await Worker.connect(socketPath);

  const result = await worker.request("settings.get", {});
  assert.deepEqual(result, {
    agents: SETTINGS().agents,
    credentialDir: "/creds",
    auditLog: "/audit",
  });
});

test("settings.get without lanes answers lanes_not_configured", async (t) => {
  const { socketPath } = await bridgeFixture(t, {
    settings: () => ({ error: "lanes are not configured in the plugin config" }),
  });
  const worker = await Worker.connect(socketPath);

  await assert.rejects(worker.request("settings.get", {}), (error) => {
    assert.equal(error.code, "lanes_not_configured");
    assert.match(error.message, /lanes/);
    return true;
  });
});

// ---------------------------------------------------------------- lane.register

test("lane.register rejects bad_key, unknown_agent, agent_mismatch, key_in_use, already_bound", async (t) => {
  const { socketPath, server } = await bridgeFixture(t);
  const first = await Worker.connect(socketPath);
  const second = await Worker.connect(socketPath);

  // not a lane key at all
  await assert.rejects(
    first.request("lane.register", { sessionKey: "agent:advisor:main", agentId: "advisor" }),
    (error) => error.code === "bad_key",
  );
  // key is well-formed but the agent is not in lanes.agents
  await assert.rejects(
    first.request("lane.register", { sessionKey: KEY, agentId: "ghost" }),
    (error) => error.code === "unknown_agent",
  );
  // the key belongs to another agent
  await assert.rejects(
    first.request("lane.register", { sessionKey: KEY, agentId: "other" }),
    (error) => error.code === "agent_mismatch",
  );
  // one live registration per key
  assert.deepEqual(await registerKey(first), { ready: true });
  await assert.rejects(
    second.request("lane.register", { sessionKey: KEY, agentId: "advisor" }),
    (error) => error.code === "key_in_use",
  );
  // one connection binds exactly one key
  await assert.rejects(
    first.request("lane.register", { sessionKey: KEY2, agentId: "advisor" }),
    (error) => error.code === "already_bound",
  );
  // laneConn exposes the bound connection for the key
  assert.ok(server.laneConn(KEY), "laneConn(KEY) must expose the bound connection");
});

// ---------------------------------------------------------------- lane.steer

test("lane.steer refuses unbound, too_large, registry_absent and not_eligible", async (t) => {
  const harness = harnessDouble({ resolve: undefined, queue: false });
  const { socketPath } = await bridgeFixture(t, { harness });
  const unboundWorker = await Worker.connect(socketPath);
  const worker = await Worker.connect(socketPath);

  // a connection that never registered
  await assert.rejects(
    unboundWorker.request("lane.steer", { sessionKey: KEY, messageId: "m1", text: STEER_TEXT }),
    (error) => error.code === "unbound",
  );
  // a registered connection steering a key other than its own
  assert.deepEqual(await registerKey(worker), { ready: true });
  await assert.rejects(
    worker.request("lane.steer", { sessionKey: KEY2, messageId: "m1", text: STEER_TEXT }),
    (error) => error.code === "unbound",
  );
  // body over the 128 KiB steer limit (Interface «Bridge wire v1»)
  await assert.rejects(
    worker.request("lane.steer", { sessionKey: KEY, messageId: "m2", text: "x".repeat(128 * 1024 + 1) }),
    (error) => error.code === "too_large",
  );
  // no active embedded run for the key: not an error, an ineligible outcome with the reason
  const absent = await worker.request("lane.steer", { sessionKey: KEY, messageId: "m3", text: STEER_TEXT });
  assert.deepEqual(absent, { eligible: false, reason: "registry_absent" });
  assert.equal(harness.calls.queue.length, 0, "registry_absent must not touch the SDK queue");

  // resolver answers a session, the SDK refuses the message
  harness.calls.resolve.length = 0;
  const eligible = harnessDouble({ resolve: "sess-run-1", queue: false });
  const { socketPath: path2 } = await bridgeFixture(t, { harness: eligible });
  const w2 = await Worker.connect(path2);
  assert.deepEqual(await registerKey(w2), { ready: true });
  const outcome = await w2.request("lane.steer", { sessionKey: KEY, messageId: "m4", text: STEER_TEXT });
  assert.deepEqual(outcome, { eligible: false, reason: "not_eligible" });
  assert.deepEqual(eligible.calls.queue, [["sess-run-1", STEER_TEXT]]);
});

test("lane.steer eligible queues exactly one harness message with the resolved session id", async (t) => {
  const harness = harnessDouble({ resolve: "sess-run-7", queue: true });
  const { socketPath, logs } = await bridgeFixture(t, {
    harness,
    configuredModel: (agentId) => (agentId === "advisor" ? "anthropic/claude" : undefined),
  });
  const worker = await Worker.connect(socketPath);
  assert.deepEqual(await registerKey(worker), { ready: true });

  const outcome = await worker.request("lane.steer", { sessionKey: KEY, messageId: "steer-1", text: STEER_TEXT });
  assert.deepEqual(outcome, { eligible: true });
  // the SDK queue is touched exactly once, with the session id the resolver returned
  assert.deepEqual(harness.calls.queue, [["sess-run-7", STEER_TEXT]]);
  assert.deepEqual(harness.calls.resolve, [KEY]);
  // Interface log line: sessionbus: steer <sessionKey> <messageId> eligible=… configured_model=…
  assert.ok(
    logs.some((line) => /sessionbus: steer agent:advisor:sb-\S+ steer-1 eligible=true .*configured_model=anthropic\/claude/.test(line)),
    `expected a steer log line, got: ${logs.join(" | ")}`,
  );
});

test("lane.steer re-checks ownership after await and never touches the SDK (D9)", async (t) => {
  let releaseResolve;
  const gate = new Promise((resolve) => (releaseResolve = resolve));
  const harness = harnessDouble({ resolve: () => gate, queue: true });
  const { socketPath, server } = await bridgeFixture(t, { harness });
  const worker = await Worker.connect(socketPath);
  assert.deepEqual(await registerKey(worker), { ready: true });

  // steer hangs inside the resolver; meanwhile the connection loses the registration
  const pending = worker.request("lane.steer", { sessionKey: KEY, messageId: "d9", text: STEER_TEXT });
  pending.catch(() => {}); // the socket is about to die; the reply is unobservable by design
  await waitFor(() => harness.calls.resolve.length === 1);
  const bound = server.laneConn(KEY);
  assert.ok(bound, "the key is bound while the steer runs");
  bound.close(); // disconnect drops the registration
  releaseResolve("sess-run-9"); // the resolver finally answers a session id
  await worker.closed;
  // D9: the SDK queue must never be called for a registration the connection no longer owns
  assert.equal(harness.calls.queue.length, 0);
});

// ---------------------------------------------------------------- bus.action / rpc.cancel

test("bus.action round-trip and rpc.cancel", async (t) => {
  const { socketPath, server } = await bridgeFixture(t);
  const worker = await Worker.connect(socketPath);
  assert.deepEqual(await registerKey(worker), { ready: true });
  const conn = server.laneConn(KEY);
  assert.ok(conn, "laneConn(KEY) must expose the bound connection");

  // plugin→worker bus.action; the worker answers with {result}
  const call = conn.request("bus.action", { action: "send", arguments: { target: "x@host", message: "hi" } });
  const frame = await worker.nextIncoming();
  assert.equal(frame.method, "bus.action");
  assert.match(frame.id, /^p:/);
  assert.deepEqual(frame.params, { action: "send", arguments: { target: "x@host", message: "hi" } });
  worker.reply(frame, { result: { deliveries: [{ disposition: "written" }] } });
  assert.deepEqual(await call, { result: { deliveries: [{ disposition: "written" }] } });

  // an abort cancels the pending action: the plugin sends rpc.cancel for that request id
  const controller = new AbortController();
  const cancelled = conn.request("bus.action", { action: "wait", arguments: {} }, controller.signal);
  const pendingFrame = await worker.nextIncoming();
  assert.equal(pendingFrame.method, "bus.action");
  const abortReason = new Error("lane gave up");
  controller.abort(abortReason);
  await assert.rejects(cancelled, (error) => error === abortReason);
  const cancelFrame = await worker.nextIncoming();
  assert.equal(cancelFrame.method, "rpc.cancel");
  assert.deepEqual(cancelFrame.params, { id: pendingFrame.id });
  worker.reply(cancelFrame, {});
});

// ---------------------------------------------------------------- limits

test("oversized frame closes the connection with an error frame", async (t) => {
  const { socketPath } = await bridgeFixture(t);
  const worker = await Worker.connect(socketPath);

  worker.socket.write(`${"x".repeat(1 << 20)}\n`); // one line just over the 1 MiB frame limit
  await worker.closed;
  const errorFrame = worker.unsolicited.find((frame) => frame.error);
  assert.ok(errorFrame, "the server must answer an oversized frame with an error frame");
  assert.equal(errorFrame.error.code, "frame_too_large");
});

test("65th pending request is refused", async (t) => {
  const gate = new Promise(() => {}); // every steer hangs inside the resolver
  const harness = harnessDouble({ resolve: () => gate });
  const { socketPath } = await bridgeFixture(t, { harness });
  const worker = await Worker.connect(socketPath);
  assert.deepEqual(await registerKey(worker), { ready: true });

  const pending = [];
  for (let i = 0; i < 64; i++) {
    pending.push(worker.request("lane.steer", { sessionKey: KEY, messageId: `p-${i}`, text: STEER_TEXT }).catch((e) => e));
  }
  await waitFor(() => worker.waiters.size === 64); // all in flight, none answered

  const sixtyFifth = await worker
    .request("lane.steer", { sessionKey: KEY, messageId: "p-64", text: STEER_TEXT })
    .catch((error) => error);
  assert.ok(sixtyFifth instanceof Error, "the 65th pending request must be refused");
  assert.equal(sixtyFifth.code, "busy");
});

// ---------------------------------------------------------------- disconnect / endpoint

test("disconnect drops the registration", async (t) => {
  const { socketPath, server } = await bridgeFixture(t);
  const worker = await Worker.connect(socketPath);
  assert.deepEqual(await registerKey(worker), { ready: true });
  assert.ok(server.laneConn(KEY));

  worker.socket.destroy();
  await waitFor(() => !server.laneConn(KEY));
  assert.equal(server.connections.size, 0, "the closed connection leaves the connection set");

  // the key is free again: a fresh worker may bind it
  const next = await Worker.connect(socketPath);
  assert.deepEqual(await registerKey(next), { ready: true });
});

test("bridge endpoint: a stale socket is cleared, a live listener is refused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-public-"));
  const socketPath = path.join(dir, "bridge.sock");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // leave a dead socket file behind: Node unlinks the socket on server close, so keep a second
  // hard link to the socket inode alive across the close, then restore it at the endpoint path
  const dead = net.createServer(() => {});
  await new Promise((resolve) => dead.listen(socketPath, resolve));
  const keep = path.join(dir, "stale.sock");
  fs.linkSync(socketPath, keep);
  await new Promise((resolve) => dead.close(resolve));
  fs.renameSync(keep, socketPath);
  assert.ok(fs.existsSync(socketPath), "precondition: a stale socket file");

  const server = createBridgeServer({ path: socketPath, settings: SETTINGS, harness: harnessDouble() });
  t.after(() => server.close().catch(() => {}));
  await server.listen(); // stale socket removed, listen succeeds
  assert.ok(fs.existsSync(socketPath));

  // a second server at the same endpoint must refuse: the listener is live
  const contender = createBridgeServer({ path: socketPath, settings: SETTINGS, harness: harnessDouble() });
  t.after(() => contender.close().catch(() => {}));
  await assert.rejects(contender.listen(), (error) => {
    assert.match(error.message, /already served/);
    return true;
  });
});
