import assert from "node:assert/strict";
import test from "node:test";
import { createParity, until, json } from "./helpers.js";

const U14_DEFAULT = 600000;

function lastSpawn(h) {
  return h.requests.filter((request) => request.method === "lane.spawn").at(-1);
}

test("spawn result is returned verbatim for fresh and resume in every trace mode", { timeout: 15000 }, async (t) => {
  // peer-common@d41b0ad mcp/trace_policy_test.go:11-38
  let reply;
  const h = await createParity({ scripted: { methods: { "lane.spawn": () => reply } } });
  t.after(() => h.close());
  for (const mode of [undefined, "off", "events", "content"]) {
    for (const action of ["fresh", "resume"]) {
      const policy = { persistent: false, auto_close_ms: 60000, notify: true, ...(mode ? { trace: mode } : {}) };
      reply = { session_id: "child@testhost", policy };
      const args = action === "fresh" ? { name: "child", product: "claude-peer", open: {} } : { resume_session_id: "child@testhost" };
      const result = await h.call("spawn", args);
      assert.deepEqual(result, reply, `${action}/${mode ?? "absent"}`);
    }
  }
});

test("omitted auto_close_ms arrives as 600000, fresh and resume", { timeout: 10000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  const fresh = await h.call("spawn", { name: "d", product: "claude-peer", open: {} });
  assert.equal(lastSpawn(h).params.auto_close_ms, U14_DEFAULT, "fresh request");
  assert.equal(fresh.policy.auto_close_ms, U14_DEFAULT, "fresh lane policy");
  await h.call("close", { session_id: fresh.session_id });
  const resumed = await h.call("spawn", { resume_session_id: fresh.session_id });
  assert.equal(lastSpawn(h).params.auto_close_ms, U14_DEFAULT, "resume request (the daemon would reset it to 60000)");
  assert.equal(resumed.policy.auto_close_ms, U14_DEFAULT, "resumed lane policy");
});

test("explicit auto_close_ms 0 and 5000 pass unchanged", { timeout: 10000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  for (const value of [0, 5000]) {
    const fresh = await h.call("spawn", { name: `e${value}`, product: "claude-peer", open: {}, auto_close_ms: value });
    assert.equal(lastSpawn(h).params.auto_close_ms, value, `fresh ${value}`);
    assert.equal(fresh.policy.auto_close_ms, value);
    await h.call("close", { session_id: fresh.session_id });
    const resumed = await h.call("spawn", { resume_session_id: fresh.session_id, auto_close_ms: value });
    assert.equal(lastSpawn(h).params.auto_close_ms, value, `resume ${value}`);
    assert.equal(resumed.policy.auto_close_ms, value);
  }
});

test("spawn without trace carries no bodies", { timeout: 10000 }, async (t) => {
  // PLAN Security row I: the tool adds only auto_close_ms to spawn, never trace.
  const h = await createParity();
  t.after(() => h.close());
  const marker = "MARKER-7f3a9c";
  const spawned = await h.call("spawn", { name: "quiet", product: "claude-peer", open: {} });
  const request = lastSpawn(h);
  assert.equal(Object.hasOwn(request.params, "trace"), false, "no trace key on the wire");
  assert.equal(spawned.policy.trace, "off");
  const turnsBefore = h.dispatches().length;
  const ref = await h.call("start", { session_id: spawned.session_id, input: `input ${marker}` });
  await until(() => h.dispatches().length > turnsBefore, { what: "completion pointer" });
  const collected = await h.call("wait", { session_id: spawned.session_id, run_id: ref.run_id });
  assert.ok(collected.result.result.includes(marker), "the run's own output does carry the marker");
  for (const turn of h.dispatches()) assert.equal(turn.ctxPayload.message.bodyForAgent.includes(marker), false, "no envelope delivered to the owner carries the marker");
});
