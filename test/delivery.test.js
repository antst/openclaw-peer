import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDaemon } from "./support/fake-daemon.js";
import { createFakeHost, createFakeRuntime } from "./support/fake-openclaw.js";
import { loadPluginEntry } from "./support/openclaw-sdk.js";
import { buildChannelInboundEventContext, createChannelInboundEnvelopeBuilder, resolveChannelInboundRouteEnvelope } from "./support/openclaw-sdk/channel-inbound.js";
import { createPeerService } from "../src/service.js";
import { boundPeerId } from "../src/delivery.js";
import { resetChannelRuntimeForTest } from "../src/active.js";
import { renderInbound } from "../src/render.js";

const CHANNEL_SDK = { buildChannelInboundEventContext, createChannelInboundEnvelopeBuilder, resolveChannelInboundRouteEnvelope };
const SENDER = "other@host";

function config({ enabled = true, bindings, agentsExtra = false, busSessionBinding, session, loopBudget } = {}) {
  return {
    agents: { entries: { advisor: {}, ...(agentsExtra ? { hotadded: {} } : {}) } },
    ...(bindings ? { bindings } : {}),
    ...(session ? { session } : {}),
    ...(enabled ? { channels: { sessionbus: { enabled: true }, ...(loopBudget ? { defaults: { botLoopProtection: { maxEventsPerWindow: loopBudget } } } : {}) } } : {}),
    plugins: { entries: { sessionbus: { config: { socket: "/tmp/fake.sock", ...(busSessionBinding ? { busSessionBinding } : {}), agents: { advisor: { enabled: true, groups: ["g"] } } } } } },
  };
}

async function fixture(t, { version = "2026.8.2", attach = true, now, ...options } = {}) {
  resetChannelRuntimeForTest();
  t.after(resetChannelRuntimeForTest);
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({ version, config: config(options) });
  const service = createPeerService({ runtime }, { channelSdk: CHANNEL_SDK, connect: (path) => daemon.connect(path), schedule: (fn) => fn(), env: {}, uid: 1000, ...(now ? { now } : {}) });
  t.after(() => service.stop());
  service.start({ logger: runtime.logger });
  await service.peerFor("advisor").ready;
  if (attach) service.attachChannel(runtime.channelRuntime);
  const deliver = (body, id = "m1") => daemon.deliver({ message_id: id, from: { session_id: SENDER, product: "claude-peer", groups: ["g"] }, body });
  const deliverFrom = (from, body = "hi", id = "m1") => daemon.deliver({ message_id: id, from: { product: "claude-peer", groups: ["g"], ...from }, body });
  return { daemon, runtime, service, deliver, deliverFrom };
}

test("idle delivery dispatches one channel turn and requests no heartbeat", async (t) => {
  const { runtime, deliver } = await fixture(t);
  const receipt = await deliver("hello from the federation");
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 1);
  assert.equal(runtime.dispatches[0].sessionKey, "agent:advisor:sessionbus:direct:other@host");
  assert.equal(runtime.dispatches[0].steered, false);
  assert.match(runtime.dispatches[0].ctxPayload.message.bodyForAgent, /hello from the federation/);
  assert.equal(runtime.heartbeatRequests.length, 0);
});

