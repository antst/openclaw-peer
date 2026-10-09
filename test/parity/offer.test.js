import assert from "node:assert/strict";
import test from "node:test";
import { createParity, sessionKeyFor } from "./helpers.js";

test("unstarted registration resolves the started service", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/server_test.go:129-157; openclaw@8.2 src/plugins/tools.ts:1230-1235 — the agent may get the
  // tool from a tool-discovery snapshot whose services never started.
  const h = await createParity({ snapshot: true });
  t.after(() => h.close());
  const snapshot = h.host.registrations.find((registration) => !registration.activated);
  assert.ok(snapshot.services.every((item) => !item.started), "the snapshot's service never started");
  const tool = h.tool("advisor", {}, { registration: "snapshot" });
  assert.ok(tool, "the snapshot registration offers the tool");
  const listed = JSON.parse((await tool.execute("c1", { action: "list", arguments: {} })).content[0].text);
  assert.equal(listed.self_info.session_id, h.selfId(), "it drives the started service's identity");
  assert.equal(h.daemon.hellos.length, 1, "one daemon connection, from the started service");
});

test("exactly one tool named sessionbus, declared in contracts.tools", { timeout: 10000 }, async (t) => {
  const h = await createParity();
  t.after(() => h.close());
  const tools = h.host.resolveTools({ agentId: "advisor", sessionKey: h.sessionKey() });
  assert.deepEqual(tools.map((tool) => tool.name), ["sessionbus"]);
  assert.deepEqual(h.host.manifest.contracts.tools, ["sessionbus"]);
  const active = h.host.registrations.find((registration) => registration.activated);
  assert.deepEqual(active.tools.map((item) => item.names), [["sessionbus"]], "registered under the declared name");
  assert.deepEqual(h.host.diagnostics, [], "no registration diagnostics");
});

test("two registrations still offer one sessionbus tool per session", { timeout: 10000 }, async (t) => {
  const h = await createParity({ snapshot: true });
  t.after(() => h.close());
  const ctx = { agentId: "advisor", sessionKey: h.sessionKey() };
  for (const registration of [undefined, "active", "snapshot"]) {
    const tools = h.host.resolveTools(ctx, { registration });
    assert.deepEqual(tools.map((tool) => tool.name), ["sessionbus"], `registration ${registration ?? "default"}`);
  }
  assert.deepEqual(h.host.diagnostics, []);
});

test("two bound agents use their own identities", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_test.go:98-126 — identity is per call
  const h = await createParity({ agents: [{ id: "advisor", groups: ["g"] }, { id: "other", groups: ["g"] }] });
  t.after(() => h.close());
  for (const agent of ["advisor", "other", "advisor", "other"]) {
    const listed = await h.call("list", {}, { agent });
    assert.equal(listed.self_info.session_id, h.selfId(agent), `${agent} sees itself`);
    const request = h.requests.filter((item) => item.method === "session.list").at(-1);
    assert.equal(request.session_id, h.selfId(agent), `${agent}'s call went out on its own connection`);
  }
  await h.call("send", { target: h.selfId("other"), message: "from advisor" }, { agent: "advisor" });
  const send = h.requests.filter((item) => item.method === "message.send").at(-1);
  assert.equal(send.session_id, h.selfId("advisor"));
});

test("unbound session or agent gets no tool", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/sessionbus_test.go:128-177 — an inactive server advertises nothing
  const h = await createParity();
  t.after(() => h.close());
  assert.deepEqual(h.host.resolveTools({ agentId: "advisor", sessionKey: "agent:advisor:telegram:direct:1" }), [], "another session of the bound agent");
  assert.deepEqual(h.host.resolveTools({ agentId: "stranger", sessionKey: sessionKeyFor("stranger") }), [], "an agent without a binding");
  assert.deepEqual(h.host.resolveTools({ agentId: "stranger", sessionKey: h.sessionKey() }), [], "another agent in the bound session key");
  assert.deepEqual(h.host.resolveTools({}), [], "no agent context");
});
