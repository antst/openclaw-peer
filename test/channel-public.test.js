// TW-P1 — public-surface tests for the `sessionbus` channel (PLAN bus-0512, Test-writer stream).
// Written from the PLAN `## Interface` and the test-double contract in `## Test-writer stream`:
//   fake host `createFakeHost({config, version})` — `host.register(entry)`, `host.start()`,
//   `host.startChannel()`, `host.runtime.dispatches` / `.heartbeatRequests`, `host.release(key)`,
//   `host.registrations[i].channelPlugin`; fake daemon `daemon.deliver` / `.hellos`.
// Red until the developer's wave P1 lands the channel runtime — expected.
import assert from "node:assert/strict";
import test from "node:test";
import { loadPluginEntry } from "./support/openclaw-sdk.js";
import { createFakeHost } from "./support/fake-openclaw.js";
import { createFakeDaemon } from "./support/fake-daemon.js";

const AGENT = "advisor";
const SENDER = "other@host";
const SESSION_KEY = `agent:${AGENT}:sessionbus:direct:${SENDER}`;

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

function buildFixture({ config = busConfig(), version = "2026.8.2" } = {}) {
  const daemon = createFakeDaemon();
  const host = createFakeHost({ config, version, connect: (path) => daemon.connect(path) });
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

test("idle delivery dispatches one channel turn and requests no heartbeat", async (t) => {
  const { daemon, host } = buildFixture();
  t.after(() => host.stop());
  host.register(await loadPluginEntry());
  await host.start();
  await host.startChannel();
  await waitFor(() => daemon.hellos.length === 1);

  const receipt = await daemon.deliver(senderRequest());
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });

  await waitFor(() => host.runtime.dispatches.length === 1);
  const dispatch = host.runtime.dispatches[0];
  assert.equal(dispatch.sessionKey, SESSION_KEY);
  assert.equal(dispatch.steered, false);
  assert.equal(dispatch.ctxPayload.channel, "sessionbus");
  assert.equal(dispatch.ctxPayload.route.dispatchSessionKey, SESSION_KEY);
  // bodyForAgent is renderInbound(request) — an envelope that contains the original text.
  assert.ok(dispatch.ctxPayload.message.bodyForAgent.includes("hello from the federation"));
  // The channel is the only wake path (U-07): no heartbeat request anywhere.
  assert.equal(host.runtime.heartbeatRequests.length, 0);
  await host.release(SESSION_KEY);
});

test("delivery before startAccount is rejected with the enable hint", async (t) => {
  const { daemon, host } = buildFixture();
  t.after(() => host.stop());
  host.register(await loadPluginEntry());
  await host.start();
  await waitFor(() => daemon.hellos.length === 1);

  const receipt = await daemon.deliver(senderRequest());
  assert.equal(receipt.disposition, "rejected");
  assert.match(receipt.reason, /channels\.sessionbus\.enabled/);
  assert.equal(host.runtime.dispatches.length, 0);
  assert.equal(host.runtime.heartbeatRequests.length, 0);
});

test("channel account disabled rejects immediately", async (t) => {
  const { daemon, host } = buildFixture({ config: busConfig({ channels: {} }) });
  t.after(() => host.stop());
  host.register(await loadPluginEntry());
  await host.start();
  await host.startChannel();
  await waitFor(() => daemon.hellos.length === 1);

  const started = Date.now();
  const receipt = await daemon.deliver(senderRequest());
  assert.equal(receipt.disposition, "rejected");
  assert.match(receipt.reason, /channels\.sessionbus\.enabled/);
  // Interface receipt rule (5): a disabled account rejects without the startup wait window.
  assert.ok(Date.now() - started < 2000, "disabled account must reject immediately");
  assert.equal(host.runtime.dispatches.length, 0);
  assert.equal(host.runtime.heartbeatRequests.length, 0);
});

