import assert from "node:assert/strict";
import test from "node:test";
import { createParity, json, text } from "./helpers.js";

const MESSAGE = "Preserve the complete instruction text.";
// Budget 2 per peer pair: one inbound + one outbound fit, the third event is blocked.
const GUARD = { maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60 };

function sendsFrom(h, agentId) {
  return h.requests.filter((request) => request.session_id === h.selfId(agentId) && (request.method === "message.send" || request.method === "session.list"));
}

async function twoAgents(t, options = {}) {
  const h = await createParity({ agents: [{ id: "advisor", groups: ["g"] }, { id: "other", groups: ["g"] }], ...options });
  t.after(() => h.close());
  return h;
}

test("send with summary is rejected before any daemon call, the corrected send succeeds", { timeout: 10000 }, async (t) => {
  const h = await twoAgents(t);
  const target = h.selfId("other");
  const before = sendsFrom(h, "advisor").length;
  // peer-common@d41b0ad mcp/send_test.go:14-33
  const rejected = await h.execute("send", { target, message: MESSAGE, summary: "Brief label" });
  assert.equal(rejected.isError, true);
  assert.match(text(rejected), /"summary" is not allowed/);
  assert.equal(sendsFrom(h, "advisor").length, before, "no session.list, no message.send");

  const receipt = json(await h.execute("send", { target, message: MESSAGE }));
  assert.match(receipt.message_id, /^message-/);
  const sent = h.requests.filter((request) => request.method === "message.send" && request.session_id === h.selfId("advisor"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.message, MESSAGE, "complete message, nothing truncated");
});

test("rejected send leaves the loop-guard budget unchanged", { timeout: 10000 }, async (t) => {
  const h = await twoAgents(t, { botLoopProtection: GUARD });
  const target = h.selfId("other");
  await h.deliver("advisor", { session_id: target, product: "openclaw-peer", groups: ["g"] }, "hi"); // event 1 of 2
  const invalid = await h.execute("send", { target, message: "reply", summary: "x" });
  assert.equal(invalid.isError, true);
  const valid = await h.execute("send", { target, message: "reply" }); // event 2 of 2: fits only if the invalid send was not charged
  assert.notEqual(valid.isError, true, `valid send passes: ${text(valid)}`);
  const sendsBefore = h.requests.filter((request) => request.method === "message.send").length;
  const blocked = await h.execute("send", { target, message: "again" }); // event 3: the guard still holds
  assert.equal(blocked.isError, true, "loop guard blocks the third event");
  assert.equal(h.requests.filter((request) => request.method === "message.send").length, sendsBefore, "blocked send never reached the wire");
});
