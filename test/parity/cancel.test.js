import assert from "node:assert/strict";
import test from "node:test";
import { createParity, until } from "./helpers.js";

/** Settles within `ms`; resolves to {ok, result|error}. A tool error counts as not ok. */
async function settle(promise, ms = 3000, what = "call") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    return { ok: result?.isError !== true, result };
  } catch (error) {
    if (String(error?.message).includes("did not settle")) throw error;
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("aborting the call signal ends wait, sends no ack, record stays collectable", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/server_test.go:172-184 — cancelling stops this call only
  const h = await createParity({ daemon: { worker: "manual" } });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ref = await h.call("start", { session_id, input: "work" });
  const controller = new AbortController();
  const waiting = h.execute("wait", ref, { signal: controller.signal });
  await until(() => h.requests.some((request) => request.method === "turn.wait"), { what: "wait sent" });
  controller.abort();
  const aborted = await settle(waiting, 2000, "aborted wait");
  assert.equal(aborted.ok, false, "the aborted wait does not return a result");
  await h.daemon.finish(session_id, { outcome: "completed", result: "kept" });
  assert.equal(h.requests.some((request) => request.method === "turn.ack"), false, "no ack was sent");
  const collected = await h.call("wait", ref);
  assert.deepEqual(collected.result, { outcome: "completed", result: "kept" }, "the record is still collectable");
});

test("service stop settles an in-flight run with an error and no late result", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/lane_test.go:148-171
  const h = await createParity({ daemon: { worker: "manual" } });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const running = h.execute("run", { session_id, input: "work" });
  await until(() => h.requests.some((request) => request.method === "turn.run"), { what: "run sent" });
  await settle(h.host.stop(), 3000, "service stop");
  const outcome = await settle(running, 3000, "in-flight run");
  assert.equal(outcome.ok, false, "the in-flight run ends with an error");
});

test("daemon connection loss settles a blocked wait with an error", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:70-110
  const h = await createParity({ daemon: { worker: "manual" } });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ref = await h.call("start", { session_id, input: "work" });
  const waiting = h.execute("wait", ref);
  await until(() => h.requests.some((request) => request.method === "turn.wait"), { what: "wait sent" });
  h.daemon.drop();
  const outcome = await settle(waiting, 3000, "wait after connection loss");
  assert.equal(outcome.ok, false);
});

test("service stop returns while a daemon call never replies", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:112-131
  const h = await createParity({ scripted: { methods: { "session.list": () => new Promise(() => {}) } } });
  t.after(() => h.close());
  const pending = h.execute("list", {});
  await until(() => h.requests.some((request) => request.method === "session.list"), { what: "list sent" });
  await settle(h.host.stop(), 3000, "service stop");
  const outcome = await settle(pending, 3000, "unanswered list");
  assert.equal(outcome.ok, false);
});

test("tool is offered only after the service has started", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:133-158
  const h = await createParity({ start: false });
  t.after(() => h.close());
  assert.equal(h.tool(), undefined, "no tool before start");
  assert.equal(h.daemon.hellos.length, 0);
  await h.start();
  assert.ok(h.tool(), "offered after start");
  assert.equal((await h.call("list", {})).self_info.session_id, h.selfId());
});

test("a result arriving after service stop is not returned as success", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:278-302
  let release;
  const h = await createParity({
    scripted: {
      methods: {
        "session.list": (params, ctx) =>
          new Promise((resolve) => {
            release = () => resolve(ctx.next());
          }),
      },
    },
  });
  t.after(() => h.close());
  const pending = h.execute("list", {});
  await until(() => typeof release === "function", { what: "list admitted" });
  await settle(h.host.stop(), 3000, "service stop");
  release();
  const outcome = await settle(pending, 3000, "list");
  assert.equal(outcome.ok, false, "no success after stop");
});

test("aborted calls release their work slots without late results", { timeout: 60000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:378-426 — 257 cancelled calls in a row, then normal work.
  // The daemon answers each wait shortly after the abort (a kit caller slot is held until the reply, kit connection.js:44).
  const h = await createParity({
    daemon: { worker: "manual" },
    scripted: {
      methods: {
        "turn.wait": async (params) => {
          await sleep(10);
          return { session_id: params.session_id, run_id: params.run_id, state: "running" };
        },
      },
    },
  });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ref = await h.call("start", { session_id, input: "work" });
  for (let index = 0; index < 257; index++) {
    const seen = h.requests.filter((request) => request.method === "turn.wait").length;
    const controller = new AbortController();
    const waiting = h.execute("wait", ref, { signal: controller.signal });
    await until(() => h.requests.filter((request) => request.method === "turn.wait").length > seen, { what: `wait ${index} sent` });
    controller.abort();
    const outcome = await settle(waiting, 2000, `aborted wait ${index}`);
    assert.equal(outcome.ok, false, `aborted wait ${index} returns no result`);
  }
  await sleep(30);
  assert.equal((await h.call("status", ref)).state, "running", "work continues after 257 aborted calls");
});
