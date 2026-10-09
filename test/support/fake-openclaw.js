// Hermetic OpenClaw host double, rebuilt from the 8.2 and 9.6 sources.
// Every simulated member names the source it mirrors;
// paths are relative to that upstream.
//
// Two layers:
// - createFakeRuntime(): the per-plugin `api.runtime` (channel inbound dispatch, heartbeat,
//   config, session store, outbound adapters) — usable on its own as `{ runtime }`.
// - createFakeHost(): the plugin loader around it — `register(api)` with
//   registerService/registerTool/registerChannel/on, manifest `contracts.tools`, registration
//   modes (an `activate:false` snapshot never starts its services), service
//   start/stop, tool resolution and `agent_end` dispatch.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// OpenClaw 8.2 src/config/sessions/store-entry.ts:17-18 and
// src/sessions/session-key-utils.ts:204-235; same functions in OpenClaw 9.6.
// Matrix room tails and Signal group IDs are opaque; other key parts fold.
function normalizeSessionKey(key) {
  const raw = String(key).trim();
  const matrix = raw.match(/^(.*?:matrix:(?:channel|group):)(.*)$/i);
  if (matrix) return matrix[1].toLowerCase() + matrix[2];
  const signal = raw.match(/^(.*?signal:group:)([^:]+)(.*)$/i);
  if (signal) return signal[1].toLowerCase() + signal[2] + signal[3].toLowerCase();
  return raw.toLowerCase();
}

// openclaw@9.8 dist admission-evidence-*.mjs contextHandoffMatches: the dispatch context must carry the conversation id,
// the native id (reply.nativeChannelId ?? conversation.nativeChannelId) and the dispatch session key that the ingress
// binding (scope.conversation, contextBinding) recorded. Returns the first mismatching field, or null.
function handoffMismatch(binding, ctx) {
  if (!binding) return "no ingress binding for this message";
  if (ctx?.conversation?.id !== binding.conversation?.id) return "conversation.id";
  if ((ctx?.reply?.nativeChannelId ?? ctx?.conversation?.nativeChannelId) !== binding.contextBinding?.nativeChannelId) return "nativeChannelId";
  if (ctx?.route?.dispatchSessionKey !== binding.contextBinding?.sessionKey) return "route.dispatchSessionKey";
  return null;
}

// openclaw@8.2 src/plugins/runtime/index.ts:270 (VERSION)
const DEFAULT_VERSION = "2026.8.2";

/**
 * @param {object} [options]
 */
