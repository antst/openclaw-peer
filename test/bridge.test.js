import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBridgeServer } from "../src/bridge.js";
import { clearStaleSocket, ensureBridgeDir, resolveBridgePath } from "../src/bridge-path.js";

const KEY = "agent:lane:sb-11111111-1111-4111-8111-111111111111";
const KEY2 = "agent:lane:sb-22222222-2222-4222-8222-222222222222";
const SETTINGS = { agents: [{ id: "lane", workspace: "/w" }], credentialDir: "/c" };

async function start(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  const socketPath = path.join(dir, "d", "bridge.sock");
  const calls = { resolve: [], queue: [] };
  const logs = [];
  const harness = overrides.harness ?? {
    resolveActiveEmbeddedRunSessionId: (key) => (calls.resolve.push(key), "sid-1"),
    queueAgentHarnessMessage: (sid, text) => (calls.queue.push({ sid, text }), true),
  };
  const bridge = createBridgeServer({
    path: socketPath,
    settings: overrides.settings ?? (() => SETTINGS),
    harness,
    configuredModel: () => "p/m",
    logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  await bridge.listen();
  t.after(async () => {
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { bridge, socketPath, calls, logs, dir };
}

/** A raw worker: JSON Lines client. */
function worker(socketPath) {
  const socket = net.createConnection(socketPath);
  const frames = [];
  const waiters = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      const waiter = waiters.findIndex((w) => w.match(frame));
      if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(frame);
      else frames.push(frame);
    }
  });
  socket.on("error", () => {});
  let n = 0;
  const next = (match) => {
    const index = frames.findIndex(match);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  return {
    socket,
    ready: new Promise((resolve) => socket.once("connect", resolve)),
    closed: new Promise((resolve) => socket.once("close", resolve)),
    async call(method, params) {
      const id = `w:${++n}`;
      socket.write(`${JSON.stringify({ v: 1, id, method, params })}\n`);
      return next((f) => f.id === id);
    },
    raw: (text) => socket.write(text),
    incoming: (match) => next(match),
    reply: (id, body) => socket.write(`${JSON.stringify({ v: 1, id, ...body })}\n`),
    end: () => socket.destroy(),
  };
}

async function connect(t, socketPath) {
  const w = worker(socketPath);
  await w.ready;
  t.after(() => w.end());
  return w;
}

test("resolveBridgePath: env, XDG, then /tmp/uid", () => {
  assert.equal(resolveBridgePath({ SESSIONBUS_OPENCLAW_BRIDGE: "/x/b.sock", XDG_RUNTIME_DIR: "/run/u" }, 1), "/x/b.sock");
  assert.equal(resolveBridgePath({ XDG_RUNTIME_DIR: "/run/u" }, 1), "/run/u/openclaw-sessionbus/bridge.sock");
  assert.equal(resolveBridgePath({}, 501), "/tmp/openclaw-sessionbus-501/bridge.sock");
});

test("socket is 0600 in a 0700 directory", async (t) => {
  const { socketPath } = await start(t);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
});

test("the socket is bound 0600 with no wider window, and the umask is restored (#12)", async (t) => {
  const previous = process.umask(0o022);
  const chmodSync = fs.chmodSync;
  fs.chmodSync = () => {}; // mutation: without the post-bind chmod the bind itself must give 0600
  t.after(() => {
    fs.chmodSync = chmodSync;
    process.umask(previous);
  });
  const { socketPath } = await start(t);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(process.umask(0o022), 0o022);
});

test("settings.get returns the configured settings; absent lanes is lanes_not_configured", async (t) => {
  const a = await start(t);
  const w = await connect(t, a.socketPath);
  assert.deepEqual((await w.call("settings.get", {})).result, SETTINGS);
  const b = await start(t, { settings: () => ({ error: "no lanes" }) });
  const w2 = await connect(t, b.socketPath);
  assert.equal((await w2.call("settings.get", {})).error.code, "lanes_not_configured");
});

test("lane.register: ok, then bad_key, unknown_agent, agent_mismatch, key_in_use, already_bound", async (t) => {
  const { socketPath, bridge } = await start(t);
  const w = await connect(t, socketPath);
  assert.equal((await w.call("lane.register", { sessionKey: "agent:lane:main", agentId: "lane", acpSessionId: "a" })).error.code, "bad_key");
  assert.equal((await w.call("lane.register", { sessionKey: KEY, agentId: "other", acpSessionId: "a" })).error.code, "unknown_agent");
  assert.equal((await w.call("lane.register", { sessionKey: "agent:other:sb-11111111-1111-4111-8111-111111111111", agentId: "lane", acpSessionId: "a" })).error.code, "agent_mismatch");
  assert.deepEqual((await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" })).result, { ready: true });
  assert.ok(bridge.laneConn(KEY));
  assert.equal((await w.call("lane.register", { sessionKey: KEY2, agentId: "lane", acpSessionId: "a" })).error.code, "already_bound");
  const w2 = await connect(t, socketPath);
  assert.equal((await w2.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" })).error.code, "key_in_use");
});

test("lane.steer: unbound, too_large, registry_absent, not_eligible, eligible (queue called exactly once)", async (t) => {
  let accept = true;
  let session = "sid-1";
  const calls = [];
  const { socketPath } = await start(t, {
    harness: {
      resolveActiveEmbeddedRunSessionId: () => session,
      queueAgentHarnessMessage: (sid, text) => (calls.push([sid, text]), accept),
    },
  });
  const w = await connect(t, socketPath);
  assert.equal((await w.call("lane.steer", { sessionKey: KEY, messageId: "m", text: "x" })).error.code, "unbound");
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  assert.equal((await w.call("lane.steer", { sessionKey: KEY2, messageId: "m", text: "x" })).error.code, "unbound");
  assert.equal((await w.call("lane.steer", { sessionKey: KEY, messageId: "m", text: "x".repeat(128 * 1024 + 1) })).error.code, "too_large");
  assert.equal(calls.length, 0);
  session = undefined;
  assert.deepEqual((await w.call("lane.steer", { sessionKey: KEY, messageId: "m", text: "x" })).result, { eligible: false, reason: "registry_absent" });
  session = "sid-1";
  accept = false;
  assert.deepEqual((await w.call("lane.steer", { sessionKey: KEY, messageId: "m", text: "x" })).result, { eligible: false, reason: "not_eligible" });
  accept = true;
  assert.deepEqual((await w.call("lane.steer", { sessionKey: KEY, messageId: "m", text: "hello" })).result, { eligible: true });
  assert.deepEqual(calls.at(-1), ["sid-1", "hello"]);
  assert.equal(calls.length, 2);
});

test("lane.steer log line carries eligibility and configured_model", async (t) => {
  const { socketPath, logs } = await start(t);
  const w = await connect(t, socketPath);
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  await w.call("lane.steer", { sessionKey: KEY, messageId: "m1", text: "x" });
  assert.ok(logs.includes(`sessionbus: steer ${KEY} m1 eligible=true reason=- configured_model=p/m`));
});

test("a connection that closes while the resolver runs never reaches the SDK (D9)", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const queued = [];
  const { socketPath, bridge } = await start(t, {
    harness: {
      resolveActiveEmbeddedRunSessionId: async () => (await gate, "sid-1"),
      queueAgentHarnessMessage: (sid, text) => (queued.push(text), true),
    },
  });
  const w = await connect(t, socketPath);
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  w.raw(`${JSON.stringify({ v: 1, id: "w:99", method: "lane.steer", params: { sessionKey: KEY, messageId: "m", text: "x" } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  w.end();
  await w.closed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.laneConn(KEY), undefined);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(queued, []);
});

test("disconnect drops the registration", async (t) => {
  const { socketPath, bridge } = await start(t);
  const w = await connect(t, socketPath);
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  w.end();
  await w.closed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.laneConn(KEY), undefined);
  const w2 = await connect(t, socketPath);
  assert.deepEqual((await w2.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" })).result, { ready: true });
});

test("bus.action round-trip, error frame, and rpc.cancel on abort", async (t) => {
  const { socketPath, bridge } = await start(t);
  const w = await connect(t, socketPath);
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  const conn = bridge.laneConn(KEY);

  const ok = conn.request("bus.action", { action: "list", arguments: {} });
  const call = await w.incoming((f) => f.method === "bus.action");
  assert.match(call.id, /^p:\d+$/);
  assert.deepEqual(call.params, { action: "list", arguments: {} });
  w.reply(call.id, { result: { result: { rows: [] } } });
  assert.deepEqual(await ok, { result: { rows: [] } });

  const bad = conn.request("bus.action", { action: "send", arguments: {} });
  const call2 = await w.incoming((f) => f.method === "bus.action");
  w.reply(call2.id, { error: { code: "action_failed", message: "boom" } });
  await assert.rejects(bad, (error) => error.code === "action_failed" && error.message === "boom");

  const controller = new AbortController();
  const cancelled = conn.request("bus.action", { action: "wait", arguments: {} }, controller.signal);
  const call3 = await w.incoming((f) => f.method === "bus.action");
  controller.abort(new Error("stop"));
  await assert.rejects(cancelled, /stop/);
  const cancel = await w.incoming((f) => f.method === "rpc.cancel");
  assert.deepEqual(cancel.params, { id: call3.id });
});

test("closing the connection rejects pending bus.action as cancelled", async (t) => {
  const { socketPath, bridge } = await start(t);
  const w = await connect(t, socketPath);
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  const pending = bridge.laneConn(KEY).request("bus.action", { action: "wait", arguments: {} });
  await w.incoming((f) => f.method === "bus.action");
  w.end();
  await assert.rejects(pending, (error) => error.code === "cancelled");
});

test("a frame over 1 MiB closes the connection with an error frame", async (t) => {
  const { socketPath } = await start(t);
  const w = await connect(t, socketPath);
  const error = w.incoming((f) => f.error);
  w.raw("x".repeat((1 << 20) + 10));
  assert.equal((await error).error.code, "frame_too_large");
  await w.closed;
});

test("the 65th pending request is refused", async (t) => {
  const never = new Promise(() => {});
  const { socketPath } = await start(t, { harness: { resolveActiveEmbeddedRunSessionId: () => never, queueAgentHarnessMessage: () => true } });
  const w = await connect(t, socketPath);
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  for (let n = 1; n <= 64; n++) w.raw(`${JSON.stringify({ v: 1, id: `w:s${n}`, method: "lane.steer", params: { sessionKey: KEY, messageId: "m", text: "x" } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const refused = await w.call("settings.get", {});
  assert.equal(refused.error.code, "busy");
});

test("stale socket is removed; a live listener refuses a second server", async (t) => {
  const { socketPath, bridge, dir } = await start(t);
  const second = createBridgeServer({ path: socketPath, settings: () => SETTINGS, harness: {} });
  await assert.rejects(second.listen(), /bridge endpoint already served/);
  // A dead listener's file: make a socket file whose server is gone.
  await bridge.close();
  const stale = path.join(dir, "d", "bridge.sock");
  await new Promise((resolve) => {
    const server = net.createServer().listen(stale, () => {
      // keep the file after closing: unref and kill the listener without unlinking
      server.close(resolve);
    });
  });
  fs.writeFileSync(path.join(dir, "marker"), "x");
  const revived = createBridgeServer({ path: stale, settings: () => SETTINGS, harness: {} });
  await revived.listen();
  t.after(() => revived.close());
  const w = await connect(t, stale);
  assert.deepEqual((await w.call("settings.get", {})).result, SETTINGS);
});

test("a regular file at the endpoint is refused, not deleted", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, "d", "bridge.sock");
  fs.mkdirSync(path.dirname(p), { mode: 0o700 });
  fs.writeFileSync(p, "precious");
  const bridge = createBridgeServer({ path: p, settings: () => SETTINGS, harness: {} });
  await assert.rejects(bridge.listen(), /not a socket/);
  assert.equal(fs.readFileSync(p, "utf8"), "precious");
});

test("an existing group-accessible directory is refused and its mode left alone", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared, { mode: 0o755 });
  fs.chmodSync(shared, 0o755);
  const bridge = createBridgeServer({ path: path.join(shared, "bridge.sock"), settings: () => SETTINGS, harness: {} });
  await assert.rejects(bridge.listen(), /must be 0700/);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o755);
});

test("a created directory is 0700; an existing private directory is accepted", async (t) => {
  const { dir } = await start(t); // the bridge created <dir>/d
  assert.equal(fs.statSync(path.join(dir, "d")).mode & 0o777, 0o700);
  const again = createBridgeServer({ path: path.join(dir, "d", "other.sock"), settings: () => SETTINGS, harness: {} });
  await again.listen();
  await again.close();
});

test("a directory owned by another uid is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  try {
    assert.throws(() => ensureBridgeDir(path.join(dir, "bridge.sock"), (process.getuid?.() ?? 0) + 1), /not owned by uid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("connections beyond the cap get a too_many_connections frame and are closed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  const socketPath = path.join(dir, "d", "bridge.sock");
  const bridge = createBridgeServer({ path: socketPath, settings: () => SETTINGS, harness: {}, maxConnections: 2 });
  await bridge.listen();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = await connect(t, socketPath);
  const b = await connect(t, socketPath);
  assert.deepEqual((await a.call("settings.get", {})).result, SETTINGS);
  assert.deepEqual((await b.call("settings.get", {})).result, SETTINGS);
  const c = worker(socketPath);
  await c.ready;
  assert.equal((await c.incoming((f) => f.error)).error.code, "too_many_connections");
  await c.closed;
  a.end();
  await a.closed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const d = await connect(t, socketPath); // a slot is free again
  assert.deepEqual((await d.call("settings.get", {})).result, SETTINGS);
});

test("a partial frame that never completes is cut off after the deadline", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  const socketPath = path.join(dir, "d", "bridge.sock");
  const bridge = createBridgeServer({ path: socketPath, settings: () => SETTINGS, harness: {}, frameDeadlineMs: 100 });
  await bridge.listen();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const w = await connect(t, socketPath);
  const error = w.incoming((f) => f.error);
  w.raw('{"v":1,"id":"w:1","meth');
  assert.equal((await error).error.code, "frame_timeout");
  await w.closed;
});

test("a complete frame resets the deadline: slow but finished frames are served", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  const socketPath = path.join(dir, "d", "bridge.sock");
  const bridge = createBridgeServer({ path: socketPath, settings: () => SETTINGS, harness: {}, frameDeadlineMs: 150 });
  await bridge.listen();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const w = await connect(t, socketPath);
  w.raw('{"v":1,"id":"w:1",');
  await new Promise((resolve) => setTimeout(resolve, 60));
  w.raw('"method":"settings.get","params":{}}\n');
  assert.deepEqual((await w.incoming((f) => f.id === "w:1")).result, SETTINGS);
  await new Promise((resolve) => setTimeout(resolve, 250)); // idle between frames is not a partial frame
  assert.deepEqual((await w.call("settings.get", {})).result, SETTINGS);
});

test("a worker request must carry a w: id", async (t) => {
  const { socketPath } = await start(t);
  const w = await connect(t, socketPath);
  w.raw(`${JSON.stringify({ v: 1, id: "p:1", method: "settings.get", params: {} })}\n`);
  const reply = await w.incoming((f) => f.id === "p:1");
  assert.equal(reply.error.code, "bad_frame");
});

test("a messageId cannot forge a log line", async (t) => {
  const { socketPath, logs } = await start(t);
  const w = await connect(t, socketPath);
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  await w.call("lane.steer", { sessionKey: KEY, messageId: "x\nsessionbus: steer forged eligible=true", text: "x" });
  assert.equal(logs.filter((line) => line.includes("\n")).length, 0);
  assert.ok(logs.some((line) => line.includes("x_sessionbus:_steer_forged_eligible_true")));
});

/** A unix socket file whose listener died (SIGKILL leaves the file behind). */
async function staleSocket(dir) {
  const file = path.join(dir, "d", "bridge.sock");
  fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.ok(fs.lstatSync(file).isSocket(), "the dead listener left its socket file");
  return file;
}

test("a dead listener's socket is removed on ECONNREFUSED and the new bridge binds", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = await staleSocket(dir);
  const bridge = createBridgeServer({ path: file, settings: () => SETTINGS, harness: {} });
  await bridge.listen();
  t.after(() => bridge.close());
  const w = await connect(t, file);
  assert.deepEqual((await w.call("settings.get", {})).result, SETTINGS);
});

test("an unexpected probe error (not ECONNREFUSED) refuses to delete the socket", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = await staleSocket(dir);
  const probe = () => {
    const emitter = new EventEmitter();
    emitter.destroy = () => {};
    setImmediate(() => emitter.emit("error", Object.assign(new Error("denied"), { code: "EACCES" })));
    return emitter;
  };
  await assert.rejects(clearStaleSocket(file, probe), /not usable \(EACCES\)/);
  assert.ok(fs.existsSync(file));
});

test("close() of a server that lost the bind race leaves the winner's socket alone", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  const socketPath = path.join(dir, "d", "bridge.sock");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = createBridgeServer({ path: socketPath, settings: () => SETTINGS, harness: {} });
  const b = createBridgeServer({ path: socketPath, settings: () => SETTINGS, harness: {} });
  // Both pass the stale-socket check (no file yet); one bind wins, the other gets EADDRINUSE.
  const outcomes = await Promise.allSettled([a.listen(), b.listen()]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
  const [winner, loser] = outcomes[0].status === "fulfilled" ? [a, b] : [b, a];
  t.after(() => winner.close());
  await loser.close();
  assert.ok(fs.existsSync(socketPath), "the winner's socket survived the loser's close");
  const w = await connect(t, socketPath);
  assert.deepEqual((await w.call("settings.get", {})).result, SETTINGS);
});

test("registration and unregistration are logged with the session key (LV-1 evidence)", async (t) => {
  const { socketPath, logs } = await start(t);
  const w = await connect(t, socketPath);
  await w.call("lane.register", { sessionKey: KEY, agentId: "lane", acpSessionId: "a" });
  assert.ok(logs.includes(`sessionbus: lane registered ${KEY} agent=lane`), logs.join("\n"));
  w.end();
  await w.closed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(logs.includes(`sessionbus: lane unregistered ${KEY}`), logs.join("\n"));
});