test("slash and stop text reach the agent as text with both command flags set", async (t) => {
  const { daemon, host } = buildFixture();
  t.after(() => host.stop());
  host.register(await loadPluginEntry());
  await host.start();
  await host.startChannel();
  await waitFor(() => daemon.hellos.length === 1);

  const bodies = ["/status", "stop", "text /model x text", "/some-skill inline"];
  for (let i = 0; i < bodies.length; i++) {
    const receipt = await daemon.deliver(senderRequest({ message_id: `slash-${i}`, body: bodies[i] }));
    assert.deepEqual(receipt, { disposition: "queued_for_next_turn" }, bodies[i]);
    await host.release(SESSION_KEY);
  }

  await waitFor(() => host.runtime.dispatches.length === bodies.length);
  host.runtime.dispatches.forEach((dispatch, i) => {
    // D11: the agent must see the raw text, never a command interpretation. The real 8.2 host
    // spreads `extra` into the context root — src/channels/inbound-event/context.ts:592
    // `...params.extra` in buildChannelInboundEventContext (optional on MsgContext at
    // src/auto-reply/templating.ts:365); command handling reads it at the root,
    // src/auto-reply/reply/commands-core.ts:37 `params.ctx.CommandInterpretationSuppressed === true`.
    assert.equal(dispatch.ctxPayload.CommandInterpretationSuppressed, true, bodies[i]);
    assert.equal(dispatch.ctxPayload.access.commands.authorized, false, bodies[i]);
    assert.ok(dispatch.ctxPayload.message.bodyForAgent.includes(bodies[i]), bodies[i]);
  });
  assert.equal(host.runtime.heartbeatRequests.length, 0);
});

test("channel adapter enforces owner-only command authorization", async (t) => {
  const { host } = buildFixture();
  t.after(() => host.stop());
  host.register(await loadPluginEntry());
  await host.start();

  // D25: the static adapter flag, independent of ctx.Provider (second layer on 8.2).
  const registration = host.registrations.find((item) => item.channelPlugin);
  assert.ok(registration, "the plugin entry must register a channel plugin");
  assert.equal(registration.channelPlugin.commands.enforceOwnerForCommands, true);
});

let pluginEntry;
test("plugin entry keeps reload.restartPrefixes", async () => {
  pluginEntry ??= await loadPluginEntry();
  // D10: the reload prefix survives the channel entry (8.2 plugin-sdk does not carry `reload` through).
  assert.deepEqual(pluginEntry.reload?.restartPrefixes, ["plugins.entries.sessionbus"]);
});

// ---------------------------------------------------------------- TW-P2a
// Receipt rules (1)–(4), (6); D6; D23; PC-03 — through the same public channel surface.