test("idle delivery also works through the 9.x ingress path", async (t) => {
  const { runtime, deliver } = await fixture(t, { version: "2026.9.8" });
  assert.deepEqual(await deliver("hi"), { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 1);
  assert.deepEqual(runtime.dispatches[0].ctxPayload.channelIngress, { ingress: { admission: "dispatch" } });
});

test("slash and stop text reach the agent as text with both command flags set", async (t) => {
  const { runtime, deliver } = await fixture(t);
  const texts = ["/status", "please /model x now", "stop", "/some-skill arg"];
  for (const [index, text] of texts.entries()) await deliver(text, `m${index}`);
  assert.equal(runtime.dispatches.length, texts.length);
  for (const [index, text] of texts.entries()) {
    const ctx = runtime.dispatches[index].ctxPayload;
    assert.equal(ctx.CommandInterpretationSuppressed, true);
    assert.equal(ctx.access.commands.authorized, false);
    assert.ok(ctx.message.bodyForAgent.includes(text), `bodyForAgent keeps ${text}`);
    assert.equal(ctx.message.rawBody, text);
  }
});

test("delivery before startAccount is rejected with the enable hint", async (t) => {
  const { runtime, deliver } = await fixture(t, { enabled: false, attach: false });
  const receipt = await deliver("hello");
  assert.equal(receipt.disposition, "rejected");
  assert.match(receipt.reason, /channels\.sessionbus\.enabled/);
  assert.equal(runtime.dispatches.length, 0);
});

test("a peer-specific binding of this sender to another agent is refused", async (t) => {
  const { runtime, deliver } = await fixture(t, { bindings: [{ agentId: "elsewhere", match: { channel: "sessionbus", peer: { kind: "direct", id: SENDER } } }] });
  const receipt = await deliver("x");
  assert.equal(receipt.disposition, "rejected");
  assert.equal(receipt.reason, "route_mismatch", "the receipt carries no local agent or binding details");
  assert.match(runtime.logs.error.map((l) => l[0]).join("\n"), /route_mismatch for .*routes this sender to agent elsewhere, but the message is addressed to advisor/);
  assert.equal(runtime.dispatches.length, 0);
});

test("delivery waits for a late startAccount", async (t) => {
  const { runtime, service, deliver } = await fixture(t, { attach: false });
  const pending = deliver("late");
  setTimeout(() => service.attachChannel(runtime.channelRuntime), 20);
  assert.deepEqual(await pending, { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 1);
});

test("channel adapter enforces owner-only command authorization", async () => {
  const host = createFakeHost({ config: config() });
  host.register(await loadPluginEntry());
  assert.equal(host.registrations[0].channelPlugin.commands.enforceOwnerForCommands, true);
});

test("plugin entry keeps reload.restartPrefixes and starts the channel account through the host", async (t) => {
  const host = createFakeHost({ config: config() });
  const entry = await loadPluginEntry();
  assert.deepEqual(entry.reload, { restartPrefixes: ["plugins.entries.sessionbus"] });
  host.register(entry);
  host.startChannel();
  t.after(() => host.stopChannel());
  assert.equal(host.registrations[0].channelPlugin.id, "sessionbus");
});

const KEY = `agent:advisor:sessionbus:direct:${SENDER}`;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("busy delivery of the same sender steers the active turn", async (t) => {
  const { runtime, deliver } = await fixture(t);
  assert.deepEqual(await deliver("task", "m1"), { disposition: "queued_for_next_turn" });
  assert.deepEqual(await deliver("also", "m2"), { disposition: "queued_for_next_turn" });
  assert.deepEqual(runtime.dispatches.map((d) => [d.sessionKey, d.steered]), [[KEY, false], [KEY, true]]);
  runtime.release(KEY);
});

test("retransmitted message_id dispatches once and reuses the receipt", async (t) => {
  const { runtime, deliver } = await fixture(t);
  const first = await deliver("hello", "dup");
  assert.deepEqual(await deliver("hello", "dup"), first); // pending
  assert.equal(runtime.dispatches.length, 1);
  runtime.release(KEY);
  await settle();
  assert.deepEqual(await deliver("hello", "dup"), first); // settled
  assert.equal(runtime.dispatches.length, 1);
});

test("a dispatch that fails after the receipt lets the retransmission dispatch again", async (t) => {
  const { runtime, deliver } = await fixture(t);
  runtime.failNextDispatch(new Error("host dropped it"));
  assert.deepEqual(await deliver("hello", "f1"), { disposition: "queued_for_next_turn" });
  await settle();
  assert.match(runtime.logs.error.map((l) => l[0]).join("\n"), /dispatch f1 failed after receipt: host dropped it/);
  assert.deepEqual(await deliver("hello", "f1"), { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 2);
  runtime.release(KEY);
});

test("message over 64 KiB is rejected", async (t) => {
  const { runtime, deliver } = await fixture(t);
  const receipt = await deliver("x".repeat(65537));
  assert.deepEqual(receipt, { disposition: "rejected", reason: "message too large (64 KiB limit)" });
  assert.equal(runtime.dispatches.length, 0);
});

test("17th pending dispatch for one agent is rejected as backlog", async (t) => {
  const { runtime, daemon } = await fixture(t);
  const from = (n) => ({ session_id: `s${n}@host`, product: "claude-peer", groups: ["g"] });
  for (let n = 0; n < 16; n++) assert.equal((await daemon.deliver({ message_id: `b${n}`, from: from(n), body: "x" })).disposition, "queued_for_next_turn");
  const receipt = await daemon.deliver({ message_id: "b16", from: from(16), body: "x" });
  assert.deepEqual(receipt, { disposition: "rejected", reason: "OpenClaw session backlog full" });
  for (let n = 0; n < 16; n++) runtime.release(`agent:advisor:sessionbus:direct:s${n}@host`);
  await settle();
  assert.equal((await daemon.deliver({ message_id: "b17", from: from(17), body: "x" })).disposition, "queued_for_next_turn");
  runtime.release("agent:advisor:sessionbus:direct:s17@host");
});

test("wildcard and explicit commands.allowFrom do not reauthorize bus input", async (t) => {
  for (const allowFrom of [{ "*": ["*"] }, { sessionbus: [SENDER] }]) {
    const cfg = { ...config(), commands: { allowFrom: { ...allowFrom, telegram: ["1"] } } };
    const before = structuredClone(cfg);
    const daemon = createFakeDaemon();
    const runtime = createFakeRuntime({ config: cfg });
    const service = createPeerService({ runtime }, { channelSdk: CHANNEL_SDK, connect: (p) => daemon.connect(p), schedule: (fn) => fn(), env: {}, uid: 1000 });
    t.after(() => service.stop());
    service.start();
    await service.peerFor("advisor").ready;
    service.attachChannel(runtime.channelRuntime);
    await daemon.deliver({ message_id: "w1", from: { session_id: SENDER, product: "claude-peer", groups: [] }, body: "/status" });
    const sent = runtime.dispatches[0];
    assert.deepEqual(sent.cfg.commands.allowFrom.sessionbus, []);
    assert.deepEqual(sent.cfg.commands.allowFrom.telegram, ["1"]);
    assert.equal(sent.ctxPayload.channel, "sessionbus");
    assert.deepEqual(cfg, before);
    runtime.release(KEY);
  }
});

test("recorded channel route lands in routeKeys before dispatch", async (t) => {
  const { service, deliver, runtime } = await fixture(t);
  await deliver("hi");
  assert.ok(service.routeKeys("advisor").has(KEY));
  runtime.release(KEY);
});

test("enabling the channel on a running service takes effect without a service restart", async (t) => {
  const { runtime, deliver } = await fixture(t, { enabled: false });
  assert.equal((await deliver("early", "e1")).disposition, "rejected");
  runtime.config.set(config({ enabled: true, agentsExtra: true }));
  const receipt = await deliver("late", "e2");
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches[0].cfg.channels.sessionbus.enabled, true);
  assert.deepEqual(runtime.dispatches[0].cfg.agents.entries.hotadded, {}, "dispatch sees the live config");
  runtime.release(`agent:advisor:sessionbus:direct:${SENDER}`);
});

test("bodyForAgent is the rendered envelope with sender and reply footer; rawBody and commandBody are the raw text", async (t) => {
  const { runtime, deliver } = await fixture(t);
  await deliver("do the thing", "r1");
  const { message } = runtime.dispatches[0].ctxPayload;
  assert.equal(message.bodyForAgent, renderInbound({ message_id: "r1", from: { session_id: SENDER, product: "claude-peer", groups: ["g"] }, body: "do the thing" }));
  assert.match(message.bodyForAgent, /from-session="other@host"/);
  assert.match(message.bodyForAgent, /Reply only if needed, with the sessionbus tool/);
  assert.equal(message.rawBody, "do the thing");
  assert.equal(message.commandBody, "do the thing");
  runtime.release(`agent:advisor:sessionbus:direct:${SENDER}`);
});

test("backlog limit holds under concurrent deliveries from different senders", async (t) => {
  const { runtime, daemon } = await fixture(t);
  const from = (n) => ({ session_id: `c${n}@host`, product: "claude-peer", groups: ["g"] });
  const receipts = await Promise.all(Array.from({ length: 20 }, (_, n) => daemon.deliver({ message_id: `c${n}`, from: from(n), body: "x" })));
  assert.equal(receipts.filter((r) => r.disposition === "queued_for_next_turn").length, 16);
  assert.equal(receipts.filter((r) => r.reason === "OpenClaw session backlog full").length, 4);
  assert.equal(runtime.dispatches.length, 16);
});

test("a refusal is not remembered: the same message_id is re-evaluated once the backlog drains", async (t) => {
  const { runtime, daemon } = await fixture(t);
  const from = (n) => ({ session_id: `r${n}@host`, product: "claude-peer", groups: ["g"] });
  for (let n = 0; n < 16; n++) await daemon.deliver({ message_id: `r${n}`, from: from(n), body: "x" });
  const refused = await daemon.deliver({ message_id: "again", from: from(99), body: "x" });
  assert.equal(refused.reason, "OpenClaw session backlog full");
  runtime.release("agent:advisor:sessionbus:direct:r0@host");
  await settle();
  assert.deepEqual(await daemon.deliver({ message_id: "again", from: from(99), body: "x" }), { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 17);
});

test("a settled ledger entry expires after 20 minutes: the retransmission dispatches again", async (t) => {
  let clock = 1_000_000;
  const { runtime, deliver } = await fixture(t, { now: () => clock });
  await deliver("hello", "ttl");
  runtime.release(KEY);
  await settle();
  clock += 19 * 60_000;
  await deliver("hello", "other"); // sweeps; "ttl" is still inside the window
  await deliver("hello", "ttl");
  assert.equal(runtime.dispatches.filter((d) => d.ctxPayload.messageId === "ttl").length, 1);
  runtime.release(KEY);
  await settle();
  clock += 2 * 60_000;
  await deliver("hello", "ttl");
  assert.equal(runtime.dispatches.filter((d) => d.ctxPayload.messageId === "ttl").length, 2);
  runtime.release(KEY);
});

test("a synchronous dispatch throw does not leak a backlog slot", async (t) => {
  const { runtime, daemon } = await fixture(t);
  const inbound = runtime.channelRuntime.inbound;
  const real = inbound.dispatch;
  inbound.dispatch = () => {
    throw new Error("sync boom");
  };
  const from = (n) => ({ session_id: `x${n}@host`, product: "claude-peer", groups: ["g"] });
  for (let n = 0; n < 17; n++) {
    const receipt = await daemon.deliver({ message_id: `x${n}`, from: from(n), body: "x" });
    assert.deepEqual(receipt, { disposition: "rejected", reason: "dispatch failed: sync boom" });
  }
  inbound.dispatch = real;
  assert.deepEqual(await daemon.deliver({ message_id: "x-ok", from: from(100), body: "x" }), { disposition: "queued_for_next_turn" });
  runtime.release("agent:advisor:sessionbus:direct:x100@host");
});

test("a service created by a plugin reload finds the channel runtime the running channel attached (8.2 swaps services, not channels)", async (t) => {
  const { runtime, service: first } = await fixture(t);
  const daemon = createFakeDaemon();
  const second = createPeerService({ runtime }, { channelSdk: CHANNEL_SDK, connect: (path) => daemon.connect(path), schedule: (fn) => fn(), env: {}, uid: 1000 });
  t.after(() => second.stop());
  await first.stop(); // the old generation stops; its startAccount is still running, nothing re-attaches
  second.start({ logger: runtime.logger });
  await second.peerFor("advisor").ready;
  const receipt = await daemon.deliver({ message_id: "swap1", from: { session_id: SENDER, product: "claude-peer", groups: ["g"] }, body: "after the swap" });
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 1);
  runtime.release(KEY);
});

test("the old generation's detach does not clear a runtime a newer startAccount attached", async (t) => {
  const { runtime, service: first } = await fixture(t);
  const daemon = createFakeDaemon();
  const second = createPeerService({ runtime }, { channelSdk: CHANNEL_SDK, connect: (path) => daemon.connect(path), schedule: (fn) => fn(), env: {}, uid: 1000 });
  t.after(() => second.stop());
  second.start({ logger: runtime.logger });
  await second.peerFor("advisor").ready;
  second.attachChannel({ ...runtime.channelRuntime }); // a newer startAccount's own runtime object
  first.detachChannel(); // old startAccount finishing late
  assert.deepEqual(await daemon.deliver({ message_id: "late1", from: { session_id: SENDER, product: "claude-peer", groups: ["g"] }, body: "x" }), { disposition: "queued_for_next_turn" });
  runtime.release(KEY);
});

test("recorded channel routes survive a stop/start of the service while the channel stays attached (CR-F2a-4)", async (t) => {
  const { service, deliver, runtime } = await fixture(t);
  await deliver("hi");
  assert.equal(service.routeKeys("advisor").size, 1);
  runtime.release(KEY);
  await service.stop();
  assert.equal(service.routeKeys("advisor").size, 1, "the bus session keeps its tool across a service restart");
});

test("a retransmission after a plugin generation swap still finds the ledger entry, and the old dispatches still count (CR-F2a-1)", async (t) => {
  const { runtime, service: first, deliver } = await fixture(t);
  const from = (n) => ({ session_id: `g${n}@host`, product: "claude-peer", groups: ["g"] });
  const receipt = await deliver("hello", "swap-m1");
  assert.equal(receipt.disposition, "queued_for_next_turn");
  const daemon1 = (await import("./support/fake-daemon.js")).createFakeDaemon();
  await first.stop(); // the old generation stops; its dispatches keep running
  const second = createPeerService({ runtime }, { channelSdk: CHANNEL_SDK, connect: (path) => daemon1.connect(path), schedule: (fn) => fn(), env: {}, uid: 1000 });
  t.after(() => second.stop());
  second.start({ logger: runtime.logger });
  await second.peerFor("advisor").ready;
  const send = (id, n) => daemon1.deliver({ message_id: id, from: n === undefined ? { session_id: SENDER, product: "claude-peer", groups: ["g"] } : from(n), body: "x" });
  assert.deepEqual(await send("swap-m1"), receipt, "the retransmission gets the original receipt");
  assert.equal(runtime.dispatches.length, 1, "and no second dispatch");
  for (let n = 0; n < 15; n++) assert.equal((await send(`swap-${n}`, n)).disposition, "queued_for_next_turn");
  const refused = await send("swap-over", 99);
  assert.equal(refused.reason, "OpenClaw session backlog full", "the old dispatch still counts against the 16");
  runtime.release(KEY);
  for (let n = 0; n < 15; n++) runtime.release(`agent:advisor:sessionbus:direct:g${n}@host`);
});

test("a restart over hanging dispatches keeps counting them against the backlog", async (t) => {
  const { runtime, daemon, service } = await fixture(t);
  const from = (n) => ({ session_id: `k${n}@host`, product: "claude-peer", groups: ["g"] });
  for (let n = 0; n < 16; n++) assert.equal((await daemon.deliver({ message_id: `k${n}`, from: from(n), body: "x" })).disposition, "queued_for_next_turn");
  await service.start({ logger: runtime.logger }); // start over leftover connections
  await service.peerFor("advisor").ready;
  const refused = await daemon.deliver({ message_id: "k99", from: from(99), body: "x" });
  assert.deepEqual(refused, { disposition: "rejected", reason: "OpenClaw session backlog full" });
  for (let n = 0; n < 16; n++) runtime.release(`agent:advisor:sessionbus:direct:k${n}@host`);
});

test("a delivery from the startup window (before the channel attached) is deduped against its retransmission after attach (CR-R5-01)", async (t) => {
  const { runtime, service, deliver } = await fixture(t, { attach: false });
  const early = deliver("early", "startup-1"); // waits for startAccount
  setTimeout(() => service.attachChannel(runtime.channelRuntime), 20);
  const receipt = await early;
  assert.equal(receipt.disposition, "queued_for_next_turn");
  assert.deepEqual(await deliver("early", "startup-1"), receipt, "the retransmission gets the original receipt");
  assert.equal(runtime.dispatches.length, 1, "and no second dispatch");
  assert.ok(service.routeKeys("advisor").has(KEY), "the route recorded in the window is kept");
  runtime.release(KEY);
});

test("the delivery log line names the channel session and, for a refusal, the reason (diagnosable from the Gateway log)", async (t) => {
  const { runtime, deliver } = await fixture(t);
  const ok = await deliver("hi", "log-1");
  assert.equal(ok.disposition, "queued_for_next_turn");
  await deliver("x".repeat(65537), "log-2");
  const lines = runtime.logs.info.map((l) => l[0]);
  assert.ok(lines.includes(`sessionbus: delivery log-1 from ${SENDER} → queued_for_next_turn session=${KEY}`), lines.join("\n"));
  assert.ok(lines.includes(`sessionbus: delivery log-2 from ${SENDER} → rejected (message too large (64 KiB limit))`), lines.join("\n"));
  runtime.release(KEY);
});

test("a channel-wide binding that the legacy default-agent migration materializes does not take the message away from its addressee (P-ROUTE-1, Amendment 3)", async (t) => {
  // OpenClaw 8.2 src/config/legacy.default-agent-roles.ts:91-101 appends {agentId: <default>, match: {channel, accountId: "*"}}
  // for every unbound channel when a roster uses the legacy `default: true` marker; src/routing/resolve-route.ts:770-818 lets
  // that binding win over the passed defaultAgentId (the unbound fallback, :820). The plugin's synthetic peer-wildcard
  // binding (tier peer.wildcard, :396,:515) outranks it, so the bus address stays the agent.
  const { runtime, deliver } = await fixture(t, { bindings: [{ agentId: "smoke", match: { channel: "sessionbus", accountId: "*" } }] });
  const receipt = await deliver("hello", "pr1");
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 1);
  assert.equal(runtime.dispatches[0].sessionKey ?? runtime.dispatches[0].ctx?.SessionKey, `agent:advisor:sessionbus:direct:${SENDER}`);
  runtime.release(`agent:advisor:sessionbus:direct:${SENDER}`);
});

test("the fake route resolver ranks bindings peer > peer.wildcard > account > channel > default", () => {
  const route = (bindings, peerId = "x@h") => resolveChannelInboundRouteEnvelope({ cfg: { bindings }, channel: "c", accountId: "default", defaultAgentId: "dflt", peer: { kind: "direct", id: peerId }, dmScope: "per-channel-peer" }).route;
  const channel = { agentId: "ch", match: { channel: "c", accountId: "*" } };
  const account = { agentId: "acc", match: { channel: "c" } };
  const wildcard = { agentId: "wild", match: { channel: "c", peer: { kind: "direct", id: "*" } } };
  const peer = { agentId: "pe", match: { channel: "c", peer: { kind: "direct", id: "x@h" } } };
  assert.equal(route([]).agentId, "dflt");
  assert.equal(route([channel]).matchedBy, "binding.channel");
  assert.equal(route([channel, account]).agentId, "acc");
  assert.equal(route([channel, account, wildcard]).agentId, "wild");
  assert.equal(route([wildcard, channel, account, peer]).agentId, "pe");
  assert.equal(route([peer], "other@h").agentId, "dflt", "a peer binding of another sender does not match");
  assert.equal(route([{ agentId: "o", match: { channel: "other" } }]).agentId, "dflt");
});

test("the synthetic peer-wildcard binding is a per-dispatch projection and a binding for another sender does not refuse (P-ROUTE-1)", async (t) => {
  const bindings = [{ agentId: "elsewhere", match: { channel: "sessionbus", peer: { kind: "direct", id: "someone-else@host" } } }];
  const before = structuredClone(bindings);
  const { runtime, deliver } = await fixture(t, { bindings });
  assert.deepEqual(await deliver("hi", "pr2"), { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 1);
  assert.equal(runtime.dispatches[0].cfg.bindings[0].agentId, "advisor");
  assert.deepEqual(runtime.config.current().bindings, before, "the Gateway config is not mutated");
  assert.equal(runtime.dispatches[0].cfg.bindings.length, before.length + 1, "the projection added exactly the synthetic binding");
  runtime.release(`agent:advisor:sessionbus:direct:${SENDER}`);
});

const direct = (peer) => `agent:advisor:sessionbus:direct:${peer}`;
const errorLog = (runtime) => runtime.logs.error.map((l) => l[0]).join("\n");

test("busSessionBinding name (default): same name shares a session, different names do not", async (t) => {
  const { runtime, deliverFrom } = await fixture(t);
  const senders = [
    ["s1@h", "alice"],
    ["s2@h", "alice"], // a restarted alice: new session_id, same name
    ["s3@h", "review:one"],
    ["s4@h", "review one"],
    ["s5@h", "review-one"],
    ["s6@h", "Review-One"], // OpenClaw lowercases the key: shares with review-one
    ["s7@h", "review%003aone"], // literally the encoded form of review:one
    ["s8@h", "review%one"],
  ];
  for (const [index, [session_id, name]] of senders.entries()) {
    assert.deepEqual(await deliverFrom({ session_id, name }, "hi", `m${index}`), { disposition: "queued_for_next_turn" });
  }
  assert.deepEqual(runtime.dispatches.map((d) => d.sessionKey), [
    direct("alice"),
    direct("alice"),
    direct("review%003aone"),
    direct("review%0020one"),
    direct("review-one"),
    direct("review-one"),
    direct("review%0025003aone"),
    direct("review%0025one"),
  ]);
  assert.equal(runtime.dispatches[1].steered, true, "the second alice joins the first alice's session");
});

test("busSessionBinding name: a sender without a name falls back to its session_id", async (t) => {
  // The daemon's MessageDeliverRequest schema refuses an empty or non-string name on the wire; the helper still guards it.
  assert.equal(boundPeerId("name", { session_id: "s2@h", name: "" }), "s2@h");
  assert.equal(boundPeerId("name", { session_id: "s3@h", name: 42 }), "s3@h");
  assert.equal(boundPeerId("name", { session_id: "s4@h", name: null }), "s4@h");
  const { runtime, deliverFrom } = await fixture(t);
  await deliverFrom({ session_id: "s1@h" }, "hi", "m1");
  await deliverFrom({ session_id: "s2@h", name: "alice" }, "hi", "m2");
  assert.deepEqual(runtime.dispatches.map((d) => d.sessionKey), [direct("s1@h"), direct("alice")]);
});

test("busSessionBinding name: separators in a name are encoded", async (t) => {
  assert.equal(boundPeerId("name", { session_id: "s@h", name: "openclaw-peer@host-a" }), "openclaw-peer@host-a");
  assert.equal(boundPeerId(undefined, { session_id: "s@h", name: "review:one" }), "review%003aone");
  assert.equal(boundPeerId("name", { session_id: "s@h", name: "review one" }), "review%0020one");
  assert.equal(boundPeerId("name", { session_id: "s@h", name: "100%" }), "100%0025");
  assert.equal(boundPeerId("name", { session_id: "s@h", name: "a\u3000b" }), "a%3000b");
  assert.equal(boundPeerId("name", { session_id: "s@h", name: "a\tb\nc" }), "a%0009b%000ac");

  const { runtime, deliverFrom } = await fixture(t);
  // The wire schema allows only \p{Zs} among whitespace (no tab or newline); the helper encodes every \s.
  const names = ["x:thread:42", "x:topic:7", "nb\u00a0sp", "wide\u3000space", "a: b", " padded "];
  for (const [index, name] of names.entries()) await deliverFrom({ session_id: `s${index}@h`, name }, "hi", `m${index}`);
  assert.equal(runtime.dispatches.length, names.length);
  for (const { sessionKey } of runtime.dispatches) {
    const peer = sessionKey.slice(direct("").length);
    assert.ok(sessionKey.startsWith(direct("")), sessionKey);
    assert.doesNotMatch(peer, /[:\s]/u, sessionKey);
  }
  assert.equal(runtime.dispatches[0].sessionKey, direct("x%003athread%003a42"));
  assert.equal(runtime.dispatches[5].sessionKey, direct("%0020padded%0020"));
});

test("busSessionBinding sessionId keeps one session per sender session_id", async (t) => {
  const { runtime, deliverFrom } = await fixture(t, { busSessionBinding: "sessionId" });
  await deliverFrom({ session_id: "11111111-aaaa@host", name: "alice" }, "hi", "m1");
  await deliverFrom({ session_id: "22222222-bbbb@host", name: "alice" }, "hi", "m2");
  assert.deepEqual(runtime.dispatches.map((d) => d.sessionKey), [direct("11111111-aaaa@host"), direct("22222222-bbbb@host")]);
});

test("busSessionBinding singleton: every sender shares one session", async (t) => {
  const { runtime, deliverFrom } = await fixture(t, { busSessionBinding: "singleton" });
  await deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "m1");
  await deliverFrom({ session_id: "s2@h", name: "bob" }, "hi", "m2");
  await deliverFrom({ session_id: "s3@h" }, "hi", "m3");
  assert.deepEqual(runtime.dispatches.map((d) => d.sessionKey), [direct("%all"), direct("%all"), direct("%all")]);
});

test("busSessionBinding singleton: no name-mode peer can land in the singleton session after a mode switch", async (t) => {
  // OpenClaw keeps sessions by key, so a key from an earlier singleton run is what a later name-mode peer must not reach.
  const singleton = await fixture(t, { busSessionBinding: "singleton" });
  await singleton.deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "m1");
  const singletonKey = singleton.runtime.dispatches[0].sessionKey;
  assert.equal(singletonKey, direct("%all"));
  await singleton.service.stop();

  const named = await fixture(t);
  await named.deliverFrom({ session_id: "s2@h", name: "all" }, "hi", "m2");
  await named.deliverFrom({ session_id: "s3@h", name: "%all" }, "hi", "m3");
  await named.deliverFrom({ session_id: "s4@h", name: "ALL" }, "hi", "m4");
  const keys = named.runtime.dispatches.map((d) => d.sessionKey);
  assert.deepEqual(keys, [direct("all"), direct("%0025all"), direct("all")]);
  for (const key of keys) assert.notEqual(key, singletonKey);
});

