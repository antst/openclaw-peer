import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDaemon } from "./support/fake-daemon.js";
import { createFakeRuntime } from "./support/fake-openclaw.js";
import { createPeerService } from "../src/service.js";
import { createToolFactory } from "../src/tool.js";
import { buildChannelInboundEventContext, createChannelInboundEnvelopeBuilder, resolveChannelInboundRouteEnvelope } from "./support/openclaw-sdk/channel-inbound.js";

const CHANNEL_SDK = { buildChannelInboundEventContext, createChannelInboundEnvelopeBuilder, resolveChannelInboundRouteEnvelope };

const BOUND_SESSION_KEY = "agent:advisor:telegram:direct:123456789";
const BUS_SESSION_KEY = "agent:advisor:sessionbus:direct:other@host";

function buildFixture() {
  const daemon = createFakeDaemon();
  const runtime = createFakeRuntime({
    version: "2026.8.2",
    config: {
      agents: { entries: { advisor: {} } },
      channels: { sessionbus: { enabled: true } },
      plugins: {
        entries: {
          sessionbus: {
            config: {
              socket: "/tmp/fake.sock",
              agents: {
                advisor: { enabled: true, sessionKey: BOUND_SESSION_KEY, groups: ["g"] },
              },
            },
          },
        },
      },
    },
  });
  const api = { runtime };
  const service = createPeerService(api, {
    channelSdk: CHANNEL_SDK,
    connect: (path) => daemon.connect(path),
  });
  return { daemon, runtime, service };
}

test("enabled agent says hello with the exact identity", async (t) => {
  const { daemon, service } = buildFixture();
  t.after(() => service.stop());
  service.start();
  await service.peerFor("advisor").ready;
  assert.equal(daemon.hellos.length, 1);
  const hello = daemon.hellos[0];
  assert.equal(hello.product, "openclaw-peer");
  assert.equal(hello.session_id, "openclaw-advisor");
  assert.deepEqual(hello.groups, ["g"]);
  assert.deepEqual(hello.info, {
    agent_id: "advisor",
    session_key: BOUND_SESSION_KEY,
    openclaw_version: "2026.8.2",
  });
});

test("a bus turn's final text is not sent; the tool in the bus session is", async (t) => {
  const { daemon, runtime, service } = buildFixture();
  t.after(() => service.stop());
  service.start({ logger: runtime.logger });
  await service.peerFor("advisor").ready;
  service.attachChannel(runtime.channelRuntime);

  const receipt = await daemon.deliver({
    message_id: "m1",
    from: { session_id: "other@host", product: "claude-peer", groups: ["g"] },
    body: "hello from the federation",
  });
  assert.deepEqual(receipt, { disposition: "queued_for_next_turn" });
  assert.equal(runtime.dispatches.length, 1);
  assert.equal(runtime.dispatches[0].sessionKey, BUS_SESSION_KEY);
  assert.match(runtime.dispatches[0].ctxPayload.message.bodyForAgent, /hello from the federation/);
  assert.equal(runtime.heartbeatRequests.length, 0);

  // The turn's final text goes to the channel's deliver, which sends nothing to the bus.
  await runtime.dispatches[0].delivery.deliver({ text: "final answer" }, { kind: "final" });
  assert.equal(daemon.requests.some((request) => request.method === "message.send"), false);
  assert.match(runtime.logs.info.flat().join("\n"), /reply suppressed m1 kind=final/);

  // The agent answers explicitly with the tool, offered in the recorded bus session.
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: runtime.dispatches[0].sessionKey });
  assert.ok(tool, "tool offered in the bus session");
  await tool.execute("call1", { action: "send", arguments: { target: "other@host", message: "answer" } });
  assert.equal(daemon.sends.at(-1).message, "answer");
  runtime.release(BUS_SESSION_KEY);
});

test("tool send reaches the fake daemon when bound, is null elsewhere", async (t) => {
  const { daemon, service } = buildFixture();
  t.after(() => service.stop());
  service.start();
  await service.peerFor("advisor").ready;
  const factory = createToolFactory(service);

  const tool = factory({ agentId: "advisor", sessionKey: BOUND_SESSION_KEY });
  assert.ok(tool);
  const result = await tool.execute("call1", { action: "send", arguments: { target: "x@host", message: "hi" } });
  assert.equal(daemon.sends.length, 1);
  assert.equal(daemon.sends[0].target, "x@host");
  assert.equal(daemon.sends[0].message, "hi");
  assert.equal(result.content[0].type, "text");

  assert.equal(factory({ agentId: "advisor", sessionKey: "agent:advisor:main" }), null);
});
