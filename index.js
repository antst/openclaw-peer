// Thin host wrapper: the OpenClaw plugin SDK is provided by the host at
// install time, not a project dependency. Tests exercise src/*.js directly
// against the fakes in test/support/, never this file.
import { defineChannelPluginEntry, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buildChannelInboundEventContext, resolveChannelInboundRouteEnvelope, createChannelInboundEnvelopeBuilder } from "openclaw/plugin-sdk/channel-inbound";
import { resolveActiveEmbeddedRunSessionId, queueAgentHarnessMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/health";
import { resolveService } from "./src/active.js";
import { createSessionbusChannel } from "./src/channel.js";
import { createSessionbusCommand, createSessionbusInteractiveHandler } from "./src/command.js";
import { createPeerService } from "./src/service.js";
import { createToolFactory } from "./src/tool.js";

// The service of the latest registerFull load; startAccount reaches it through this holder.
let service;

export default {
  ...defineChannelPluginEntry({
    id: "sessionbus",
    name: "Sessionbus peer",
    description: "Connects an OpenClaw agent to Sessionbus as an ordinary peer.",
    plugin: createSessionbusChannel({ createChatChannelPlugin, service: () => (service ? resolveService(service) : undefined) }),
    registerFull(api) {
      service = createPeerService(api, {
        channelSdk: { buildChannelInboundEventContext, resolveChannelInboundRouteEnvelope, createChannelInboundEnvelopeBuilder },
        harness: { resolveActiveEmbeddedRunSessionId, queueAgentHarnessMessage },
        lanes: { resolveStateDir, resolveAgentWorkspaceDir, resolveDefaultModelForAgent },
      });
      api.registerService(service);
      api.registerTool(createToolFactory(service), { name: "sessionbus" });
      api.registerCommand(createSessionbusCommand(service));
      api.registerInteractiveHandler(createSessionbusInteractiveHandler());
    },
  }),
  // OpenClaw 8.2 hot-applies plugins.* as a plugin-generation swap that leaves claude-cli
  // heartbeats on the superseded generation until the process restarts (hot-reload-hb);
  // a sessionbus config change takes a Gateway restart instead, as 8.2's CLI advises.
  // 8.2 plugin-sdk core.ts:565-597 does not pass `reload` through defineChannelPluginEntry, hence the spread.
  reload: { restartPrefixes: ["plugins.entries.sessionbus"] },
};
