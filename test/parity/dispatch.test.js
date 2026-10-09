import assert from "node:assert/strict";
import test from "node:test";
import { createParity, json } from "./helpers.js";

// kit sdk/js/caller.js:6 ACTION_METHODS; peer-common@d41b0ad mcp/server_test.go:162-166
const WIRE = {
  list: "session.list",
  send: "message.send",
  spawn: "lane.spawn",
  describe: "lane.describe",
  trace: "trace.configure",
  run: "turn.run",
  start: "turn.start",
  status: "turn.status",
  wait: "turn.wait",
  ack: "turn.ack",
  interrupt: "turn.interrupt",
  close: "session.close",
  forget: "session.close",
};

async function lastRequest(h, method, from) {
  const matching = h.requests.filter((request) => request.method === method && request.session_id === from);
  return matching.at(-1);
}

test("each action reaches its wire method with arguments verbatim", { timeout: 15000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  const self = h.selfId();

  async function check(action, args, expectedParams = args) {
    const before = h.requests.length;
    const result = await h.execute(action, args);
    const sent = h.requests.slice(before).filter((request) => request.session_id === self);
    assert.ok(sent.length >= 1, `${action}: a request reached the daemon`);
    const request = sent.at(-1);
    assert.equal(request.method, WIRE[action], `${action} → ${WIRE[action]}`);
    assert.deepEqual(request.params, expectedParams, `${action}: arguments verbatim`);
    return result;
  }

  await check("list", {});
  await check("list", { host: "testhost" });
  await check("describe", { product: "claude-peer" });
  const spawnArgs = { name: "w", product: "claude-peer", open: { cwd: "/tmp", model: "m", arguments: ["--x"] }, extra_groups: ["team"], persistent: false, auto_close_ms: 0, notify: true, trace: "off" };
  const spawned = json(await check("spawn", spawnArgs));
  const lane = spawned.session_id;
  await check("trace", { session_id: lane, mode: "events" });
  const ran = json(await check("run", { session_id: lane, input: "first" }));
  await check("ack", { session_id: lane, run_id: ran.run_id });
  const ref = json(await check("start", { session_id: lane, input: "second" }));
  await check("wait", { session_id: lane, run_id: ref.run_id, timeout_ms: 5000 });
  await check("status", { session_id: lane, run_id: ref.run_id });
  await check("ack", { session_id: lane, run_id: ref.run_id });
  await check("interrupt", { session_id: lane });
  await check("close", { session_id: lane });
  await check("forget", { session_id: lane }, { session_id: lane, forget: true });
});

test("send reaches message.send with its arguments after exactly one session.list", { timeout: 10000 }, async (t) => {
  const h = await createParity({ agents: [{ id: "advisor", groups: ["g"] }, { id: "other", groups: ["g"] }] });
  t.after(() => h.close());
  const self = h.selfId("advisor");
  const before = h.requests.length;
  const args = { target: h.selfId("other"), message: "hello" };
  const result = json(await h.execute("send", args));
  const sent = h.requests.slice(before).filter((request) => request.session_id === self);
  assert.deepEqual(sent.map((request) => request.method), ["session.list", "message.send"]);
  assert.deepEqual(sent[1].params, args);
  assert.match(result.message_id, /^message-/);
  assert.equal(result.deliveries[0].session_id, h.selfId("other"));
});

test("forget is session.close with forget true", { timeout: 10000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  const spawned = await h.call("spawn", { name: "f", product: "claude-peer", open: {} });
  await h.call("forget", { session_id: spawned.session_id });
  const request = await lastRequest(h, "session.close", h.selfId());
  assert.deepEqual(request.params, { session_id: spawned.session_id, forget: true });
  assert.equal(h.daemon.lane(spawned.session_id), undefined, "the lane row is gone");
});
