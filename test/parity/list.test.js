import assert from "node:assert/strict";
import test from "node:test";
import { createParity, REMOTE_HOST } from "./helpers.js";

test("host-filtered list returns self_info verbatim", { timeout: 10000 }, async (t) => {
  // peer-common@d41b0ad mcp/self_info_test.go:21-63 — no self row in the filtered result, self_info still arrives unchanged
  let daemonResult;
  const h = await createParity({
    remote: true,
    scripted: {
      methods: {
        "session.list": async (params, ctx) => {
          daemonResult = await ctx.next();
          return daemonResult;
        },
      },
    },
  });
  t.after(() => h.close());
  const listed = await h.call("list", { host: REMOTE_HOST });
  assert.deepEqual(listed, daemonResult, "the daemon's result, verbatim");
  assert.deepEqual(listed.self_info, { session_id: h.selfId(), product: "openclaw-peer", groups: ["g", `session:${h.selfId()}`] });
  assert.equal(listed.sessions.some((row) => row.session_id === h.selfId()), false, "the caller's own row is filtered out by host");
  const request = h.requests.filter((item) => item.method === "session.list").at(-1);
  assert.deepEqual(request.params, { host: REMOTE_HOST });
});

test("list shows peers and lanes of every federation host in shared groups", { timeout: 10000 }, async (t) => {
  const h = await createParity({ remote: true, agents: [{ id: "advisor", groups: ["g"] }, { id: "stranger", groups: ["elsewhere"] }] });
  t.after(() => h.close());
  const local = await h.call("spawn", { name: "here", product: "claude-peer", open: {} });
  const remote = await h.call("spawn", { name: "there", product: "claude-peer", open: {}, host: REMOTE_HOST });
  const ids = (await h.call("list", {})).sessions.map((row) => row.session_id);
  assert.ok(ids.includes(h.selfId()));
  assert.ok(ids.includes(local.session_id), "own lane on this host");
  assert.ok(ids.includes(remote.session_id), "own lane on the other host");
  assert.equal(ids.includes(h.selfId("stranger")), false, "no shared group, not listed");
});
