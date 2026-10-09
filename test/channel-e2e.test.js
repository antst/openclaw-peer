// TW-P2b — public-surface e2e tests for a bus turn of the `sessionbus` channel
// (PLAN bus-0512, Test-writer stream, must-have «Ответ агента никуда не уходит сам»).
// Written from the PLAN `## Interface` («Канальный контекст» dispatch delivery, «Tool offer» D7)
// and the test-double contract in `## Test-writer stream`: fake host `createFakeHost`
// (`host.startChannel()`, `host.runtime.dispatches`, `host.tool({agentId, sessionKey})`),
// fake daemon (`daemon.deliver`, `daemon.requests`, `daemon.sends`).
import assert from "node:assert/strict";
import test from "node:test";
import { loadPluginEntry } from "./support/openclaw-sdk.js";
import { createFakeHost } from "./support/fake-openclaw.js";
import { createFakeDaemon } from "./support/fake-daemon.js";

const AGENT = "advisor";
const SENDER = "other@host";
const SESSION_KEY = `agent:${AGENT}:sessionbus:direct:${SENDER}`;
// resolveConfig default binding when the plugin config carries no explicit sessionKey
// (src/config.js: `agent:${agentId}:main`) — the owner session key (D4).
const OWNER_SESSION_KEY = `agent:${AGENT}:main`;

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function busConfig(overrides = {}) {
  return {
    agents: { entries: { advisor: {} } },
    channels: { sessionbus: { enabled: true } },
    plugins: {
      entries: {
        sessionbus: {
          config: {
            socket: "/tmp/fake.sock",
            agents: { advisor: { enabled: true, groups: ["g"] } },
          },
        },
      },
    },
    ...overrides,
  };
}

async function startedChannelFixture(t, config = busConfig()) {
  const daemon = createFakeDaemon();
  const host = createFakeHost({ config, version: "2026.8.2", connect: (path) => daemon.connect(path) });
  t.after(() => host.stop());
  host.register(await loadPluginEntry());
  await host.start();
  await host.startChannel();
  await waitFor(() => daemon.hellos.length === 1);
  return { daemon, host };
}

function senderRequest(overrides = {}) {
  return {
    message_id: "m1",
    from: { session_id: SENDER, product: "claude-peer", groups: ["g"] },
    body: "hello from the federation",
    ...overrides,
  };
}

test("a bus turn's final text is not sent; the tool in the bus session is", async (t) => {
  const { daemon, host } = await startedChannelFixture(t);

  const receipt = await daemon.deliver(senderRequest());
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 1);
  const dispatch = host.runtime.dispatches[0];
  assert.equal(dispatch.sessionKey, SESSION_KEY);

  // The agent finishes its turn: the host hands the final reply back through the channel
  // runtime's `delivery.deliver` (Interface «Канальный контекст»: deliver only logs
  // `sessionbus: reply suppressed`, it never sends on its own).
  const requestsBefore = daemon.requests.length;
  await dispatch.delivery.deliver({ body: "the agent's final answer" }, { kind: "final" });
  assert.equal(
    daemon.requests.filter((request) => request.method === "message.send").length,
    0,
    "a bus turn's final text must not be sent back to the bus",
  );
  assert.equal(daemon.sends.length, 0);

  // An explicit tool `send` from the bus session works: the recorded channel route
  // offers the `sessionbus` tool there (D7) and the action reaches the daemon.
  const tool = host.tool({ agentId: AGENT, sessionKey: SESSION_KEY });
  assert.ok(tool, "the sessionbus tool must be offered in the bus session key");
  assert.equal(tool.name, "sessionbus");
  const result = await tool.execute("call1", {
    action: "send",
    arguments: { target: "x@host", message: "hi from the bus session" },
  });
  assert.equal(result.content[0].type, "text");
  assert.equal(daemon.sends.length, 1);
  assert.equal(daemon.sends[0].target, "x@host");
  assert.equal(daemon.sends[0].message, "hi from the bus session");
  assert.ok(
    daemon.requests.length > requestsBefore,
    "the tool send must reach the daemon as a message.send request",
  );
  await host.release(SESSION_KEY);
});

test("owner session tool stays available and bus session key differs from it", async (t) => {
  const { daemon, host } = await startedChannelFixture(t);

  // U-05: the owner's own session (`agent:<id>:main`) keeps the tool; the bus channel
  // mints a separate per-peer session key (`agent:<id>:sessionbus:direct:<sender>`), so
  // the owner's Telegram/main session identity never changes.
  const ownerTool = host.tool({ agentId: AGENT, sessionKey: OWNER_SESSION_KEY });
  assert.ok(ownerTool, "the sessionbus tool stays available in the owner session key");
  assert.equal(ownerTool.name, "sessionbus");

  assert.notEqual(SESSION_KEY, OWNER_SESSION_KEY);
  assert.match(SESSION_KEY, /^agent:advisor:sessionbus:direct:/);

  // Without a bus delivery there is no recorded channel route: the tool is not offered
  // in an unrelated session key (D7 «nothing else»).
  assert.equal(host.tool({ agentId: AGENT, sessionKey: "agent:advisor:telegram:direct:123" }), undefined);
  assert.equal(daemon.sends.length, 0);
});