test("busSessionBinding: reply target and ingress identity stay the concrete sender in every mode", async (t) => {
  for (const [mode, peer] of [["name", "alice"], ["sessionId", "s1@h"], ["singleton", "%all"]]) {
    await t.test(mode, async (t) => {
      const { runtime, deliverFrom } = await fixture(t, { version: "2026.9.8", busSessionBinding: mode });
      assert.deepEqual(await deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "m1"), { disposition: "queued_for_next_turn" });
      const { sessionKey, ctxPayload: ctx } = runtime.dispatches[0];
      assert.equal(sessionKey, direct(peer));
      assert.deepEqual(ctx.reply, { to: "s1@h", originatingTo: "s1@h" });
      assert.equal(ctx.from, "s1@h");
      assert.deepEqual(ctx.sender, { id: "s1@h", name: "alice" });
      assert.deepEqual(ctx.conversation, { kind: "direct", id: peer, label: peer, nativeChannelId: "s1@h" });
      const [ingress] = runtime.ingressCalls;
      assert.equal(ingress.subject.stableId, "s1@h");
      assert.deepEqual(ingress.conversation, { kind: "direct", id: peer });
      assert.equal(ingress.contextBinding.nativeChannelId, "s1@h");
      assert.equal(ingress.contextBinding.sessionKey, direct(peer));
      assert.ok(ctx.message.bodyForAgent.includes('{"action":"send","arguments":{"target":"s1@h"'), "the reply footer targets the sender");
      runtime.release(sessionKey);
    });
  }
});

