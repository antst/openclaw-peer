import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDaemon, DaemonError, CODES } from "./support/fake-daemon.js";
import { createFakeRuntime, createStrictLogger } from "./support/fake-openclaw.js";
import { createPeerService } from "../src/service.js";
import { createToolFactory } from "../src/tool.js";
import { createSessionbusCommand } from "../src/command.js";

// frozen-peer-stall: a remote host whose federation link stays open but never answers (laptop lid closed,
// SIGSTOP) makes the daemon's unfiltered session.list wait with no deadline (sessionbus v0.5.12
// bus/internal/daemon/federation.go:315-321, bus/internal/federation/hub.go:526-536). Host-filtered list
// and message.send to a local target still answer at once (loopback repro, .lane/debug/frozen-peer-stall.md).
const SESSION_KEY = "agent:advisor:main";
const SELF_ID = "openclaw-advisor@testhost";
const ROWS = {
  self_info: { session_id: SELF_ID, product: "openclaw-peer", groups: ["g"] },
  sessions: [
    { session_id: SELF_ID, kind: "peer", product: "openclaw-peer", groups: ["g"], connected: true, running: false },
    { session_id: "bob@testhost", kind: "peer", product: "claude-peer", name: "Bob", groups: ["g"], connected: true, running: false },
  ],
};

test("frozen-peer-stall: a local send is delivered while a remote host hangs the unfiltered list", async (t) => {
  const daemon = createFakeDaemon({
    // Unfiltered list fans out to every host and waits for the frozen one; filtered list stays local.
    list: (params) => (params.host === undefined && params.session_id === undefined ? new Promise(() => {}) : ROWS),
    send: (args) => ({ message_id: "msg_1", deliveries: [{ target: args.target, session_id: "bob@testhost", delivery_id: "delivery-1", disposition: "written" }] }),
  });
  const runtime = createFakeRuntime({
    version: "2026.9.8",
    config: {
      agents: { entries: { advisor: {} } },
      plugins: { entries: { sessionbus: { config: { socket: "/tmp/fake.sock", agents: { advisor: { enabled: true, groups: ["g"], sessionKey: SESSION_KEY } } } } } },
    },
  });
  const service = createPeerService({ runtime }, { connect: (path) => daemon.connect(path), schedule: (call) => call(), env: {}, uid: 1000 });
  t.after(() => service.stop());
  service.start({ logger: createStrictLogger() });
  await service.peerFor("advisor").ready;
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: SESSION_KEY });

  const caller = new AbortController(); // the Gateway caller gives up, as the 60 s client did on a real host
  let timer;
  const result = await Promise.race([
    tool.execute("c1", { action: "send", arguments: { target: "bob@testhost", message: "local while beta is frozen" } }, caller.signal),
    new Promise((resolve) => { timer = setTimeout(() => { caller.abort(new Error("caller timeout")); resolve("caller timeout"); }, 2000); }),
  ]);
  clearTimeout(timer);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(daemon.sends.map((send) => send.target), ["bob@testhost"], "the local send never reached the daemon");
  assert.notEqual(result, "caller timeout", "the tool call stayed pending behind the unfiltered list");
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
});

async function fixture(t, list, options = {}) {
  const daemon = createFakeDaemon({ list, send: (args) => ({ message_id: "msg_1", deliveries: [{ target: args.target ?? "bob@testhost", session_id: "bob@testhost", delivery_id: "d1", disposition: "written" }] }) });
  const runtime = createFakeRuntime({ version: "2026.9.8", config: {
    agents: { entries: { advisor: {} } },
    plugins: { entries: { sessionbus: { config: { socket: "/tmp/fake.sock", agents: { advisor: { enabled: true, groups: ["g"], sessionKey: SESSION_KEY } } } } } },
  } });
  const service = createPeerService({ runtime }, { connect: (path) => daemon.connect(path), schedule: (call) => call(), env: {}, uid: 1000 });
  t.after(() => service.stop());
  service.start({ logger: createStrictLogger() });
  await service.peerFor("advisor").ready;
  const tool = createToolFactory(service, { sendListTimeoutMs: 20, ...options })({ agentId: "advisor", sessionKey: SESSION_KEY });
  return { daemon, service, tool };
}