export function createFakeRuntime(options = {}) {
  const version = options.version ?? DEFAULT_VERSION;
  const sessionEntries = new Map(Object.entries(options.sessionEntries ?? {}));
  const adapters = new Map(Object.entries(options.adapters ?? {}));
  const heartbeatRequests = [];
  // Channel inbound: openclaw@8.2 src/plugins/runtime/types-channel.ts inbound.{buildContext,dispatch};
  // 9.x adds inbound.ingress.resolveStable. A dispatch stays pending until release(sessionKey); one that
  // starts while another is pending on the same key is a steer (queue.md:34).
  const dispatches = [];
  const pending = new Map(); // sessionKey -> [{resolve, reject}]
  let failNext = null;
  const logs = { info: [], warn: [], error: [], debug: [] };
  let openclawConfig = options.config ?? {};
  let heartbeatThrow = options.requestHeartbeatThrow ?? null;

  // OpenClaw 8.2 src/infra/heartbeat-wake.ts:754,777; OpenClaw 9.6
  // src/infra/heartbeat-wake.ts:13-14 and src/plugins/runtime/runtime-system.ts:2,20-34.
  function requestHeartbeat(request) {
    if (heartbeatThrow) throw heartbeatThrow;
    heartbeatRequests.push(request);
  }

  // 9.x: resolveStable records the ingress binding per message id; dispatch checks the context against it.
  const ingressBindings = !version.startsWith("2026.8.") ? new Map() : null;
  const ingressCalls = [];

  const channelRuntime = {
    inbound: {
      buildContext: (params) => {
        const { extra, ...rest } = params;
        // openclaw@8.2 src/channels/inbound-event/context.ts:518-592 — `extra` is spread into the context root; no `extra` key.
        return { ...rest, ...(extra ?? {}) };
      },
      dispatch(params) {
        const sessionKey = params.route.sessionKey;
        if (ingressBindings) {
          const mismatch = handoffMismatch(ingressBindings.get(params.ctxPayload?.messageId), params.ctxPayload);
          if (mismatch) return Promise.reject(new Error(`ingress handoff mismatch: ${mismatch}`));
        }
        const waiting = pending.get(sessionKey) ?? [];
        dispatches.push({ sessionKey, ctxPayload: params.ctxPayload, cfg: params.cfg, delivery: params.delivery, steered: waiting.length > 0 });
        const failure = failNext;
        failNext = null;
        return new Promise((resolve, reject) => {
          if (failure) {
            reject(failure);
            return;
          }
          waiting.push({ resolve, reject });
          pending.set(sessionKey, waiting);
        });
      },
      ...(ingressBindings ? {
        ingress: {
          resolveStable: async (params) => {
            ingressCalls.push(params);
            ingressBindings.set(params.contextBinding?.messageId, params);
            return { ingress: { admission: "dispatch" } };
          },
        },
      } : {}),
    },
  };

  const runtime = {
    // openclaw@8.2 src/plugins/runtime/index.ts:270
    version,
    heartbeatRequests,
    dispatches,
    /** 9.x: every inbound.ingress.resolveStable params, in call order. */
    ingressCalls,
    channelRuntime,
    /** Test helper: finish every pending dispatch of one session key. */
    release(sessionKey) {
      for (const item of pending.get(sessionKey) ?? []) item.resolve();
      pending.delete(sessionKey);
    },
    /**
     * Test helper: the next dispatch promise rejects with `error`. When a dispatch is already pending, the most
     * recently started pending one is rejected now (the host dropping a turn after the receipt, PC-03) and
     * nothing is armed.
     */
    failNextDispatch(error) {
      const latest = [...pending.entries()].reverse().find(([, waiting]) => waiting.length > 0);
      if (latest) {
        const [sessionKey, waiting] = latest;
        waiting.pop().reject(error);
        if (waiting.length === 0) pending.delete(sessionKey);
        return;
      }
      failNext = error;
    },
    logs,
    // openclaw@8.2 src/plugins/logger-types.ts:2-7 (api.logger / ctx.logger)
    logger: createStrictLogger(logs),
    // openclaw@8.2 src/plugins/runtime/types-core.ts:409-425
    system: {
      requestHeartbeat,
    },
    // openclaw@8.2 src/plugins/runtime/types-core.ts:318-335 — current() only; no loadConfig
    config: {
      current: () => openclawConfig,
      set: (next) => {
        openclawConfig = next;
      },
    },
    agent: {
      session: {
        // OpenClaw 8.2 src/plugins/runtime/runtime-agent.ts:103,118;
        // OpenClaw 9.6 src/plugins/runtime/runtime-agent.ts:73,88 — synchronous scoped lookup.
        getSessionEntry({ agentId, sessionKey }) {
          const key = normalizeSessionKey(sessionKey);
          return sessionEntries.get(`${agentId}:${key}`) ?? sessionEntries.get(key);
        },
        /** Test helper: seed a session entry. */
        setSessionEntry(agentId, sessionKey, entry) {
          sessionEntries.set(`${agentId}:${normalizeSessionKey(sessionKey)}`, entry);
        },
      },
    },
    channel: {
      outbound: {
        // openclaw@8.2 src/plugins/runtime/types-channel.ts:182-183, src/channels/plugins/outbound/load.ts:14-18 — async
        async loadAdapter(channel) {
          return adapters.get(channel);
        },
        /** Test helper: install an outbound adapter. */
        setAdapter(channel, adapter) {
          adapters.set(channel, adapter);
        },
      },
    },
    /** Test helper: toggle whether requestHeartbeat throws, without rebuilding the runtime. */
    setHeartbeatThrow(error) {
      heartbeatThrow = error ?? null;
    },
  };
  return runtime;
}

/** Records every call for assertions; `sendText` resolves unless `fail` is set. */
export function createRecordingAdapter({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async sendText(params) {
      calls.push(params);
      if (fail) throw fail;
    },
  };
}

