import assert from "node:assert/strict";
import test from "node:test";
import kit from "@sessionbus/kit";
import { createFakeDaemon } from "./support/fake-daemon.js";
import { createFakeRuntime } from "./support/fake-openclaw.js";

const { connectPeer } = kit;

test("fake daemon records a real kit hello", async () => {
  const daemon = createFakeDaemon();
  const peer = connectPeer(
    { protocol: 1, product: "openclaw-peer", session_id: "openclaw-advisor", groups: ["g"], info: { agent_id: "advisor" } },
    async () => ({ disposition: "rejected", reason: "unused" }),
    { SESSIONBUS_SOCKET: "/tmp/fake.sock" },
    { connect: (path) => daemon.connect(path) },
  );
  await peer.ready;
  assert.equal(daemon.hellos.length, 1);
  assert.equal(daemon.hellos[0].session_id, "openclaw-advisor");
  assert.deepEqual(daemon.hellos[0].groups, ["g"]);
  peer.shutdown();
});

test("fake session lookup preserves opaque Matrix room ID case", () => {
  const runtime = createFakeRuntime();
  const key = "agent:advisor:matrix:channel:!AbC:example.org";
  runtime.agent.session.setSessionEntry("advisor", key, { marker: true });
  assert.deepEqual(runtime.agent.session.getSessionEntry({ agentId: "advisor", sessionKey: key }), { marker: true });
  assert.equal(runtime.agent.session.getSessionEntry({ agentId: "advisor", sessionKey: key.toLowerCase() }), undefined);
});

test("fake daemon close drops all attached streams", async () => {
  const daemon = createFakeDaemon();
  const first = daemon.connect("/tmp/one");
  const second = daemon.connect("/tmp/two");
  await daemon.close();
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, true);
});