for (const args of [{ target: "bob@frozen" }, { target: "Bob" }, { group: "g" }, { group: "g", host: "frozen" }]) {
  test(`pre-send timeout reports NOT sent without reserving guard: ${JSON.stringify(args)}`, async (t) => {
    const { daemon, service, tool } = await fixture(t, () => new Promise(() => {}));
    const reservations = [];
    service.guard.record = (...values) => reservations.push(values);
    const keepAlive = setTimeout(() => {}, 1000);
    t.after(() => clearTimeout(keepAlive));
    const result = await tool.execute("c", { action: "send", arguments: { ...args, message: "hello" } }, AbortSignal.timeout(200));
    assert.equal(result.isError, true);
    const scope = args.target === "Bob" ? "the local lookup for Bob did not answer" : args.host || args.target?.includes("@") ? "host frozen did not answer" : "the bus list did not answer";
    const ending = !scope.startsWith("the bus list")
      ? "(a federated host may be asleep or unreachable). Nothing was delivered; retry later."
      : "(a federated host may be asleep). Nothing was delivered; address recipients as <name>@<host>, or give group with host.";
    assert.equal(result.content[0].text, `sessionbus: message NOT sent — ${scope} within 0.02 s ${ending}`);
    assert.deepEqual(daemon.sends, []);
    assert.deepEqual(reservations, []);
  });
}

test("scoped recipient lists are distinct and parallel; caller cancellation stays an ordinary error", async (t) => {
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const { daemon, tool } = await fixture(t, (args) => {
    if (args.host === "testhost") return first;
    release(ROWS);
    return ROWS;
  });
  const result = await tool.execute("c", { action: "send", arguments: { targets: ["bob@testhost", "nobody@other", "openclaw-advisor@testhost"], message: "hello" } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(daemon.lists, [{ host: "testhost" }, { host: "other" }]);
  const caller = new AbortController();
  caller.abort(new Error("caller cancelled"));
  const cancelled = await tool.execute("c", { action: "send", arguments: { target: "bob@testhost", message: "bye" } }, caller.signal);
  assert.equal(cancelled.content[0].text, "sessionbus: caller cancelled");
});

test("plain list times out with host guidance while filtered lists still answer", async (t) => {
  const { tool } = await fixture(t, (args) => args.host || args.session_id ? ROWS : new Promise(() => {}), { listTimeoutMs: 20 });
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const result = await tool.execute("c", { action: "list", arguments: {} }, AbortSignal.timeout(200));
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "sessionbus: list did not answer within 0.02 s (a federated host may be asleep); use list {host} for one host.");
  for (const args of [{ host: "testhost" }, { session_id: SELF_ID }]) {
    const filtered = await tool.execute("c", { action: "list", arguments: args });
    assert.equal(filtered.isError, undefined);
    assert.deepEqual(JSON.parse(filtered.content[0].text), ROWS);
  }
});

async function commandWithin(command, word) {
  let timer;
  try {
    return await Promise.race([
      command.handler({ senderIsOwner: true, agentId: "advisor", args: word }),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ text: "command still pending" }), 200); }),
    ]);
  } finally { clearTimeout(timer); }
}

for (const word of ["roster", "status"]) {
  test(`${word} falls back to the local host when the federation list times out`, async (t) => {
    const { service, daemon } = await fixture(t, (args) => args.host || args.session_id ? ROWS : new Promise(() => {}));
    const command = createSessionbusCommand(service, { listTimeoutMs: 20 });
    const result = await commandWithin(command, word);
    assert.equal(result.isError, undefined);
    if (word === "roster") {
      assert.ok(result.text.startsWith("**sessionbus roster** · advisor · 2 sessions"), result.text);
      assert.match(result.text, /\| testhost \| peer \| ○ idle \| claude-peer \| Bob \|/);
      assert.ok(result.text.endsWith("\n\nincomplete: other hosts did not answer within 0.02 s"));
    } else {
      assert.match(result.text, /- session: openclaw-advisor@testhost · connected/);
      assert.match(result.text, /- sessions: 2 \(this host only; other hosts did not answer within 0.02 s\)/);
    }
    assert.deepEqual(daemon.lists, [{}, { session_id: "openclaw-advisor" }, { host: "testhost" }]);
  });
}

