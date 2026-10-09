// Shim for `openclaw/plugin-sdk/plugin-entry`.
// openclaw@8.2 src/plugin-sdk/plugin-entry.ts:196-251 — returns a plain object, `register` passed through
// unchanged, `configSchema` a lazy cached getter (default: empty schema).
export function definePluginEntry({ id, name, description, kind, configSchema, reload, nodeHostCommands, securityAuditCollectors, register }) {
  let schema;
  return {
    id,
    name,
    description,
    ...(kind ? { kind } : {}),
    ...(reload ? { reload } : {}),
    ...(nodeHostCommands ? { nodeHostCommands } : {}),
    ...(securityAuditCollectors ? { securityAuditCollectors } : {}),
    get configSchema() {
      if (schema === undefined) {
        const value = typeof configSchema === "function" ? configSchema() : configSchema;
        schema = value ?? { type: "object", additionalProperties: false, properties: {} };
      }
      return schema;
    },
    register,
  };
}
