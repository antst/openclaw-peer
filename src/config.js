import kit from "@sessionbus/kit/sdk/js/schema.js";
import path from "node:path";

const { validationError } = kit;

const BUS_SESSION_BINDINGS = ["name", "sessionId", "singleton"];

/**
 * @param {object} [pluginConfig] - `plugins.entries.sessionbus.config`.
 * @param {object} [openclawConfig] - full OpenClaw config, for `agents.entries`.
 * @param {object} [env]
 * @param {string|number} [uid]
 * @returns {{socket: string, bindings: Array<{agentId: string, sessionKey: string, name?: string, groups: string[], busSessionBinding: "name"|"sessionId"|"singleton"}>, errors: string[]}}
 */
export function resolveConfig(pluginConfig = {}, openclawConfig = {}, env = {}, uid) {
  const errors = [];
  const bindings = [];
  let socketConfig = pluginConfig;
  if (typeof pluginConfig.socket === "string" && pluginConfig.socket.length > 0 && !path.isAbsolute(pluginConfig.socket)) {
    errors.push("socket: absolute path required");
    socketConfig = { ...pluginConfig, socket: undefined };
  }
  const socket = resolveSocket(socketConfig, env, uid);
  const agents = pluginConfig.agents ?? {};
  const knownAgents = openclawConfig.agents?.entries ?? {};
  const rootBinding = pluginConfig.busSessionBinding;
  const rootBindingValid = rootBinding === undefined || BUS_SESSION_BINDINGS.includes(rootBinding);
  if (!rootBindingValid) errors.push(`busSessionBinding: must be one of ${BUS_SESSION_BINDINGS.join(", ")}`);

  for (const [agentId, rawAgentConfig] of Object.entries(agents)) {
    const agentConfig = rawAgentConfig ?? {};
    if (!Object.hasOwn(knownAgents, agentId)) {
      errors.push(`agents.${agentId}: unknown agent id`);
      continue;
    }
    if (!(agentConfig.enabled ?? false)) continue;
    if (!rootBindingValid) continue;
    if (agentConfig.busSessionBinding !== undefined && !BUS_SESSION_BINDINGS.includes(agentConfig.busSessionBinding)) {
      errors.push(`agents.${agentId}.busSessionBinding: must be one of ${BUS_SESSION_BINDINGS.join(", ")}`);
      continue;
    }
    const sessionKey = typeof agentConfig.sessionKey === "string" ? agentConfig.sessionKey : `agent:${agentId}:main`;
    if (!sessionKey.startsWith(`agent:${agentId}:`)) {
      errors.push(`agents.${agentId}.sessionKey: must start with "agent:${agentId}:"`);
      continue;
    }
    if (sessionKey !== sessionKey.toLowerCase()) {
      errors.push(`agents.${agentId}.sessionKey: must be lowercase, as OpenClaw lists it`);
      continue;
    }
    const groups = Array.isArray(agentConfig.groups) ? agentConfig.groups : [];
    if (groups.length === 0) {
      errors.push(
        `agents.${agentId}.groups: an enabled agent needs a non-empty groups list (launch the sending CC session with a matching -g group)`,
      );
      continue;
    }

    const name = resolveName(agentConfig, knownAgents[agentId]);
    const identity = {
      protocol: 1,
      product: "openclaw-peer",
      session_id: `openclaw-${agentId}`,
      groups: [...groups],
      info: {},
      ...(name ? { name } : {}),
    };
    const identityError = validationError("SessionHelloRequest", identity);
    if (identityError) {
      errors.push(`agents.${agentId}: ${identityError.message}`);
      continue;
    }

    bindings.push({
      agentId,
      sessionKey,
      ...(name ? { name } : {}),
      groups: [...groups],
      busSessionBinding: agentConfig.busSessionBinding ?? rootBinding ?? "name",
    });
  }

  return { socket, bindings, errors };
}

function resolveName(agentConfig, knownAgent) {
  if (typeof agentConfig.name === "string" && agentConfig.name.length > 0) return agentConfig.name;
  const identityName = knownAgent?.identity?.name;
  if (typeof identityName === "string" && identityName.length > 0) return identityName;
  return undefined;
}

function resolveSocket(pluginConfig, env, uid) {
  if (typeof pluginConfig.socket === "string" && pluginConfig.socket.length > 0) return pluginConfig.socket;
  if (typeof env.SESSIONBUS_SOCKET === "string" && env.SESSIONBUS_SOCKET.length > 0) return env.SESSIONBUS_SOCKET;
  if (typeof env.XDG_RUNTIME_DIR === "string" && env.XDG_RUNTIME_DIR.length > 0) {
    return `${env.XDG_RUNTIME_DIR}/sessionbus/presence.sock`;
  }
  return `/tmp/sessionbus-${uid}/presence.sock`;
}