test("busSessionBinding: 9.x handoff binding matches the dispatch context", async (t) => {
  for (const mode of ["name", "sessionId", "singleton"]) {
    await t.test(mode, async (t) => {
      const { runtime, deliverFrom } = await fixture(t, { version: "2026.9.8", busSessionBinding: mode });
      await deliverFrom({ session_id: "s1@h", name: "review:one" }, "hi", "m1");
      await settle();
      assert.doesNotMatch(errorLog(runtime), /failed after receipt/);
      runtime.release(runtime.dispatches[0].sessionKey);
    });
  }
  // Each case tampers one field the double compares and leaves the others intact.
  const tamperings = [
    ["conversation id", (ctx) => ({ ...ctx, conversation: { ...ctx.conversation, id: "s1@h" } }), /conversation\.id/],
    ["native id", (ctx) => ({ ...ctx, conversation: { ...ctx.conversation, nativeChannelId: "s2@h" } }), /nativeChannelId/],
    ["dispatch session key", (ctx) => ({ ...ctx, route: { ...ctx.route, dispatchSessionKey: direct("bob") } }), /route\.dispatchSessionKey/],
  ];
  for (const [field, tamper, reason] of tamperings) {
    await t.test(`the double refuses a tampered ${field}`, async (t) => {
      const { runtime, deliverFrom } = await fixture(t, { version: "2026.9.8" });
      await deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "m1");
      const { ctxPayload, sessionKey } = runtime.dispatches[0];
      const tampered = tamper(ctxPayload);
      assert.equal(tampered.conversation.id === ctxPayload.conversation.id, field !== "conversation id");
      await assert.rejects(
        runtime.channelRuntime.inbound.dispatch({ route: { sessionKey }, ctxPayload: tampered }),
        new RegExp(`ingress handoff mismatch: ${reason.source}`),
      );
      assert.equal(runtime.dispatches.length, 1, "a refused handoff adds no dispatch");
      runtime.release(sessionKey);
    });
  }
});

