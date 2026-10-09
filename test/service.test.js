import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeDaemon } from "./support/fake-daemon.js";
import { createFakeRuntime, createStrictLogger } from "./support/fake-openclaw.js";
import { createBridgeServer } from "../src/bridge.js";
import { createPeerService } from "../src/service.js";

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function makeLogger() {
  const calls = { error: [], warn: [], info: [], debug: [] };
  return { calls, ...createStrictLogger(calls) };
}

function twoAgentConfig() {
  return {
    agents: { entries: { advisor: {}, other: {}, third: {} } },
    plugins: {
      entries: {
        sessionbus: {
          config: {
            socket: "/tmp/fake.sock",
            agents: {
              advisor: { enabled: true, groups: ["g"], sessionKey: "agent:advisor:main" },
              other: { enabled: true, groups: ["g2"], name: "Other" },
              third: { enabled: false },
            },
          },
        },
      },
    },
  };
}

function singleAgentConfig() {
  return {
    agents: { entries: { advisor: {} } },
    plugins: {
      entries: {
        sessionbus: {
          config: { socket: "/tmp/fake.sock", agents: { advisor: { enabled: true, groups: ["g"], sessionKey: "agent:advisor:main" } } },
        },
      },
    },
  };
}

function buildService({ daemon, runtime, schedule } = {}) {
  return createPeerService(
    { runtime },
    {
      connect: (path) => daemon.connect(path),
      schedule: schedule ?? ((call) => call()),
      env: {},
      uid: 1000,
    },
  );
}

test("two enabled + one disabled: two hellos with correct identity, third has no peer", async (t) => {
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({ version: "2026.8.2", config: twoAgentConfig() });
  const service = buildService({ daemon, runtime });
  t.after(() => service.stop());
  service.start();
  await Promise.all([service.peerFor("advisor").ready, service.peerFor("other").ready]);

  assert.equal(daemon.hellos.length, 2);
  const advisorHello = daemon.hellos.find((h) => h.session_id === "openclaw-advisor");
  const otherHello = daemon.hellos.find((h) => h.session_id === "openclaw-other");
  assert.deepEqual(advisorHello.groups, ["g"]);
  assert.deepEqual(advisorHello.info, { agent_id: "advisor", session_key: "agent:advisor:main", openclaw_version: "2026.8.2" });
  assert.equal(otherHello.name, "Other");
  assert.deepEqual(otherHello.info, { agent_id: "other", session_key: "agent:other:main", openclaw_version: "2026.8.2" });
  assert.equal(service.peerFor("third"), undefined);

  await service.stop();
  assert.equal(service.peerFor("advisor"), undefined);
  assert.equal(service.peerFor("other"), undefined);
});

test("restart reuses the same session ids", async (t) => {
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({ version: "2026.8.2", config: singleAgentConfig() });
  const service = buildService({ daemon, runtime });
  t.after(() => service.stop());
  service.start();
  await service.peerFor("advisor").ready;
  await service.stop();

  service.start();
  await service.peerFor("advisor").ready;
  assert.equal(daemon.hellos.length, 2);
  assert.equal(daemon.hellos[1].session_id, "openclaw-advisor");
  await service.stop();
});

test("start() without a completed stop() tears down the old state first", async (t) => {
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({ version: "2026.8.2", config: singleAgentConfig() });
  const service = buildService({ daemon, runtime });
  t.after(() => service.stop());
  const logger = makeLogger();
  service.start({ logger });
  await service.peerFor("advisor").ready;
  const oldPeer = service.peerFor("advisor");

  await service.start({ logger });
  await service.peerFor("advisor").ready;

  assert.ok(logger.calls.warn.some(([msg]) => /leftover/.test(msg)));
  assert.equal(daemon.hellos.length, 2);
  // The old connection was closed (awaited) before the new one was built.
  await Promise.race([oldPeer.closed, new Promise((_r, reject) => setTimeout(() => reject(new Error("old peer never closed")), 500))]);

  await service.stop();
});

test("groups changed across stop/start: fresh hello with new groups on a new connection", async (t) => {
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({ version: "2026.8.2", config: singleAgentConfig() });
  const service = buildService({ daemon, runtime });
  t.after(() => service.stop());
  service.start();
  await service.peerFor("advisor").ready;
  await service.stop();

  runtime.config.current().plugins.entries.sessionbus.config.agents.advisor.groups = ["g", "h"];
  service.start();
  await service.peerFor("advisor").ready;

  assert.equal(daemon.hellos.length, 2);
  assert.deepEqual(daemon.hellos[1].groups, ["g", "h"]);
  await service.stop();
});

test("drop(): peer reconnects with the same identity", async (t) => {
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({ version: "2026.8.2", config: singleAgentConfig() });
  const service = buildService({ daemon, runtime });
  t.after(() => service.stop());
  service.start();
  const peer = service.peerFor("advisor");
  await peer.ready;
  assert.equal(daemon.hellos.length, 1);

  daemon.drop();
  await waitFor(() => daemon.hellos.length === 2);
  await peer.ready;
  assert.equal(daemon.hellos[1].session_id, "openclaw-advisor");
  await service.stop();
});

