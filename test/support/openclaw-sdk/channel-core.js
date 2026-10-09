// Shim for `openclaw/plugin-sdk/channel-core`.
// openclaw@8.2 src/plugin-sdk/core.ts:565-597 — a channel entry registers the channel plugin, then (unless the
// load is a setup/metadata one) runs registerFull; a tool-discovery load runs registerFull only.
export function defineChannelPluginEntry({ id, name, description, plugin, reload, registerFull }) {
  return {
    id,
    name,
    description,
    ...(reload ? { reload } : {}),
    configSchema: { type: "object", additionalProperties: false, properties: {} },
    register(api) {
      const mode = api.registrationMode;
      if (mode === "tool-discovery") {
        registerFull?.(api);
        return;
      }
      api.registerChannel({ plugin });
      if (mode !== "full") return;
      registerFull?.(api);
    },
  };
}

// openclaw@8.2 src/plugin-sdk/core.ts createChatChannelPlugin — returns the base adapter (with its id).
export function createChatChannelPlugin({ base }) {
  return { ...base };
}
