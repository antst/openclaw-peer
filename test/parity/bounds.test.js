import assert from "node:assert/strict";
import test from "node:test";
import { createParity, until, json, CODES, DaemonError, rawResult } from "./helpers.js";

// kit sdk/js/connection.js:41 — at most 256 calls in flight per daemon connection;
// peer-common@d41b0ad mcp/sessionbus.go:95 maxMCPResponseWork = 256.
const WORK_LIMIT = 256;
// kit schema MessageSendRequest.message / TurnRunRequest.input maxLength
const WIRE_TEXT_LIMIT = 262144;

function countOf(h, method) {
  return h.requests.filter((request) => request.method === method).length;
}

test("the 257th concurrent action gets the owner work limit error", { timeout: 30000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:160-194
  const h = await createParity({ daemon: { worker: "manual" } });
  t.after(() => h.close());
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ref = await h.call("start", { session_id, input: "work" });
  const blocked = [];
  for (let index = 0; index < WORK_LIMIT; index++) blocked.push(h.execute("wait", ref));
  await until(() => countOf(h, "turn.wait") === WORK_LIMIT, { what: "256 waits on the wire" });
  const started = Date.now();
  const overflow = await h.execute("wait", ref);
  assert.equal(overflow.isError, true, "the 257th action fails");
  assert.ok(Date.now() - started < 2000, "fails fast");
  assert.equal(countOf(h, "turn.wait"), WORK_LIMIT, "the 257th never reached the wire");
  await h.daemon.finish(session_id, { outcome: "completed", result: "done" });
  const results = await Promise.all(blocked);
  assert.ok(results.every((result) => json(result).state === "done"), "the admitted 256 complete");
  assert.equal((await h.call("status", ref)).state, "done", "freed slots take new work");
});

function listWith(info) {
  return { sessions: [{ session_id: "big@testhost", kind: "peer", product: "fixture", groups: ["g"], connected: true, running: false, info }] };
}

test("freed work slots are reusable after completed and failed calls", { timeout: 60000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:304-340 — successes and errors alternate past the work limit
  let calls = 0;
  const h = await createParity({
    scripted: {
      methods: {
        "session.list": () => {
          calls += 1;
          if (calls % 2 === 0) throw new DaemonError(CODES.busy);
          return listWith({ payload: "x".repeat(128 << 10) });
        },
      },
    },
  });
  t.after(() => h.close());
  for (let index = 0; index < WORK_LIMIT + 1; index++) {
    const result = await h.execute("list", {});
    assert.equal(result.isError === true, index % 2 === 1, `call ${index}`);
  }
});

test("many large concurrent results are each returned or errored, none hang", { timeout: 30000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:196-228
  const big = "x".repeat(900000);
  const h = await createParity({ scripted: { methods: { "session.list": () => listWith({ payload: big }) } } });
  t.after(() => h.close());
  const results = await Promise.all(Array.from({ length: 32 }, () => h.execute("list", {})));
  for (const result of results) {
    if (result.isError) continue;
    assert.equal(json(result).sessions[0].info.payload.length, big.length, "a returned result is complete");
  }
  assert.ok(results.some((result) => !result.isError), "results do come back");
});

test("a result near the frame limit is returned intact", { timeout: 15000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:231-276 — escaping-heavy text survives byte for byte
  const heavy = '<"\\>\n'.repeat(90000);
  const h = await createParity({ scripted: { methods: { "session.list": () => listWith({ payload: heavy }) } } });
  t.after(() => h.close());
  const listed = await h.call("list", {});
  assert.equal(listed.sessions[0].info.payload, heavy);
});

test("message over 262144 characters is rejected before the wire", { timeout: 15000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_bounds_test.go:342-376
  const h = await createParity({ agents: [{ id: "advisor", groups: ["g"] }, { id: "other", groups: ["g"] }] });
  t.after(() => h.close());
  const tooLong = "m".repeat(WIRE_TEXT_LIMIT + 1);
  const sent = await h.execute("send", { target: h.selfId("other"), message: tooLong });
  assert.equal(sent.isError, true);
  assert.equal(countOf(h, "message.send"), 0, "no message.send frame");
  const { session_id } = await h.call("spawn", { name: "w", product: "claude-peer", open: {} });
  const ran = await h.execute("run", { session_id, input: tooLong });
  assert.equal(ran.isError, true);
  assert.equal(countOf(h, "turn.run"), 0, "no turn.run frame");
  const fits = await h.execute("send", { target: h.selfId("other"), message: "m".repeat(WIRE_TEXT_LIMIT) });
  assert.notEqual(fits.isError, true, "exactly the limit is accepted");
});

test("an oversized daemon result becomes a tool error", { timeout: 15000 }, async (t) => {
  // kit sdk/js/connection.js:68-70 — a frame over 1 MiB closes the connection; the call must fail, not hang
  const h = await createParity({ scripted: { methods: { "session.list": () => rawResult({ sessions: [], padding: "p".repeat(2 * (1 << 20)) }) } } });
  t.after(() => h.close());
  const result = await h.execute("list", {});
  assert.equal(result.isError, true);
});