test("supersede(): logged as superseded, no reconnect", async (t) => {
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({ version: "2026.8.2", config: singleAgentConfig() });
  const service = buildService({ daemon, runtime });
  t.after(() => service.stop());
  const logger = makeLogger();
  service.start({ logger });
  await service.peerFor("advisor").ready;

  await daemon.supersede();
  await waitFor(() => logger.calls.error.length > 0);
  assert.match(logger.calls.error[0][0], /openclaw-advisor/);
  assert.match(logger.calls.error[0][0], /superseded/);
  assert.equal(logger.calls.error[0][0], "sessionbus peer openclaw-advisor superseded by another connection");
  assert.equal(daemon.hellos.length, 1);
  await service.stop();
});

test("hello answered -32602: error logged with id and code, no reconnect, no throw", async (t) => {
  const daemon = createFakeDaemon({ helloError: { code: -32602 } });
  const runtime = createFakeRuntime({ version: "2026.8.2", config: singleAgentConfig() });
  const service = buildService({ daemon, runtime });
  t.after(() => service.stop());
  const logger = makeLogger();
  assert.doesNotThrow(() => service.start({ logger }));
  await waitFor(() => logger.calls.error.length > 0);
  assert.match(logger.calls.error[0][0], /openclaw-advisor/);
  assert.match(logger.calls.error[0][0], /32602/);
  assert.equal(daemon.hellos.length, 1);
  await service.stop();
});

test("invalid config: logged, no peer created, no throw", (t) => {
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({
    version: "2026.8.2",
    config: { agents: { entries: { advisor: {} } }, plugins: { entries: { sessionbus: { config: { agents: { advisor: { enabled: true } } } } } } },
  });
  const service = buildService({ daemon, runtime });
  t.after(() => service.stop());
  const logger = makeLogger();
  assert.doesNotThrow(() => service.start({ logger }));
  assert.equal(service.peerFor("advisor"), undefined);
  assert.ok(logger.calls.error.length > 0);
});


// ---- worker bridge lifecycle (D5): the plugin's bridge lives exactly as long as its service.
function bridgeService(t, { createBridge, lanes } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "svc-br-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, "d", "bridge.sock");
  const daemon = createFakeDaemon();
  const config = singleAgentConfig();
  if (lanes !== null) config.plugins.entries.sessionbus.config.lanes = lanes ?? { agents: { advisor: {} }, credentialDir: "/c" };
  const runtime = createFakeRuntime({ version: "2026.8.2", config });
  const service = createPeerService({ runtime }, {
    connect: (p) => daemon.connect(p), schedule: (call) => call(), env: { SESSIONBUS_OPENCLAW_BRIDGE: socketPath }, uid: 1000,
    harness: { resolveActiveEmbeddedRunSessionId: () => undefined, queueAgentHarnessMessage: () => false },
    lanes: { resolveStateDir: () => dir, resolveAgentWorkspaceDir: () => "/w", resolveDefaultModelForAgent: () => undefined },
    ...(createBridge ? { createBridge } : {}),
  });
  t.after(() => service.stop());
  return { service, socketPath, runtime, daemon };
}

test("stop closes the bridge: the socket is gone and a connected worker is dropped", async (t) => {
  const { service, socketPath } = bridgeService(t);
  await service.start({ logger: makeLogger() });
  const worker = net.createConnection(socketPath);
  await new Promise((resolve) => worker.once("connect", resolve));
  const closed = new Promise((resolve) => worker.once("close", resolve));
  assert.ok(existsSync(socketPath));
  await service.stop();
  await closed;
  assert.equal(existsSync(socketPath), false);
});

test("stop during listen leaves no orphaned bridge and the next start binds", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const created = [];
  const { service, socketPath } = bridgeService(t, {
    createBridge: (options) => {
      const real = createBridgeServer(options);
      const wrapped = { ...real, listen: async () => { await real.listen(); await gate; } };
      created.push(wrapped);
      return wrapped;
    },
  });
  const starting = service.start({ logger: makeLogger() });
  await waitFor(() => created.length === 1 && existsSync(socketPath));
  const stopping = service.stop();
  release();
  await Promise.all([starting, stopping]);
  assert.equal(existsSync(socketPath), false, "the bridge that finished listening after stop() was closed");
  // The next start gets the endpoint without "already served".
  const logger = makeLogger();
  await service.start({ logger });
  assert.equal(logger.calls.error.some(([msg]) => /bridge/.test(msg)), false, JSON.stringify(logger.calls.error));
  assert.ok(existsSync(socketPath));
});

test("settings.get says why lanes are unusable: not configured vs invalid", async (t) => {
  const ask = async (lanes) => {
    const { service, socketPath } = bridgeService(t, { lanes });
    await service.start({ logger: makeLogger() });
    const worker = net.createConnection(socketPath);
    await new Promise((resolve) => worker.once("connect", resolve));
    const reply = await new Promise((resolve) => {
      worker.setEncoding("utf8");
      worker.once("data", (chunk) => resolve(JSON.parse(chunk.split("\n")[0])));
      worker.write(`${JSON.stringify({ v: 1, id: "w:1", method: "settings.get", params: {} })}\n`);
    });
    worker.destroy();
    await service.stop();
    return reply.error;
  };
  const absent = await ask(null);
  assert.equal(absent.code, "lanes_not_configured");
  assert.match(absent.message, /not configured/);
  const invalid = await ask({ agents: { advisor: {} }, credentialDir: "relative" });
  assert.equal(invalid.code, "lanes_not_configured");
  assert.match(invalid.message, /lanes invalid: .*credentialDir/);
});
