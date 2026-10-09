import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { createFakeRuntime } from "./support/fake-openclaw.js";
import { createPeerService } from "../src/service.js";
import { resolveLanes } from "../src/lanes.js";
import { modelCalls, modelResults, resolveDefaultModelForAgent } from "./support/openclaw-sdk/agent-runtime.js";

function fixture(t) {
  const state = mkdtempSync(path.join(os.tmpdir(), "oc-lanes-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const file = path.join(state, "sessionbus", "lanes.json");
  const env = { OPENCLAW_STATE_DIR: state };
  modelCalls.length = 0;
  modelResults.clear();
  const sdk = {
    resolveDefaultModelForAgent,
    resolveStateDir(value) {
      assert.equal(value, env);
      return state;
    },
    resolveAgentWorkspaceDir(cfg, id, value) {
      assert.equal(value, env);
      assert.equal(cfg.agents.entries[id] !== undefined, true);
      return path.join(state, "workspace", id);
    },
    async replaceFileAtomic(options) {
      assert.equal(Object.keys(options).includes("filePath"), true);
      assert.equal(options.filePath, file);
      assert.equal(options.mode, 0o600);
      assert.equal(options.dirMode, 0o700);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, options.content, { mode: options.mode });
    },
  };
  const plugin = { lanes: { agents: { lane: { description: "Main lane" } }, credentialDir: "/lane-cli" } };
  const config = { agents: { entries: { lane: {} } }, plugins: { entries: { sessionbus: { config: plugin } } } };
  const runtime = createFakeRuntime({ config });
  const service = () => createPeerService({ runtime }, { lanes: sdk, env, uid: 1000 });
  return { state, file, env, sdk, plugin, config, runtime, service };
}

test("start() logs lane config errors and does not touch the state dir", async (t) => {
  const f = fixture(t);
  f.plugin.lanes = { ...f.plugin.lanes, credentialDir: "relative" };
  const service = f.service();
  await service.start({ logger: f.runtime.logger });
  assert.match(f.runtime.logs.error.flat().join("\n"), /sessionbus config: lanes\.credentialDir/);
  assert.equal(existsSync(f.file), false, "lanes.json is no longer published");
  await service.stop();
});

test("resolveLanes validates operator fields", (t) => {
  const f = fixture(t);
  for (const [edit, reason] of [
    [(p) => { p.lanes.agents = { unknown: {} }; }, /unknown agent id/],
    [(p) => { p.lanes.agents.lane.description = "x".repeat(121); }, /description/],
    [(p) => { p.lanes.agents.lane.description = "two\nlines"; }, /description/],
  ]) {
    const p = structuredClone(f.plugin);
    edit(p);
    const result = resolveLanes(p, f.config, f.env, f.sdk);
    assert.equal(result.settings, null);
    assert.match(result.errors.join("\n"), reason);
  }
});

test("lanes schema accepts the interface and rejects unknown keys", () => {
  const schema = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")).configSchema;
  const valid = { lanes: { agents: { lane: { description: "Main lane" } }, credentialDir: "/lane-cli", auditLog: "/tmp/audit" } };
  assert.equal(Check(schema, valid), true);
  assert.equal(Check(schema, { lanes: { ...valid.lanes, extra: true } }), false);
});

test("astral description limit matches OpenClaw 8.2 TypeBox validation", (t) => {
  const schema = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")).configSchema;
  const good = "😀".repeat(120);
  const bad = "😀".repeat(121);
  assert.equal(Check(schema, { lanes: { agents: { lane: { description: good } }, credentialDir: "/tmp/credentials" } }), true);
  assert.equal(Check(schema, { lanes: { agents: { lane: { description: bad } }, credentialDir: "/tmp/credentials" } }), false);
  const f = fixture(t);
  f.plugin.lanes.agents.lane.description = good;
  assert.deepEqual(resolveLanes(f.plugin, f.config, f.env, f.sdk).errors, []);
  f.plugin.lanes.agents.lane.description = bad;
  assert.match(resolveLanes(f.plugin, f.config, f.env, f.sdk).errors.join(" "), /description/);
});

test("combining-mark description limit matches OpenClaw 8.2 TypeBox validation", (t) => {
  const schema = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")).configSchema;
  const valid = "e\u0301".repeat(120);
  const invalid = "e\u0301".repeat(121);
  const configFor = (description) => ({ lanes: { agents: { lane: { description } }, credentialDir: "/lane-cli" } });
  assert.equal(Check(schema, configFor(valid)), true);
  assert.equal(Check(schema, configFor(invalid)), false);
  const f = fixture(t);
  f.plugin.lanes.agents.lane.description = valid;
  assert.deepEqual(resolveLanes(f.plugin, f.config, f.env, f.sdk).errors, []);
  f.plugin.lanes.agents.lane.description = invalid;
  assert.match(resolveLanes(f.plugin, f.config, f.env, f.sdk).errors.join(" "), /description/);
});


test("lanes settings carry the agent model policy", (t) => {
  const f = fixture(t);
  const resolve = () => {
    const result = resolveLanes(f.plugin, f.config, f.env, f.sdk);
    assert.deepEqual(result.errors, []);
    return result.settings.agents[0].models;
  };
  f.config.agents.defaults = { modelPolicy: { allow: ["default/model"] } };
  f.config.agents.entries.lane.modelPolicy = { allow: [" openrouter/* ", "glm", "", "  ", null, 42, "zai/glm-5.3"] };
  assert.deepEqual(resolve(), { allow: ["openrouter/*", "glm", "zai/glm-5.3"], default: "fake/default" });
  delete f.config.agents.entries.lane.modelPolicy;
  assert.deepEqual(resolve().allow, ["default/model"]);
  f.config.agents.entries.lane.modelPolicy = { allow: [] };
  assert.deepEqual(resolve().allow, []);
  f.config.agents.entries.lane.modelPolicy = { allow: null };
  assert.deepEqual(resolve().allow, [], "agent-owned null allow overrides restrictive defaults");
  f.config.agents.entries.lane.modelPolicy = {};
  assert.deepEqual(resolve().allow, ["default/model"]);
  f.config.agents.defaults = { models: { " legacy/a ": {}, "legacy/b": {}, " ": {} } };
  assert.deepEqual(resolve().allow, ["legacy/a", "legacy/b"]);
  f.config.meta = { migrations: { modelPolicyAllowlist: true } };
  assert.deepEqual(resolve().allow, []);
  delete f.config.meta;
  f.config.agents.defaults.modelPolicy = { allow: null };
  assert.deepEqual(resolve().allow, [], "defaults-owned null allow overrides legacy models");
  f.config.agents.defaults.modelPolicy = {};
  assert.deepEqual(resolve().allow, [], "an explicit defaults policy disables legacy restrictions");
  f.config.agents.defaults.modelPolicy = { allow: [] };
  assert.deepEqual(resolve().allow, []);
  f.config.agents.entries.lane.model = "glm";
  modelCalls.length = 0;
  modelResults.set("lane", { provider: "zai", model: "glm-5.3" });
  assert.deepEqual(resolve(), { allow: [], default: "zai/glm-5.3" });
  assert.equal(modelCalls.length, 1);
  assert.deepEqual(modelCalls[0], { cfg: f.config, agentId: "lane" });
  assert.equal(modelCalls[0].cfg, f.config, "pass the original config object to the SDK");
  modelResults.set("lane", { provider: " zai ", model: " glm-5.3 \t" });
  assert.deepEqual(resolve(), { allow: [], default: "zai/glm-5.3" }, "trim the SDK provider and model before formatting");
});

test("model resolution failure omits models", (t) => {
  const f = fixture(t);
  modelResults.set("lane", new Error("resolver unavailable"));
  const result = resolveLanes(f.plugin, f.config, f.env, f.sdk);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.settings.agents, [{ id: "lane", workspace: path.join(f.state, "workspace", "lane"), description: "Main lane" }]);
  assert.equal(modelCalls.length, 1, "attempt SDK resolution even without an allowlist");
});

test("missing SDK default omits only default", (t) => {
  const f = fixture(t);
  for (const value of [undefined, {}, { provider: "mock" }, { provider: "", model: "a" }, { provider: "mock", model: "" }]) {
    f.sdk.resolveDefaultModelForAgent = () => value;
    const result = resolveLanes(f.plugin, f.config, f.env, f.sdk);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.settings.agents[0].models, { allow: [] });
  }
});

test("a leftover voiceReadiness is an unknown key like any other: the lane settings are refused (#11)", (t) => {
  const f = fixture(t);
  const p = structuredClone(f.plugin);
  p.lanes.voiceReadiness = "lazy";
  const result = resolveLanes(p, f.config, f.env, f.sdk);
  assert.equal(result.settings, null);
  assert.deepEqual(result.errors, ["lanes.voiceReadiness: unknown key"]);
});
