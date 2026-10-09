import assert from "node:assert/strict";
import test from "node:test";
import { createParity, until, json, text, completionPointer, CODES, DaemonError, REMOTE_HOST } from "./helpers.js";

test("spawned lane visible to its owner", { timeout: 10000 }, async (t) => {
  // A3, RESEARCH-sb F2: lane groups = spawner's private group + <private>/<name> + extra_groups
  // (sessionbus@53c5f80 bus/internal/daemon/handlers.go:260-262), so a same-group agent of another identity does not see it.
  const h = await createParity({ agents: [{ id: "advisor", groups: ["g"] }, { id: "other", groups: ["g"] }] });
  t.after(() => h.close());
  const spawned = await h.call("spawn", { name: "mine", product: "claude-peer", open: {} }, { agent: "advisor" });
  const own = await h.call("list", {}, { agent: "advisor" });
  assert.ok(own.sessions.some((row) => row.session_id === spawned.session_id), "the owner lists its lane");
  const theirs = await h.call("list", {}, { agent: "other" });
  assert.ok(theirs.sessions.some((row) => row.session_id === h.selfId("advisor")), "the other agent does share a group with the owner");
  assert.equal(theirs.sessions.some((row) => row.session_id === spawned.session_id), false, "the other agent does not see the lane");
});

test("start then status running and wait done by run_id from the same agent", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/lane_test.go:105-126
  const h = await createParity({ daemon: { worker: "manual" } });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ref = await h.call("start", { session_id, input: "work" });
  assert.deepEqual(Object.keys(ref).sort(), ["run_id", "session_id"]);
  assert.deepEqual(await h.call("status", ref), { ...ref, state: "running" });
  await h.daemon.finish(session_id, { outcome: "completed", result: "done" });
  assert.deepEqual(await h.call("wait", ref), { ...ref, state: "done", result: { outcome: "completed", result: "done" } });
});

test("scripted worker -32004 on wait and status reaches the agent with its code", { timeout: 10000 }, async (t) => {
  // Not a real daemon path: sessionbus@53c5f80 returns not_running only for interrupt (bus/sdk/go/worker.go:226-237).
  // peer-common scripts it the same way (mcp/lane_test.go:53,128-146).
  const failedWorker = () => {
    throw new DaemonError(CODES.not_running);
  };
  const h = await createParity({ scripted: { methods: { "turn.wait": failedWorker, "turn.status": failedWorker } } });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ref = await h.call("start", { session_id, input: "work" });
  for (const action of ["wait", "status"]) {
    const result = await h.execute(action, ref);
    assert.equal(result.isError, true, action);
    assert.match(text(result), /-32004/, `${action} carries -32004`);
  }
});

for (const where of ["this host", "another host"]) {
  test(`lane round trip on ${where}: spawn, start, woken by completion, wait, ack, close`, { timeout: 15000 }, async (t) => {
    const h = await createParity({ remote: true });
    t.after(() => h.close());
    const args = { name: "trip", product: "claude-peer", open: {}, ...(where === "another host" ? { host: REMOTE_HOST } : {}) };
    const { session_id } = await h.call("spawn", args);
    if (where === "another host") assert.ok(h.remote.lane(session_id), "the lane lives on the other host");
    const ref = await h.call("start", { session_id, input: "do it" });
    // The agent ends its turn here; the daemon's pointer wakes it.
    const pointer = completionPointer(session_id, ref.run_id, "done");
    await until(() => h.dispatches().some((turn) => turn.ctxPayload.message.bodyForAgent.includes(pointer)), { what: "completion pointer as a channel turn" });
    assert.equal(h.runtime.heartbeatRequests.length, 0, "no heartbeat wake");
    assert.equal((await h.call("status", ref)).state, "done");
    const collected = await h.call("wait", ref);
    assert.deepEqual(collected.result, { outcome: "completed", result: "do it" });
    assert.deepEqual(await h.call("ack", ref), {});
    const gone = await h.execute("status", ref);
    assert.equal(gone.isError, true, "an acked record is consumed");
    assert.deepEqual(await h.call("close", { session_id }), {});
    const lane = (where === "another host" ? h.remote : h.daemon).lane(session_id);
    assert.equal(lane.row.connected, false, "closed");
  });
}

test("unacked result is gone after auto-close", { timeout: 10000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ref = await h.call("start", { session_id, input: "x" });
  await h.call("wait", ref);
  await h.daemon.advance(600000 - 1);
  assert.equal((await h.call("status", ref)).state, "done", "still collectable just before the 10-minute default");
  await h.daemon.advance(1);
  const gone = await h.execute("status", ref);
  assert.equal(gone.isError, true, "gone after auto-close");
  assert.match(text(gone), new RegExp(String(CODES.not_connected)), "the lane is closed: -32002 not_connected");
});