/**
 * OpenClaw's PluginLogger takes exactly one string (openclaw@8.2 src/plugins/logger-types.ts:2-7);
 * its subsystem logger calls string methods on it, so an object throws
 * `TypeError: text.includes is not a function` on the live Gateway. Mirror that contract.
 */
export function createStrictLogger(logs = { info: [], warn: [], error: [], debug: [] }) {
  const method = (level) => (...args) => {
    if (args.length !== 1 || typeof args[0] !== "string") {
      throw new TypeError(`PluginLogger.${level} expects one string, got ${args.map((a) => typeof a).join(", ")}`);
    }
    logs[level].push(args);
  };
  return { info: method("info"), warn: method("warn"), error: method("error"), debug: method("debug") };
}

// openclaw@8.2 src/plugins/hook-types.ts:143-187
const PLUGIN_HOOK_NAMES = new Set([
  "before_model_resolve", "agent_turn_prepare", "before_prompt_build", "before_agent_reply", "model_call_started",
  "model_call_ended", "llm_input", "llm_output", "before_agent_finalize", "agent_end", "before_compaction",
  "after_compaction", "before_reset", "inbound_claim", "channel_pairing_requested", "message_received",
  "message_sending", "reply_payload_sending", "message_sent", "before_tool_call", "after_tool_call",
  "tool_result_persist", "before_message_write", "session_start", "session_end", "subagent_delivery_target",
  "subagent_spawned", "subagent_progress", "subagent_ended", "gateway_start", "gateway_stop",
  "heartbeat_prompt_contribution", "cron_reconciled", "cron_changed", "skill_proposal_evaluate",
  "skill_proposal_changed", "skill_changed", "before_dispatch", "reply_dispatch", "before_install",
  "before_agent_run", "resolve_exec_env",
]);
// openclaw@8.2 src/plugins/hook-types.ts:228-238
const CONVERSATION_HOOK_NAMES = new Set([
  "before_model_resolve", "agent_turn_prepare", "before_prompt_build", "before_agent_reply", "llm_input",
  "llm_output", "before_agent_finalize", "agent_end", "before_agent_run",
]);

// openclaw@8.2 src/plugins/tool-contracts.ts:10-27 — trimmed, empty dropped, deduped
function normalizeToolNames(names) {
  return [...new Set(names.map((name) => (typeof name === "string" ? name.trim() : "")).filter(Boolean))];
}

function defaultManifest() {
  return JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"));
}

/**
 * Plugin host double.
 *
 * @param {object} [options]
 * @param {object} [options.config] full OpenClaw config (`runtime.config.current()`)
 * @param {object} [options.runtime] an existing createFakeRuntime(); else one is built from `runtimeOptions` + `config`
 * @param {object} [options.runtimeOptions]
 * @param {object} [options.manifest] plugin manifest (default: this repo's openclaw.plugin.json)
 * @param {"global"|"bundled"} [options.origin] plugin origin; non-bundled needs allowConversationAccess for agent_end
 * @param {string} [options.stateDir]
 * @param {(path: string) => import("node:net").Socket} [options.connect] socket factory for the plugin's peer connections
 * @param {string} [options.version] OpenClaw version of the runtime (ingress present for non-8.x)
 */
