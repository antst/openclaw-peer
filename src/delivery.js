import { renderInbound } from "./render.js";

const MAX_BODY_BYTES = 65536;
const MAX_BACKLOG = 16;
const CHANNEL_WAIT_MS = 10_000;
const LEDGER_TTL_MS = 20 * 60_000;
const LEDGER_MAX = 5000;

/** Per-agent dedupe ledger + count of unfinished dispatches (D6). */
export function createAgentLedger() {
  return { entries: new Map(), inflight: 0 };
}

function sweep(ledger, now) {
  for (const [key, entry] of ledger.entries) {
    if (!entry.pending && now - entry.settledAt >= LEDGER_TTL_MS) ledger.entries.delete(key);
  }
  if (ledger.entries.size < LEDGER_MAX) return;
  // Oldest settled first (Map keeps insertion order); a pending entry is never evicted.
  for (const [key, entry] of ledger.entries) {
    if (ledger.entries.size < LEDGER_MAX) break;
    if (!entry.pending) ledger.entries.delete(key);
  }
}

/**
 * The peer id of the bus session a message lands in, per `busSessionBinding` (default "name"): the sender's bus name,
 * its session_id, or `%all` (one bus session per agent; '%' never survives in an encoded name and no session_id starts
 * with it, so neither other mode can produce this id). In a name, '%', ':' and whitespace become '%' + 4 lowercase hex
 * digits: OpenClaw parses ':thread:' / ':topic:' markers out of session keys, and fixed width keeps distinct names
 * distinct. A sender without a name falls back to its session_id.
 * @param {"name"|"sessionId"|"singleton"|undefined} mode
 * @param {{session_id: string, name?: string}} from
 * @returns {string}
 */
