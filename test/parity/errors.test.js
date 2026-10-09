import assert from "node:assert/strict";
import test from "node:test";
import { createParity, CODES, DaemonError, rawResult, text } from "./helpers.js";

// A tool error is a resolved result with isError, never a rejected execute.
async function toolError(promise, what) {
  const result = await promise;
  assert.equal(result?.isError, true, `${what}: isError`);
  return text(result);
}

test("unknown or missing action is rejected with zero daemon calls", { timeout: 10000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  const before = h.requests.length;
  // peer-common@d41b0ad mcp/server_test.go:97-114, sessionbus_tools.go:67-82 — exactly {action, arguments}, action in ACTIONS
  for (const params of [{ action: "unknown", arguments: {} }, { arguments: {} }, { action: "list" }, { action: 7, arguments: {} }, { action: "list", arguments: {}, extra: true }]) {
    await toolError(h.execute(params), JSON.stringify(params));
  }
  assert.equal(h.requests.length, before, "nothing reached the daemon");
  const listed = await h.call("list", {});
  assert.equal(listed.self_info.session_id, h.selfId(), "the next valid call works");
});

test("arguments null, array or string are rejected with zero daemon calls", { timeout: 10000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  const before = h.requests.length;
  // peer-common@d41b0ad mcp/server_test.go:116-127
  for (const args of [null, [], "scalar"]) {
    await toolError(h.execute({ action: "send", arguments: args }), `arguments ${JSON.stringify(args)}`);
  }
  assert.equal(h.requests.length, before, "nothing reached the daemon");
  assert.equal((await h.call("list", {})).self_info.session_id, h.selfId(), "the next valid call works");
});

test("invalid daemon result becomes a tool error, not a throw", { timeout: 10000 }, async (t) => {
  const h = await createParity({ scripted: { methods: { "lane.describe": () => rawResult({ not: "a LaneDescribeResult" }) } } });
  t.after(() => h.close());
  await toolError(h.execute("describe", { product: "claude-peer" }), "describe with a schema-invalid result");
});

test("daemon down gives a tool error, never a hang", { timeout: 10000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  await h.daemon.close();
  const started = Date.now();
  await toolError(h.execute("list", {}), "list with the daemon down");
  assert.ok(Date.now() - started < 5000, "answered promptly");
});

test("daemon error codes reach the agent: -32004 on list, wait and status", { timeout: 10000 }, async (t) => {
  const notRunning = () => {
    throw new DaemonError(CODES.not_running);
  };
  const h = await createParity({ scripted: { methods: { "session.list": notRunning, "turn.wait": notRunning, "turn.status": notRunning } } });
  t.after(() => h.close());
  for (const [action, args] of [["list", {}], ["wait", { session_id: "lane@testhost" }], ["status", { session_id: "lane@testhost" }]]) {
    const message = await toolError(h.execute(action, args), action);
    assert.match(message, /-32004/, `${action}: carries the code`);
    assert.match(message, /not_running/, `${action}: carries the message`);
  }
});
