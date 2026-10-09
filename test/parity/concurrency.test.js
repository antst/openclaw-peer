import assert from "node:assert/strict";
import test from "node:test";
import { createParity, until, text, CODES, DaemonError } from "./helpers.js";

test("a blocked run does not block interrupt, and a close error keeps its code", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/lane_test.go:69-97
  const h = await createParity({
    daemon: { worker: "manual" },
    scripted: {
      methods: {
        "session.close": () => {
          throw new DaemonError(CODES.not_running);
        },
      },
    },
  });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const running = h.call("run", { session_id, input: "work" });
  await until(() => h.daemon.lane(session_id)?.runs.some((run) => run.state === "running"), { what: "run admitted" });
  assert.deepEqual(await h.call("interrupt", { session_id }), {}, "interrupt answers while run is blocked");
  const ran = await running;
  assert.equal(ran.state, "done");
  assert.equal(ran.result.outcome, "interrupted");
  const order = h.requests.filter((request) => request.method === "turn.run" || request.method === "turn.interrupt").map((request) => request.method);
  assert.deepEqual(order, ["turn.run", "turn.interrupt"]);
  const closed = await h.execute("close", { session_id });
  assert.equal(closed.isError, true);
  assert.match(text(closed), /-32004/);
  assert.match(text(closed), /not_running/);
});

test("a blocked wait does not block status from the same agent", { timeout: 10000 }, async (t) => {
  const h = await createParity({ daemon: { worker: "manual" } });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ref = await h.call("start", { session_id, input: "work" });
  const waiting = h.call("wait", ref);
  await until(() => h.requests.some((request) => request.method === "turn.wait"), { what: "wait sent" });
  assert.equal((await h.call("status", ref)).state, "running", "status answers while wait blocks");
  await h.daemon.finish(session_id, { outcome: "completed", result: "ok" });
  assert.equal((await waiting).result.result, "ok");
});
