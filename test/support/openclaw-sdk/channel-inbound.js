// Shim for `openclaw/plugin-sdk/channel-inbound`.

// openclaw@8.2 src/routing/resolve-route.ts (9.8 the same tiers): the first tier that has a matching binding wins over
// defaultAgentId, in the order peer > peer.parent > peer.wildcard > guild > team > account > channel > default
// (8.2 :396-:515 and :770-:820; 9.8 :281-:443). Only the tiers a direct sessionbus message can reach are matched; the
// peer.parent, guild and team tiers need a parent peer, a guild or a team, which a bus message never carries.
const TIERS = ["binding.peer", "binding.peer.parent", "binding.peer.wildcard", "binding.guild", "binding.team", "binding.account", "binding.channel"];

function tierOf(match, { channel, accountId, peer }) {
  if (!match || match.channel !== channel) return null;
  // An omitted accountId matches the default account only; "*" matches any account (the channel tier).
  const account = match.accountId === undefined ? "default" : match.accountId;
  if (account !== "*" && account !== accountId) return null;
  if (match.guildId !== undefined || match.teamId !== undefined) return null;
  if (match.peer) {
    if (match.peer.kind !== peer.kind) return null;
    if (match.peer.id === "*") return "binding.peer.wildcard";
    return String(match.peer.id).toLowerCase() === String(peer.id).toLowerCase() ? "binding.peer" : null;
  }
  return account === "*" ? "binding.channel" : "binding.account";
}

// openclaw@9.8 dist session-key-*.mjs resolveLinkedDirectPeerId (called by buildAgentPeerSessionKey when dmScope is not
// "main", before the peer id is lowercased): the candidates are the lowercased peer id and `${channel}:${peerId}`; the
// first canonical name whose list holds a candidate replaces the peer id.
function linkedDirectPeerId(identityLinks, channel, rawPeerId) {
  if (!identityLinks) return null;
  const peerId = rawPeerId.trim();
  if (!peerId) return null;
  const candidates = new Set([peerId.toLowerCase(), `${String(channel).toLowerCase()}:${peerId}`.toLowerCase()]);
  for (const [canonical, ids] of Object.entries(identityLinks)) {
    const canonicalName = canonical.trim();
    if (!canonicalName || !Array.isArray(ids)) continue;
    for (const id of ids) {
      const normalized = String(id ?? "").trim().toLowerCase();
      if (normalized && candidates.has(normalized)) return canonicalName;
    }
  }
  return null;
}

export function resolveChannelInboundRouteEnvelope({ cfg, channel, accountId, defaultAgentId, peer, dmScope }) {
  let best = null;
  for (const binding of cfg?.bindings ?? []) {
    const tier = tierOf(binding?.match, { channel, accountId, peer });
    if (tier === null) continue;
    // Within a tier the first binding in config order wins.
    if (!best || TIERS.indexOf(tier) < TIERS.indexOf(best.tier)) best = { tier, agentId: binding.agentId };
  }
  const agentId = best?.agentId ?? defaultAgentId;
  const peerId = dmScope === "main" ? String(peer.id) : linkedDirectPeerId(cfg?.session?.identityLinks, channel, String(peer.id)) ?? String(peer.id);
  const sessionKey = dmScope === "per-channel-peer"
    ? `agent:${agentId}:${channel}:direct:${peerId.trim().toLowerCase()}`
    : `agent:${agentId}:main`;
  return { route: { agentId, accountId, channel, dmScope, sessionKey, matchedBy: best?.tier ?? "default" } };
}

// openclaw@8.2 src/channels/inbound-event/context.ts:592 — params are the context, `extra` spread to the root.
export function buildChannelInboundEventContext(params) {
  const { extra, ...rest } = params;
  return { ...rest, ...(extra ?? {}) };
}

// openclaw@8.2 src/channels/inbound-event — builds the envelope body the agent sees.
export function createChannelInboundEnvelopeBuilder() {
  return ({ channel, from, body }) => `[${channel} ${from}] ${body}`;
}