test("roster by default waits 5 s for the federation, then answers with this host", async (t) => {
  const { service } = await fixture(t, (args) => args.host || args.session_id ? ROWS : new Promise(() => {}));
  const started = Date.now();
  const result = await createSessionbusCommand(service).handler({ senderIsOwner: true, agentId: "advisor", args: "roster" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4900 && elapsed < 7000, `elapsed ${elapsed} ms`);
  assert.ok(result.text.endsWith("\n\nincomplete: other hosts did not answer within 5 s"), result.text);
});

for (const failure of ["missing self_info", "local timeout"]) {
  test(`local fallback retains unavailable replies: ${failure}`, async (t) => {
    const { service } = await fixture(t, (args) => {
      if (!args.session_id || failure === "local timeout") return new Promise(() => {});
      return { sessions: ROWS.sessions };
    });
    const command = createSessionbusCommand(service, { listTimeoutMs: 20 });
    const roster = await commandWithin(command, "roster");
    assert.equal(roster.isError, true, roster.text);
    assert.match(roster.text, /^sessionbus: bus unavailable: /);
    const status = await commandWithin(command, "status");
    assert.match(status.text, /- session: openclaw-advisor · error: /);
    assert.ok(!status.text.includes("this host only"));
  });
}

for (const label of ["bob", "Bob"]) {
  test(`bare local label ${label} is delivered while the unfiltered list hangs`, async (t) => {
    const { tool, daemon, service } = await fixture(t, (args) => args.session_id ? ROWS : new Promise(() => {}));
    const reservations = [];
    service.guard.record = (...values) => reservations.push(values);
    const result = await tool.execute("c", { action: "send", arguments: { target: label, message: "local" } }, AbortSignal.timeout(200));
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.deepEqual(daemon.lists, [{ session_id: label }]);
    assert.deepEqual(daemon.sends.map((args) => args.target), [label]);
    assert.deepEqual(reservations, [["openclaw-advisor", "bob@testhost"]]);
  });
}

for (const [label, code] of [["bob@missing", "unknown_host"], ["missing", "unknown_session"], ["bob@testhost", "internal"]]) {
  test(`scoped lookup ${code} leaves ${label} unresolved and still sends`, async (t) => {
    const { tool, daemon, service } = await fixture(t, () => { throw new DaemonError(CODES[code], code === "internal" ? "lookup failed" : undefined); });
    const reservations = [];
    service.guard.record = (...values) => {
      assert.equal(daemon.sends.length, 1, "unresolved recipients are charged after send");
      reservations.push(values);
    };
    const result = await tool.execute("c", { action: "send", arguments: { target: label, message: "send anyway" } });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.deepEqual(daemon.sends.map((args) => args.target), [label]);
    assert.deepEqual(reservations, [["openclaw-advisor", "bob@testhost"]]);
  });
}

for (const args of [{ group: "g" }, { group: "g", host: "missing" }]) {
  test(`group lookup errors prevent send: ${JSON.stringify(args)}`, async (t) => {
    const { tool, daemon, service } = await fixture(t, () => { throw new DaemonError(CODES.unknown_host); });
    const reservations = [];
    service.guard.record = (...values) => reservations.push(values);
    const result = await tool.execute("c", { action: "send", arguments: { ...args, message: "hello" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^sessionbus error -32014:/);
    assert.deepEqual(daemon.sends, []);
    assert.deepEqual(reservations, []);
  });
}

test("roster and status never fall back on a non-timeout list error", async (t) => {
  const { service, daemon } = await fixture(t, (args) => {
    if (args.host || args.session_id) return ROWS;
    throw new DaemonError(CODES.busy);
  });
  const command = createSessionbusCommand(service, { listTimeoutMs: 20 });
  const roster = await commandWithin(command, "roster");
  assert.equal(roster.isError, true);
  assert.match(roster.text, /^sessionbus: bus unavailable: -32003:/);
  const status = await commandWithin(command, "status");
  assert.match(status.text, /- session: openclaw-advisor · error: -32003:/);
  assert.ok(!status.text.includes("this host only"));
  assert.deepEqual(daemon.lists, [{}, {}], "non-timeout errors must not issue fallback queries");
});

test("caller abort during a scoped list neither reserves guard nor sends", async (t) => {
  const { service, tool, daemon } = await fixture(t, (args) => args.host === "testhost" ? ROWS : new Promise(() => {}), { sendListTimeoutMs: 1000 });
  const reservations = [];
  service.guard.record = (...values) => reservations.push(values);
  const peer = service.peerFor("advisor");
  const action = peer.action.bind(peer);
  let markResolved;
  const firstResolved = new Promise((resolve) => { markResolved = resolve; });
  peer.action = async (name, args, signal) => {
    const result = await action(name, args, signal);
    if (name === "list" && args.host === "testhost") markResolved();
    return result;
  };
  const caller = new AbortController();
  const resultPromise = tool.execute("c", { action: "send", arguments: { targets: ["bob@testhost", "missing@other"], message: "hello" } }, caller.signal);
  // Let the successful lookup settle through resolveRecipients before cancelling its sibling.
  await firstResolved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(daemon.lists, [{ host: "testhost" }, { host: "other" }]);
  caller.abort(new Error("caller cancelled during lookup"));
  const result = await resultPromise;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "sessionbus: caller cancelled during lookup");
  assert.deepEqual(reservations, []);
  assert.deepEqual(daemon.sends, []);
});
