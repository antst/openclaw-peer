import net from "node:net";
import kit from "@sessionbus/kit";
import { resolveConfig } from "./config.js";
import { resolveLanes } from "./lanes.js";
import { createBridgeServer } from "./bridge.js";
import { resolveBridgePath } from "./bridge-path.js";
import { createAgentLedger, deliverToSession } from "./delivery.js";

import { PairGuard } from "./guard.js";
import { attachChannelRuntime, channelRuntimeReady, clearActiveService, currentChannelRuntime, detachChannelRuntime, setActiveService, sharedChannelState } from "./active.js";

const { connectPeer, ProtocolError } = kit;

/**
 * Owns one kit peer connection: socket tracking, a bounded in-flight task
 * set, and a plain `.action()` proxy. Ported from
 * opencode-kilo wrappers/opencodefamily/plugin/peer.mjs, trimmed to what
 * this plugin needs — no rehello, since identity changes only ever go
 * through dispose -> fresh connectPeer.
 */
class OwnedPeer {
  #peer;
  #controller = new AbortController();
  #tasks = new Set();
  #sockets = new Set();

  constructor(identity, deliver, env, options = {}) {
    const connect = options.connect || ((path) => net.createConnection(path));
    this.#peer = connectPeer(identity, deliver, env, {
      ...options,
      connect: (path) => {
        const socket = connect(path);
        this.#sockets.add(socket);
        socket.once("close", () => this.#sockets.delete(socket));
        return socket;
      },
    });
  }

  get signal() {
    return this.#controller.signal;
  }
  get ready() {
    return this.#peer.ready;
  }
  get closed() {
    return this.#peer.closed;
  }
  get error() {
    return this.#peer.error;
  }

  async action(action, args, signal) {
    if (this.#controller.signal.aborted) throw this.#controller.signal.reason || new Error("peer disposed");
    if (this.#tasks.size >= 256) throw new Error("sessionbus owner work limit reached");
    const cancel = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    const task = this.#peer.caller.action(action, args, cancel);
    this.#tasks.add(task);
    try {
      return await task;
    } finally {
      this.#tasks.delete(task);
    }
  }

  async dispose() {
    this.#controller.abort(new Error("peer disposed"));
    this.#peer.shutdown();
    for (const socket of this.#sockets) socket.destroy?.();
    await this.#peer.closed;
  }
}

/**
 * @param {object} api - host plugin API; `api.runtime` is the OpenClaw runtime facade.
 * @param {object} [deps]
 * @param {object} deps.channelSdk - {buildChannelInboundEventContext, resolveChannelInboundRouteEnvelope, createChannelInboundEnvelopeBuilder}.
 * @param {typeof createBridgeServer} [deps.createBridge] - test seam for the worker bridge factory.
 * @param {(path: string) => import("node:net").Socket} [deps.connect]
 * @param {(callback: () => void, delayMs: number) => void} [deps.schedule] - kit reconnect scheduler.
 * @param {() => number} [deps.now]
 * @param {object} [deps.env]
 * @param {string|number} [deps.uid]
 */
export function createPeerService(api, deps = {}) {
  const channelSdk = deps.channelSdk;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const uid = deps.uid ?? (process.getuid ? process.getuid() : 0);

  const peers = new Map(); // agentId -> OwnedPeer
  const bindings = new Map(); // agentId -> binding

  let guard = new PairGuard();
  let logger = console;
  let started = false;
  let runtime = api.runtime;
  let openclawConfig = {};
  let bridge = null;
  let generation = 0;
  const ledgers = new Map(); // fallback ledgers (no channel runtime attached yet); see stateMaps()
  const routeKeySets = new Map(); // fallback routes (no channel runtime attached yet)
  let attachedRuntime = null;

  function localIdFor(agentId) {
    return `openclaw-${agentId}`;
  }

  function attachTerminalCloseLogging(agentId, peer) {
    void peer.closed.then(() => {
      const error = peer.error;
      if (!error) return;
      if (error instanceof ProtocolError && error.code === -32012) {
        logger.error?.(`sessionbus peer openclaw-${agentId} superseded by another connection`);
        return;
      }
      logger.error?.(`sessionbus peer openclaw-${agentId} closed: ${error.code ?? "?"} ${error.message ?? error}`);
    });
  }

  /** Awaits disposal of every owned peer so in-flight calls settle before a reconnect changes its identity, then clears timers and maps. Shared by start() and stop(). */
  async function teardownConnections() {
    const closing = bridge;
    bridge = null;
    await closing?.close().catch((error) => logger.error?.(`sessionbus: bridge close failed: ${error?.message ?? error}`));
    await Promise.allSettled([...peers.values()].map((peer) => peer.dispose()));
    peers.clear();
    bindings.clear();
    ledgers.clear();
    routeKeySets.clear();
  }

  async function start(ctx) {
    const gen = ++generation;
    logger = ctx?.logger ?? console;
    runtime = api.runtime;
    if (peers.size > 0) {
      logger.warn?.("sessionbus: start() called with leftover connections from a previous start — tearing them down first");
      await teardownConnections();
      if (gen !== generation) return;
    }

    openclawConfig = runtime.config.current() ?? {};
    const pluginConfig = openclawConfig.plugins?.entries?.sessionbus?.config ?? {};
    const resolved = resolveConfig(pluginConfig, openclawConfig, env, uid);
    for (const error of resolved.errors) logger.error?.(`sessionbus config: ${error}`);
    let laneSettings = null;
    let laneProblem = "lanes are not configured (plugins.entries.sessionbus.config.lanes)";
    if (deps.lanes) {
      const lanes = resolveLanes(pluginConfig, openclawConfig, env, deps.lanes);
      laneSettings = lanes.settings;
      for (const error of lanes.errors) logger.error?.(`sessionbus config: ${error}`);
      if (!laneSettings && pluginConfig.lanes !== undefined) laneProblem = `lanes invalid: ${lanes.errors.join("; ")}`;
    }
    guard = PairGuard.fromConfig(openclawConfig);

    for (const binding of resolved.bindings) {
      const { agentId } = binding;
      bindings.set(agentId, binding);
      const localId = localIdFor(agentId);

      const identity = {
        product: "openclaw-peer",
        session_id: localId,
        groups: [...binding.groups],
        info: { agent_id: agentId, session_key: binding.sessionKey, openclaw_version: runtime.version },
        ...(binding.name ? { name: binding.name } : {}),
      };
      const peerEnv = { SESSIONBUS_SOCKET: resolved.socket };
      const peer = new OwnedPeer(
        identity,
        (_signal, request) =>
          deliverToSession(
            {
              cfg: () => runtime.config.current() ?? openclawConfig, // live: channel enable and agent/model edits hot-apply without a service restart
              agentId,
              guard,
              logger,
              localId,
              ledger: ledgerFor(agentId),
              routeKeys: routeKeys(agentId),
              now,
              channelReady,
              channelSdk,
              busSessionBinding: binding.busSessionBinding,
            },
            request,
          ),
        peerEnv,
        { connect: deps.connect, schedule: deps.schedule },
      );
      peers.set(agentId, peer);
      attachTerminalCloseLogging(agentId, peer);
    }

    if (deps.harness) {
      const configured = openclawConfig;
      const next = (deps.createBridge ?? createBridgeServer)({
        path: resolveBridgePath(env, uid),
        settings: () => laneSettings ?? { error: laneProblem },
        harness: deps.harness,
        configuredModel: (agentId) => {
          try {
            const model = deps.lanes?.resolveDefaultModelForAgent({ cfg: configured, agentId });
            return model?.provider && model?.model ? `${model.provider}/${model.model}` : undefined;
          } catch {
            return undefined;
          }
        },
        logger,
      });
      try {
        await next.listen();
        if (gen !== generation) {
          await next.close();
          return;
        }
        bridge = next;
      } catch (error) {
        // Peers keep working without the lane bridge.
        logger.error?.(`sessionbus: lane bridge not started: ${error?.message ?? error}`);
        await next.close().catch(() => {});
      }
    }
    started = true;
    setActiveService(self);
  }

  async function stop() {
    ++generation;
    started = false;
    clearActiveService(self);
    await teardownConnections();
  }

  // With a channel runtime attached, ledgers and routes live in its shared state (they outlive this service across a
  // plugin generation swap); before that, in this instance.
  function stateMaps() {
    const rt = currentChannelRuntime();
    return rt ? sharedChannelState(rt) : { ledgers: ledgers, routes: routeKeySets };
  }

  function ledgerFor(agentId) {
    const { ledgers: map } = stateMaps();
    if (!map.has(agentId)) map.set(agentId, createAgentLedger());
    return map.get(agentId);
  }

  function routeKeys(agentId) {
    const { routes } = stateMaps();
    if (!routes.has(agentId)) routes.set(agentId, new Set());
    return routes.get(agentId);
  }

  // A delivery that arrived in the startup window (before attach) used this instance's fallback ledger and routes. Hand
  // those objects to the channel's shared state, so a retransmission after attach finds its entry and the in-flight
  // counter stays one object. (If the channel already has shared state, e.g. a generation swap, nothing was in the
  // fallback: deliveries need an attached channel to dispatch.)
  function adoptFallbackState(rt) {
    const shared = sharedChannelState(rt);
    for (const [agentId, ledger] of ledgers) if (!shared.ledgers.has(agentId)) shared.ledgers.set(agentId, ledger);
    for (const [agentId, routes] of routeKeySets) if (!shared.routes.has(agentId)) shared.routes.set(agentId, routes);
    ledgers.clear();
    routeKeySets.clear();
  }

  function attachChannel(rt) {
    adoptFallbackState(rt);
    attachedRuntime = rt;
    attachChannelRuntime(rt);
  }

  function detachChannel() {
    if (attachedRuntime) detachChannelRuntime(attachedRuntime);
    attachedRuntime = null;
  }

  // Process-wide (active.js): a service created by a plugin reload finds the runtime the running channel attached.
  const channelReady = (timeoutMs) => channelRuntimeReady(timeoutMs);

  const self = {
    id: "sessionbus-peers",
    attachChannel,
    detachChannel,
    channelReady,
    start,
    stop,
    ledgerFor,
    routeKeys,
    peerFor: (agentId) => peers.get(agentId),
    bindingFor: (agentId) => bindings.get(agentId),
    laneConn: (key) => bridge?.laneConn(key),
    get guard() {
      return guard;
    },
    get logger() {
      return logger;
    },
    get runtime() {
      return runtime;
    },
    config: () => runtime.config.current(),
    get started() {
      return started;
    },
  };
  return self;
}