async function startedChannelFixture(t, config = busConfig()) {
  const fixture = buildFixture({ config });
  t.after(() => fixture.host.stop());
  fixture.host.register(await loadPluginEntry());
  await fixture.host.start();
  await fixture.host.startChannel();
  await waitFor(() => fixture.daemon.hellos.length === 1);
  return fixture;
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

test("busy delivery of the same sender steers the active turn", async (t) => {
  const { daemon, host } = await startedChannelFixture(t);

  const first = await daemon.deliver(senderRequest({ message_id: "busy-1" }));
  assert.deepEqual(first, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 1);
  assert.equal(host.runtime.dispatches[0].steered, false);

  // The first turn is still active (not released): the same sender's next message steers it.
  const second = await daemon.deliver(senderRequest({ message_id: "busy-2" }));
  assert.deepEqual(second, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 2);
  assert.equal(host.runtime.dispatches[1].sessionKey, SESSION_KEY);
  assert.equal(host.runtime.dispatches[1].steered, true);
  await host.release(SESSION_KEY);
});

test("retransmitted message_id dispatches once and reuses the receipt", async (t) => {
  const { daemon, host } = await startedChannelFixture(t);

  const first = await daemon.deliver(senderRequest({ message_id: "retx-1" }));
  assert.deepEqual(first, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 1);

  // Duplicate while the dispatch is still pending: same receipt, no second dispatch.
  const pendingDup = await daemon.deliver(senderRequest({ message_id: "retx-1" }));
  assert.deepEqual(pendingDup, first);
  assert.equal(host.runtime.dispatches.length, 1);

  // Duplicate after the turn settled: the ledger still answers from the stored receipt (D6).
  await host.release(SESSION_KEY);
  await settle();
  const settledDup = await daemon.deliver(senderRequest({ message_id: "retx-1" }));
  assert.deepEqual(settledDup, first);
  assert.equal(host.runtime.dispatches.length, 1);
});

test("a dispatch that fails after the receipt lets the retransmission dispatch again", async (t) => {
  const { daemon, host } = await startedChannelFixture(t);

  const first = await daemon.deliver(senderRequest({ message_id: "fail-1" }));
  assert.deepEqual(first, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 1);

  host.failNextDispatch(new Error("host rejected the turn"));
  await settle(); // the rejected dispatch promise moves the ledger entry to error (PC-03)

  const again = await daemon.deliver(senderRequest({ message_id: "fail-1" }));
  assert.deepEqual(again, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 2);
  await host.release(SESSION_KEY);
});

test("message over 64 KiB is rejected", async (t) => {
  const { daemon, host } = await startedChannelFixture(t);

  const receipt = await daemon.deliver(senderRequest({ body: "x".repeat(65537) }));
  assert.equal(receipt.disposition, "rejected");
  assert.match(receipt.reason, /64 KiB/);
  assert.equal(host.runtime.dispatches.length, 0);
});

test("17th pending dispatch for one agent is rejected as backlog", async (t) => {
  const { daemon, host } = await startedChannelFixture(t);

  for (let i = 0; i < 16; i++) {
    const receipt = await daemon.deliver(senderRequest({ message_id: `backlog-${i}` }));
    assert.deepEqual(receipt, { disposition: "queued_for_next_turn" }, `backlog-${i}`);
  }
  await waitFor(() => host.runtime.dispatches.length === 16);

  const overflow = await daemon.deliver(senderRequest({ message_id: "backlog-16" }));
  assert.equal(overflow.disposition, "rejected");
  assert.match(overflow.reason, /backlog/);
  assert.equal(host.runtime.dispatches.length, 16);
  await host.release(SESSION_KEY);
});

test("loop-guard refusal rejects without dispatch", async (t) => {
  // The guard reads channels.defaults.botLoopProtection (PairGuard.fromConfig): one event per
  // window for this pair, so the second bus message from the same sender is refused.
  const { daemon, host } = await startedChannelFixture(t, busConfig({
    channels: { sessionbus: { enabled: true }, defaults: { botLoopProtection: { maxEventsPerWindow: 1 } } },
  }));

  const first = await daemon.deliver(senderRequest({ message_id: "guard-1" }));
  assert.deepEqual(first, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 1);

  const second = await daemon.deliver(senderRequest({ message_id: "guard-2" }));
  assert.equal(second.disposition, "rejected");
  assert.match(second.reason, /loop guard/);
  assert.equal(host.runtime.dispatches.length, 1);
  await host.release(SESSION_KEY);
});

test("a route resolved to another agent is refused", async (t) => {
  // An operator binding that routes this very sender to a different agent (tier peer). Channel- and account-wide bindings
  // no longer do: the plugin's synthetic peer-wildcard binding for the addressee outranks them (PLAN Amendment 3,
  // owner-approved change of this contract). In OpenClaw 8.2 `bindings` is an array of route/acp bindings
  // (src/config/zod-schema.agents.ts:154 BindingsSchema = z.array(z.union([RouteBindingSchema, AcpBindingSchema]))).
  const { daemon, host } = await startedChannelFixture(t, busConfig({
    bindings: [{ type: "route", agentId: "other", match: { channel: "sessionbus", peer: { kind: "direct", id: senderRequest().from.session_id } } }],
  }));

  const receipt = await daemon.deliver(senderRequest());
  assert.equal(receipt.disposition, "rejected");
  assert.equal(receipt.reason, "route_mismatch");
  assert.equal(host.runtime.dispatches.length, 0);
});

test("wildcard and explicit commands.allowFrom do not reauthorize bus input", async (t) => {
  const config = busConfig({
    commands: { allowFrom: { "*": ["*"], telegram: ["bob"] } },
  });
  const { daemon, host } = await startedChannelFixture(t, config);

  const receipt = await daemon.deliver(senderRequest({ message_id: "allow-1" }));
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });
  await waitFor(() => host.runtime.dispatches.length === 1);

  const dispatched = host.runtime.dispatches[0];
  // D23: the per-dispatch projection empties only the sessionbus list; the rest survives.
  assert.deepEqual(dispatched.cfg.commands.allowFrom.sessionbus, []);
  assert.deepEqual(dispatched.cfg.commands.allowFrom["*"], ["*"]);
  assert.deepEqual(dispatched.cfg.commands.allowFrom.telegram, ["bob"]);
  assert.equal(dispatched.ctxPayload.channel, "sessionbus");

  // The operator's config object is never mutated.
  const live = host.runtime.config.current().commands.allowFrom;
  assert.deepEqual(live["*"], ["*"]);
  assert.deepEqual(live.telegram, ["bob"]);
  assert.equal("sessionbus" in live, false);
  await host.release(SESSION_KEY);
});