test("busSessionBinding name: same-named peers keep separate dedupe", async (t) => {
  const { runtime, deliverFrom } = await fixture(t);
  assert.deepEqual(await deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "same"), { disposition: "queued_for_next_turn" });
  assert.deepEqual(await deliverFrom({ session_id: "s2@h", name: "alice" }, "hi", "same"), { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 2);
  assert.deepEqual(await deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "same"), { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 2, "a retransmission by one peer is deduplicated for that peer only");
  runtime.release(direct("alice"));
});

test("busSessionBinding name: same-named peers keep separate loop budgets", async (t) => {
  const { runtime, deliverFrom } = await fixture(t, { loopBudget: 1 });
  assert.deepEqual(await deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "m1"), { disposition: "queued_for_next_turn" });
  const refused = await deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "m2");
  assert.equal(refused.disposition, "rejected");
  assert.match(refused.reason, /loop guard/);
  assert.deepEqual(await deliverFrom({ session_id: "s2@h", name: "alice" }, "hi", "m3"), { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 2);
  runtime.release(direct("alice"));
});

test("a peer-specific binding of this sender's name to another agent is refused", async (t) => {
  const { runtime, deliverFrom } = await fixture(t, {
    bindings: [{ agentId: "elsewhere", match: { channel: "sessionbus", peer: { kind: "direct", id: "review%003aone" } } }],
  });
  const receipt = await deliverFrom({ session_id: "s1@h", name: "review:one" }, "hi", "m1");
  assert.deepEqual(receipt, { disposition: "rejected", reason: "route_mismatch" });
  assert.match(errorLog(runtime), /route_mismatch for m1 from s1@h \(peer review%003aone\)/);
  assert.equal(runtime.dispatches.length, 0);
  assert.deepEqual(await deliverFrom({ session_id: "s2@h", name: "review one" }, "hi", "m2"), { disposition: "queued_for_next_turn" });
});

test("busSessionBinding: session.identityLinks applies to the bound peer id", async (t) => {
  const { runtime, deliverFrom } = await fixture(t, { session: { identityLinks: { shared: ["sessionbus:alice"] } } });
  await deliverFrom({ session_id: "s1@h", name: "alice" }, "hi", "m1");
  await deliverFrom({ session_id: "s2@h", name: "Alice" }, "hi", "m2");
  await deliverFrom({ session_id: "s3@h", name: "bob" }, "hi", "m3");
  assert.deepEqual(runtime.dispatches.map((d) => d.sessionKey), [direct("shared"), direct("shared"), direct("bob")]);
});