export function boundPeerId(mode, from) {
  if (mode === "sessionId") return from.session_id;
  if (mode === "singleton") return "%all";
  if (typeof from.name !== "string" || from.name.length === 0) return from.session_id;
  return from.name.replace(/[%:\s]/gu, (character) => `%${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Turns a bus message into a turn of a `sessionbus` channel session; `busSessionBinding` chooses which one (boundPeerId).
 * Replies, dedupe and the loop guard stay keyed by the sender's session_id.
 * @param {object} deps
 * @param {() => object} deps.cfg - current OpenClaw config.
 * @param {string} deps.agentId
 * @param {{admit: (localId: string, counterpartId: string) => boolean}} [deps.guard] - defaults to always-admit.
 * @param {object} [deps.logger]
 * @param {string} deps.localId
 * @param {{entries: Map, inflight: number}} deps.ledger - createAgentLedger() of this agent.
 * @param {Set<string>} deps.routeKeys - session keys of this agent's recorded channel routes (tool offer).
 * @param {() => number} [deps.now]
 * @param {(timeoutMs: number) => Promise<object|null>} deps.channelReady - resolves the attached channelRuntime, or null on timeout.
 * @param {object} deps.channelSdk - {buildChannelInboundEventContext, resolveChannelInboundRouteEnvelope, createChannelInboundEnvelopeBuilder}.
 * @param {"name"|"sessionId"|"singleton"} [deps.busSessionBinding] - what the bus session is bound to; default "name".
 * @param {{message_id: string, from: {session_id: string, name?: string, product: string, groups: string[]}, body: string}} request
 */
export async function deliverToSession(deps, request) {
  const { ledger, now = Date.now } = deps;
  const sender = request.from.session_id;
  // (1) A retransmission gets the original receipt: no guard debit, no second dispatch.
  const key = JSON.stringify([sender, request.message_id]);
  let existing = ledger.entries.get(key);
  if (existing && !existing.pending && now() - existing.settledAt >= LEDGER_TTL_MS) {
    ledger.entries.delete(key); // expired: the sender's retry is a new delivery
    existing = undefined;
  }
  if (existing) return { ...(await existing.receipt) };

  sweep(ledger, now());
  const entry = { pending: true, settledAt: 0, receipt: null };
  entry.receipt = processDelivery(deps, request, entry).then((receipt) => {
    // Only a started dispatch is remembered; a refusal is re-evaluated when the sender tries again.
    if (receipt.disposition !== "queued_for_next_turn") ledger.entries.delete(key);
    return receipt;
  }, (error) => {
    ledger.entries.delete(key);
    throw error;
  });
  ledger.entries.set(key, entry);
  return { ...(await entry.receipt) };
}

async function processDelivery(deps, request, entry) {
  const { agentId, guard = { admit: () => true }, logger, localId, channelReady, channelSdk, ledger, routeKeys } = deps;
  const cfg = deps.cfg();
  const sender = request.from.session_id;
  const peerId = boundPeerId(deps.busSessionBinding, request.from);
  const key = JSON.stringify([sender, request.message_id]);

  let routedTo; // the channel session key, once the route is known
  const finish = (disposition, extra) => {
    // PluginLogger takes one string (openclaw src/plugins/logger-types.ts:2-7); an object throws on the live Gateway.
    // The session key (when routed) and the refusal reason make a delivery diagnosable from the Gateway log alone.
    logger?.info?.(`sessionbus: delivery ${request.message_id} from ${sender} → ${disposition}${routedTo ? ` session=${routedTo}` : ""}${extra?.reason ? ` (${extra.reason})` : ""}`);
    return { disposition, ...(extra ?? {}) };
  };

  if (Buffer.byteLength(request.body ?? "", "utf8") > MAX_BODY_BYTES) {
    return finish("rejected", { reason: "message too large (64 KiB limit)" });
  }
  if (ledger.inflight >= MAX_BACKLOG) {
    return finish("rejected", { reason: "OpenClaw session backlog full" });
  }
  // CR-P2a-1: reserve the backlog slot in the same synchronous block as the check, before any await;
  // it is released on every exit before a dispatch starts, and by the dispatch promise afterwards.
  ledger.inflight += 1;
  const slot = { held: true };
  try {
    if (!guard.admit(localId, sender)) {
      return finish("rejected", { reason: "openclaw-peer loop guard: pair budget exceeded" });
    }

    const notStarted = () => finish("rejected", { reason: "sessionbus channel not started (set channels.sessionbus.enabled: true)" });
    if (cfg?.channels?.sessionbus?.enabled !== true) return notStarted();
    const rt = await channelReady(CHANNEL_WAIT_MS);
    if (!rt) return notStarted();

    // D23: bus input is never command input, whatever the operator's commands.allowFrom says. The config is
    // projected per dispatch, never mutated.
    // The bus address is the agent (Amendment 3): a synthetic peer-wildcard binding for the addressee goes first, so channel-
    // or account-wide bindings (including the one OpenClaw materializes for the legacy `default: true` marker) cannot take
    // the message from it. Only a peer-specific operator binding of this sender to another agent still wins (route_mismatch).
    const own = { agentId, match: { channel: "sessionbus", peer: { kind: "direct", id: "*" } } };
    const cfg2 = { ...cfg, bindings: [own, ...(cfg?.bindings ?? [])], commands: { ...cfg?.commands, allowFrom: { ...cfg?.commands?.allowFrom, sessionbus: [] } } };
    const accountId = "default";
    const { route } = channelSdk.resolveChannelInboundRouteEnvelope({
      cfg: cfg2,
      channel: "sessionbus",
      accountId,
      defaultAgentId: agentId,
      peer: { kind: "direct", id: peerId },
      dmScope: "per-channel-peer",
    });
    if (route.agentId !== agentId) {
      // The cause is local configuration: it goes to the Gateway error log, never into the receipt the remote sender reads.
      // Only a binding that names this very sender for another agent (tier peer) outranks the synthetic peer-wildcard one.
      logger?.error?.(`sessionbus: route_mismatch for ${request.message_id} from ${sender} (peer ${peerId}): an OpenClaw binding for channel sessionbus (matchedBy ${route.matchedBy ?? "binding"}) routes this sender to agent ${route.agentId}, but the message is addressed to ${agentId}; remove the binding (README: Several agents on the bus)`);
      return finish("rejected", { reason: "route_mismatch" });
    }
    const sessionKey = route.sessionKey;
  routedTo = sessionKey;
    routeKeys.add(sessionKey);

    try {
      let access;
      if (rt.inbound.ingress) {
        access = await rt.inbound.ingress.resolveStable({
          cfg: cfg2,
          channelId: "sessionbus",
          accountId,
          identity: { key: "sender", entryIdPrefix: "sessionbus-entry" },
          subject: { stableId: sender },
          conversation: { kind: "direct", id: peerId },
          contextBinding: { agentId, sessionKey, nativeChannelId: sender, messageId: request.message_id, inboundEventKind: "user_request" },
          dmPolicy: "open",
          groupPolicy: "open",
          allowFrom: ["*"],
        });
        if (access.ingress?.admission !== "dispatch") return finish("rejected", { reason: `ingress: ${access.ingress?.admission}` });
      }

      const rendered = renderInbound(request);
      const body = channelSdk.createChannelInboundEnvelopeBuilder({ cfg: cfg2, route: { agentId, sessionKey } })({
        channel: "Sessionbus",
        from: sender,
        timestamp: Date.now(),
        body: rendered,
      });
      const buildContext = rt.inbound.buildContext ?? channelSdk.buildChannelInboundEventContext;
      const ctxPayload = buildContext({
        channel: "sessionbus",
        accountId,
        messageId: request.message_id,
        messageIdFull: request.message_id,
        timestamp: Date.now(),
        from: sender,
        sender: { id: sender, name: request.from.name ?? sender },
        conversation: { kind: "direct", id: peerId, label: peerId, nativeChannelId: sender },
        route: { agentId, dmScope: route.dmScope, accountId, routeSessionKey: sessionKey, dispatchSessionKey: sessionKey },
        reply: { to: sender, originatingTo: sender },
        message: { body, bodyForAgent: rendered, rawBody: request.body, commandBody: request.body },
        media: [],
        ...(access ? { channelIngress: access } : {}),
        // D11: both flags — the text reaches the agent as text, never as a command or directive.
        extra: { CommandInterpretationSuppressed: true },
        access: { commands: { authorized: false }, mentions: { canDetectMention: false, wasMentioned: false } },
      });
      // Not awaited: the receipt means "will be processed", the turn can take minutes.
      let dispatched;
      try {
        dispatched = rt.inbound.dispatch({
          cfg: cfg2,
          channel: "sessionbus",
          accountId,
          route: { agentId, dmScope: route.dmScope, sessionKey },
          ctxPayload,
          delivery: {
            // U-05: the agent's final text goes nowhere; it answers with the sessionbus tool.
            deliver: async (_payload, info) => logger?.info?.(`sessionbus: reply suppressed ${request.message_id} kind=${info?.kind}`),
            onError: (error) => logger?.error?.(`sessionbus: reply error ${request.message_id}: ${error?.message ?? error}`),
          },
          dispatcherOptions: {},
          replyOptions: {},
          replyPipeline: {},
          record: { onRecordError: (error) => logger?.error?.(`sessionbus: record error ${request.message_id}: ${error?.message ?? error}`) },
        });
      } catch (error) {
        throw error; // the reserved slot is released by the caller's finally
      }
      slot.held = false; // the dispatch promise now owns the slot
      Promise.resolve(dispatched).then(
        () => {
          entry.pending = false;
          entry.settledAt = deps.now?.() ?? Date.now();
        },
        (error) => {
          // PC-03: a dispatch that fails after the receipt must not leave a cached success; the retransmission dispatches again.
          logger?.error?.(`sessionbus: dispatch ${request.message_id} failed after receipt: ${error?.message ?? error}`);
          ledger.entries.delete(key);
        },
      ).finally(() => {
        ledger.inflight -= 1;
      });
    } catch (error) {
      return finish("rejected", { reason: `dispatch failed: ${error?.message ?? error}` });
    }
    return finish("queued_for_next_turn");
  } finally {
    if (slot.held) ledger.inflight -= 1;
  }
}
