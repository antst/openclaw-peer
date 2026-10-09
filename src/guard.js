const PAIR_KEY_SEPARATOR = "\u0000";

/**
 * Sliding-window pair loop guard mirroring OpenClaw's
 * `channels.defaults.botLoopProtection` (docs/channels/bot-loop-protection.md).
 * One budget per (localId, counterpartId) pair, shared across both
 * directions since both send through the same two methods with the same
 * argument order.
 */
export class PairGuard {
  constructor({ maxEventsPerWindow = 20, windowSeconds = 60, cooldownSeconds = 60, enabled = true, now = Date.now } = {}) {
    this.maxEventsPerWindow = maxEventsPerWindow;
    this.windowMs = windowSeconds * 1000;
    this.cooldownMs = cooldownSeconds * 1000;
    this.enabled = enabled;
    this.now = now;
    this.pairs = new Map();
  }

  static fromConfig(openclawConfig) {
    const cfg = openclawConfig?.channels?.defaults?.botLoopProtection ?? {};
    return new PairGuard({
      maxEventsPerWindow: cfg.maxEventsPerWindow ?? 20,
      windowSeconds: cfg.windowSeconds ?? 60,
      cooldownSeconds: cfg.cooldownSeconds ?? 60,
      enabled: cfg.enabled ?? true,
    });
  }

  /** Pure check: does not count as an event. */
  blocked(localId, counterpartId) {
    if (!this.enabled) return false;
    const entry = this.pairs.get(pairKey(localId, counterpartId));
    if (!entry || entry.cooldownUntil == null) return false;
    return this.now() < entry.cooldownUntil;
  }

  /** Counts one event; false when this event exceeded the budget and started (or is within) a cooldown. */
  record(localId, counterpartId) {
    if (!this.enabled) return true;
    const now = this.now();
    this.#prune(now);
    const key = pairKey(localId, counterpartId);
    const entry = this.pairs.get(key) ?? { events: [], cooldownUntil: null, lastActivity: now };
    this.pairs.set(key, entry);
    if (entry.cooldownUntil != null) {
      if (now < entry.cooldownUntil) {
        entry.lastActivity = now;
        return false;
      }
      entry.cooldownUntil = null;
      entry.events = [];
    }
    entry.events = entry.events.filter((ts) => ts > now - this.windowMs);
    entry.events.push(now);
    entry.lastActivity = now;
    if (entry.events.length > this.maxEventsPerWindow) {
      entry.cooldownUntil = now + this.cooldownMs;
      return false;
    }
    return true;
  }

  /** Inbound admission: `!blocked && record`. */
  admit(localId, counterpartId) {
    return !this.blocked(localId, counterpartId) && this.record(localId, counterpartId);
  }

  /**
   * Pure check: would the *next* `record()` for this pair be refused —
   * either an active cooldown, or a window count that would tip over the
   * budget? Unlike `blocked()`, this also catches the event that would be
   * the one to exceed the budget, not just ones after a cooldown already
   * started.
   */
  wouldExceed(localId, counterpartId) {
    if (!this.enabled) return false;
    const now = this.now();
    const entry = this.pairs.get(pairKey(localId, counterpartId));
    if (!entry) return false;
    if (entry.cooldownUntil != null) return now < entry.cooldownUntil;
    const activeEvents = entry.events.filter((ts) => ts > now - this.windowMs).length;
    return activeEvents + 1 > this.maxEventsPerWindow;
  }

  #prune(now) {
    const idleLimit = this.windowMs + this.cooldownMs;
    for (const [key, entry] of this.pairs) {
      const stillCoolingDown = entry.cooldownUntil != null && now < entry.cooldownUntil;
      if (!stillCoolingDown && now - entry.lastActivity > idleLimit) this.pairs.delete(key);
    }
  }
}

function pairKey(localId, counterpartId) {
  return `${localId}${PAIR_KEY_SEPARATOR}${counterpartId}`;
}