export function createFakeHost(options = {}) {
  const runtime = options.runtime ?? createFakeRuntime({ ...(options.version ? { version: options.version } : {}), ...(options.runtimeOptions ?? {}), config: options.config ?? options.runtimeOptions?.config });
  // `options.connect` (a socket factory such as daemon.connect) is served over a real unix socket that start()
  // points `plugins.entries.sessionbus.config.socket` at — the plugin dials it like any daemon, no production seam.
  let connectProxy = null;
  const manifest = options.manifest ?? defaultManifest();
  const origin = options.origin ?? "global";
  const stateDir = options.stateDir ?? "/tmp/openclaw-fake-state";
  /** openclaw@8.2 src/plugins/registry-state.ts:73-75 — {level, pluginId, source, message} */
  const diagnostics = [];
  /** Host-side log lines (not the plugin's), e.g. a failed agent_end hook. */
  const hostLogs = { warn: [], error: [] };
  const registrations = [];

  function pluginEntryConfig(id) {
    return runtime.config.current()?.plugins?.entries?.[id] ?? {};
  }

  /**
   * Run a plugin entry's `register(api)` once.
   * `activate:false` mirrors openclaw@8.2 src/plugins/tools.ts:1230-1235 — a tool-discovery snapshot load
   * (mode "tool-discovery", src/plugins/loader-registration-plan.ts:53-60) whose registry is never activated
   * (src/plugins/loader-runtime-load.ts:283-290): its services never start and its hooks never fire.
   */
  function register(entry, { activate = true } = {}) {
    const id = entry.id ?? manifest.id;
    const registration = {
      id,
      // openclaw@8.2 src/plugins/loader-registration-plan.ts:53-60,81
      mode: activate ? "full" : "tool-discovery",
      activated: activate,
      services: [],
      tools: [],
      commands: [],
      interactiveHandlers: [],
      hooks: [],
      channelPlugin: null,
    };
    const record = (level, message) => diagnostics.push({ level, pluginId: id, source: "fake-host", message });
    // Plugin log lines land in runtime.logs, next to the service ctx logger's.
    const logger = createStrictLogger(runtime.logs);
    const entryConfig = pluginEntryConfig(id);
    // openclaw@8.2 src/plugins/api-builder.ts:124-245, src/plugins/registry-api.ts:137-407
    const api = {
      id,
      name: entry.name ?? manifest.name,
      description: entry.description,
      source: "fake-host",
      registrationMode: registration.mode,
      config: runtime.config.current(),
      pluginConfig: entryConfig.config,
      runtime,
      // openclaw@8.2 src/plugins/registry-api.ts:33-40,178 — normalizeLogger copies info/warn/error/debug
      logger,
      resolvePath: (input) => input,
      // openclaw@8.2 src/plugins/plugin-registration.types.ts:385-389, src/plugins/registry-registrars-operations.ts:324-363
      registerService(service) {
        const serviceId = service.id.trim(); // the host calls .trim() directly; a missing id throws
        if (!serviceId) {
          record("error", "service id is required");
          return;
        }
        // :336 — the same owner registering the same id again keeps the first
        if (registration.services.some((item) => item.id === serviceId)) return;
        registration.services.push({ id: serviceId, service });
      },
      // openclaw@8.2 src/plugins/registry-registrars-channels.ts — {plugin}; the channel adapter is kept for startChannel
      registerChannel({ plugin }) {
        registration.channelPlugin = plugin;
      },
      // openclaw@8.2 src/plugins/registry-registrars-operations.ts:383-436 — a command needs no manifest entry
      registerCommand(command) {
        registration.commands.push(command);
      },
      // openclaw@8.2 src/plugins/plugin-api.types.ts:303 — {channel, namespace, handler}
      registerInteractiveHandler(registrationEntry) {
        registration.interactiveHandlers.push(registrationEntry);
      },
      // openclaw@8.2 src/plugins/registry-registrars-tools-hooks.ts:212-258, src/plugins/tool-types.ts:81-89
      registerTool(tool, opts) {
        const declaredNames = normalizeToolNames(manifest.contracts?.tools ?? []);
        if (declaredNames.length === 0) {
          record("error", "plugin must declare contracts.tools before registering agent tools");
          return;
        }
        const names = [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : [])];
        const factory = typeof tool === "function" ? tool : () => tool;
        if (typeof tool !== "function") names.push(tool.name);
        const normalized = normalizeToolNames(names);
        const undeclared = normalized.filter((name) => !declaredNames.includes(name));
        if (undeclared.length > 0) {
          record("error", `plugin must declare contracts.tools for: ${undeclared.join(", ")}`);
          return;
        }
        registration.tools.push({ factory, names: normalized, declaredNames, optional: opts?.optional === true });
      },
      // openclaw@8.2 src/plugins/registry-registrars-tools-hooks.ts:365-398, src/plugins/hook-policy-decisions.ts:10-17
      on(hookName, handler) {
        if (!PLUGIN_HOOK_NAMES.has(hookName)) {
          record("warn", `unknown typed hook "${String(hookName)}" ignored`);
          return;
        }
        const allowed = origin === "bundled" ? entryConfig.hooks?.allowConversationAccess !== false : entryConfig.hooks?.allowConversationAccess === true;
        if (CONVERSATION_HOOK_NAMES.has(hookName) && !allowed) {
          record(
            "warn",
            origin !== "bundled"
              ? `typed hook "${hookName}" blocked because non-bundled plugins must set plugins.entries.${id}.hooks.allowConversationAccess=true`
              : `typed hook "${hookName}" blocked by plugins.entries.${id}.hooks.allowConversationAccess=false`,
          );
          return;
        }
        registration.hooks.push({ hookName, handler });
      },
    };
    registration.api = api;
    entry.register(api);
    registrations.push(registration);
    return registration;
  }

  // openclaw@8.2 src/plugins/services.ts:86-146 — {config, workspaceDir?, stateDir, logger, serviceHealth?}
  function serviceContext() {
    return {
      config: runtime.config.current(),
      stateDir,
      logger: runtime.logger,
      serviceHealth: { reportFailure() {}, clearFailure() {} },
    };
  }

  const active = () => registrations.filter((item) => item.activated);

  /**
   * openclaw@8.2 src/plugins/services.ts:222-457 — only the activated registry's services start, in order,
   * each awaited; a throwing start is logged and followed by a bounded stop (:428-444).
   */
  async function start() {
    if (options.connect && !connectProxy) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "fh-"));
      const socketPath = path.join(dir, "d.sock");
      const sockets = new Set();
      const server = net.createServer((socket) => {
        const memory = options.connect(socketPath);
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        memory.on("error", () => {});
        socket.pipe(memory);
        memory.pipe(socket);
        memory.once("close", () => socket.destroy());
        socket.once("close", () => memory.destroy?.());
      });
      await new Promise((resolve) => server.listen(socketPath, resolve));
      connectProxy = { dir, server, sockets };
      const current = runtime.config.current() ?? {};
      const entry = current.plugins?.entries?.sessionbus ?? {};
      runtime.config.set({ ...current, plugins: { ...current.plugins, entries: { ...current.plugins?.entries, sessionbus: { ...entry, config: { ...entry.config, socket: socketPath } } } } });
    }
    for (const registration of active()) {
      for (const item of registration.services) {
        if (item.started) continue;
        const ctx = serviceContext();
        try {
          await item.service.start(ctx);
          item.started = true;
          item.ctx = ctx;
        } catch (error) {
          hostLogs.error.push(`plugin service failed (${item.id}): ${String(error)}`);
          await item.service.stop?.(ctx);
        }
      }
    }
  }

  // openclaw@8.2 src/plugins/services.ts:332,415 — reverse order, same ctx object
  async function stop() {
    await stopChannel();
    await stopServices();
    if (connectProxy) {
      const proxy = connectProxy;
      connectProxy = null;
      for (const socket of proxy.sockets) socket.destroy();
      await new Promise((resolve) => proxy.server.close(resolve));
      rmSync(proxy.dir, { recursive: true, force: true });
    }
  }

  async function stopServices() {
    for (const registration of [...active()].reverse()) {
      for (const item of [...registration.services].reverse()) {
        if (!item.started) continue;
        item.started = false;
        await item.service.stop?.(item.ctx);
      }
    }
  }

  const channelRuns = [];

  /**
   * openclaw@8.2 src/gateway/server-channels.ts — starts the enabled account of every activated channel plugin;
   * startAccount runs until its abortSignal fires, so it is not awaited here.
   */
  function startChannel() {
    const cfg = runtime.config.current();
    for (const registration of active()) {
      const plugin = registration.channelPlugin;
      if (!plugin) continue;
      const account = plugin.config.resolveAccount(cfg, "default");
      if (!account.enabled) continue;
      const controller = new AbortController();
      const status = [];
      const run = plugin.gateway.startAccount({
        cfg,
        accountId: "default",
        account,
        runtime: runtime.logger,
        abortSignal: controller.signal,
        channelRuntime: runtime.channelRuntime,
        setStatus: (next) => status.push(next),
      });
      channelRuns.push({ controller, run, status });
    }
  }

  async function stopChannel() {
    for (const item of channelRuns.splice(0)) {
      item.controller.abort();
      await item.run;
    }
  }

  function pick(which) {
    if (which === "snapshot") return registrations.find((item) => !item.activated);
    if (which === "active") return active()[0];
    // openclaw@8.2 src/plugins/tools.ts:1236-1252 — the active registry when it holds the plugin's tools, else a snapshot
    return active().find((item) => item.tools.length > 0) ?? registrations.find((item) => !item.activated && item.tools.length > 0);
  }

  /**
   * Resolve the plugin's tools for one agent run.
   * ctx: openclaw@8.2 src/plugins/tool-types.ts:22-79 (agentId, sessionKey, sessionId, …),
   * filled per src/agents/openclaw-tools.plugin-context.ts:67-72,97-125.
   * Resolve-time rules: src/plugins/tools.ts:452-457,1361-1372 (throw → logged+skipped, null → skipped),
   * :521-543 (name/execute/parameters required), :1452-1480 (undeclared or duplicate name dropped).
   */
  function resolveTools(ctx, { registration: which } = {}) {
    const registration = pick(which);
    if (!registration) return [];
    const tools = [];
    for (const item of registration.tools) {
      let produced;
      try {
        produced = item.factory(ctx);
      } catch (error) {
        hostLogs.error.push(`plugin tool failed (${registration.id}): ${String(error)}`);
        continue;
      }
      if (produced == null) continue;
      for (const tool of Array.isArray(produced) ? produced : [produced]) {
        if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name.trim() || typeof tool.execute !== "function" || !tool.parameters || typeof tool.parameters !== "object") {
          diagnostics.push({ level: "error", pluginId: registration.id, source: "fake-host", message: "plugin tool is malformed" });
          continue;
        }
        if (!item.declaredNames.includes(tool.name)) {
          diagnostics.push({ level: "error", pluginId: registration.id, source: "fake-host", message: `plugin tool is undeclared (${registration.id}): ${tool.name}` });
          continue;
        }
        if (tools.some((other) => other.name === tool.name)) {
          diagnostics.push({ level: "error", pluginId: registration.id, source: "fake-host", message: "plugin tool name conflict" });
          continue;
        }
        tools.push(wrapTool(tool));
      }
    }
    return tools;
  }

  // openclaw@8.2 src/plugins/tools.ts:135-157 — execute(toolCallId, params, signal, onUpdate) with `this` = the tool
  function wrapTool(tool) {
    return new Proxy(tool, {
      get(target, property, receiver) {
        if (property === "execute") return (toolCallId, params, signal, onUpdate) => Reflect.apply(target.execute, target, [toolCallId, params, signal, onUpdate]);
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /** The named tool for this ctx, or undefined when the plugin offers none. */
  function tool(ctx, name = manifest.contracts?.tools?.[0], opts) {
    return resolveTools(ctx, opts).find((item) => item.name === name);
  }

  /**
   * Fire `agent_end` on the activated registry.
   * Event openclaw@8.2 src/plugins/hook-types.ts:442-448 {runId?, messages, success, error?, durationMs?};
   * ctx :299-337 {runId?, agentId?, sessionKey?, sessionId?, …}. Handlers run in parallel
   * (src/plugins/hooks.ts:1185-1191); a failure is logged as a warning (src/agents/harness/lifecycle-hook-helpers.ts:102-118).
   */
  async function emitAgentEnd(event, ctx) {
    const fullEvent = { messages: [], ...event };
    const handlers = active().flatMap((item) => item.hooks.filter((hook) => hook.hookName === "agent_end"));
    try {
      await Promise.all(handlers.map((hook) => hook.handler({ ...fullEvent, ...(ctx?.runId ? { runId: ctx.runId } : {}) }, ctx)));
    } catch (error) {
      hostLogs.warn.push(`agent_end hook failed: ${String(error)}`);
    }
  }

  return {
    runtime,
    manifest,
    diagnostics,
    hostLogs,
    registrations,
    register,
    start,
    stop,
    startChannel,
    stopChannel,
    release: (sessionKey) => runtime.release(sessionKey),
    failNextDispatch: (error) => runtime.failNextDispatch(error),
    resolveTools,
    tool,
    emitAgentEnd,
  };
}
