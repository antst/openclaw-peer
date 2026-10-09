import assert from "node:assert/strict";
import test from "node:test";
import { loadPluginEntry } from "./support/openclaw-sdk.js";

// hot-reload: the plugin is also a channel now, so a plugins.entries change hot-applied as a plugin swap would restart
// the channel account and drop the bridge registrations of running lanes (D5/D10); the original motive still holds too.
// hot-reload-hb: on OpenClaw 8.2 a change under plugins.entries.sessionbus is hot-applied as a
// whole-Gateway plugin-generation swap (reload-plugins). Heartbeat wakes that inherited the
// predecessor generation (heartbeat-wake.ts's single timer keeps its requester's async context)
// then fail every run with "prepared model runtime plugin generation was superseded"
// (openclaw-v2026.8.2 src/agents/prepared-model-runtime-lease.ts:99-141) until the Gateway
// process restarts. OpenClaw's own CLI says "Restart the gateway to apply." for any
// plugins.entries change (src/cli/config-cli-runner.ts:224-226), and a plugin opts out of the
// hot path by declaring `reload.restartPrefixes` in its entry (extensions/canvas/index.ts:36-38,
// src/plugins/loader-runtime-candidate.ts:521-524).
//
// The rule table below is the subset of 8.2's planner that can match a plugins.entries path:
// src/gateway/config-reload-plan.ts:150-151 (base), 238-260 (plugin-declared prefixes),
// 175 (tail), sorted longest-prefix-first with first-match semantics (277, 282-289).
function classify(path, entry) {
  const reload = entry.reload ?? {};
  const rules = [
    { prefix: "plugins.load", kind: "restart" },
    { prefix: "plugins.installs", kind: "restart" },
    ...(reload.restartPrefixes ?? []).map((prefix) => ({ prefix, kind: "restart" })),
    ...(reload.hotPrefixes ?? []).map((prefix) => ({ prefix, kind: "hot" })),
    ...(reload.noopPrefixes ?? []).map((prefix) => ({ prefix, kind: "none" })),
    { prefix: "plugins", kind: "hot:reload-plugins" },
  ].sort((a, b) => b.prefix.length - a.prefix.length);
  return rules.find(({ prefix }) => path === prefix || path.startsWith(`${prefix}.`))?.kind ?? "restart";
}

test("hot-reload: a sessionbus config change restarts the Gateway instead of hot-swapping plugin generations", async () => {
  // Active registry: the loaded entry's reload registration is in the planner.
  const entry = await loadPluginEntry();
  for (const path of [
    "plugins.entries.sessionbus.config.lanes",
    "plugins.entries.sessionbus.config.agents.advisor.groups",
    "plugins.entries.sessionbus.enabled",
  ]) {
    assert.equal(classify(path, entry), "restart", `${path} must not take OpenClaw 8.2's hot reload-plugins path`);
  }
});

test("hot-reload: enabling a disabled sessionbus stays on the hot path (README asks for an explicit restart)", () => {
  // Inactive registry: a disabled plugin is never loaded (8.2 loader-registration-plan.ts:50-52), so
  // loader-runtime-candidate.ts:521-524 registers no reload rules for it and the planner falls to
  // the generic plugins rule. The plugin cannot close this gap; README "Applying config changes"
  // documents the manual restart.
  assert.equal(classify("plugins.entries.sessionbus.enabled", {}), "hot:reload-plugins");
});
