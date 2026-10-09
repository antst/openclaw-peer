// The `sessionbus` channel: a bus message is an inbound channel message into the bus session busSessionBinding picks (by default one per sender name).
// The channel never delivers replies (U-05); the agent answers with the sessionbus tool.

/**
 * @param {object} deps
 * @param {Function} deps.createChatChannelPlugin - openclaw/plugin-sdk/channel-core.
 * @param {() => object|undefined} deps.service - the peer service of the current load (created in registerFull).
 */
export function createSessionbusChannel({ createChatChannelPlugin, service }) {
  const enabledIn = (cfg) => cfg?.channels?.sessionbus?.enabled === true;
  return createChatChannelPlugin({
    base: {
      id: "sessionbus",
      meta: { id: "sessionbus", label: "Sessionbus", selectionLabel: "Sessionbus", docsPath: "/channels/sessionbus", blurb: "Sessionbus peer" },
      capabilities: { chatTypes: ["direct"] },
      // D25: a static deny before the allowFrom branch on 8.2 — bus text is never owner command input.
      commands: { enforceOwnerForCommands: true },
      reload: { configPrefixes: ["channels.sessionbus"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: (cfg) => ({ accountId: "default", enabled: enabledIn(cfg), configured: true, config: cfg?.channels?.sessionbus ?? {} }),
        defaultAccountId: () => "default",
        isConfigured: (account) => account.configured,
        inspectAccount: (cfg) => ({ enabled: enabledIn(cfg), configured: true }),
      },
      setup: { applyAccountConfig: ({ cfg }) => cfg },
      gateway: {
        startAccount: async (ctx) => {
          const owner = service();
          owner?.attachChannel(ctx.channelRuntime);
          ctx.setStatus?.({ accountId: "default", running: true, configured: true, enabled: true });
          await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve, { once: true }));
          owner?.detachChannel();
        },
      },
    },
  });
}
