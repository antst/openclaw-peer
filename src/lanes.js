import path from "node:path";

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIELDS = new Set(["agents", "credentialDir", "auditLog"]);
const descriptionSegments = new Intl.Segmenter("en", { granularity: "grapheme" });

function descriptionLength(value) {
  let count = 0;
  for (const _ of descriptionSegments.segment(value)) count++;
  return count;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function agentModelPolicy(cfg, id, sdk) {
  try {
    // OpenClaw 8.2 src/agents/model-selection-shared.ts:1482-1518 and
    // src/config/model-policy-allowlist-migration.ts:6-50; source selection is
    // identical in 9.5/9.6/9.7 (RESEARCH.md Q2). Keep aliases and wildcards as written.
    const agentPolicy = cfg?.agents?.entries?.[id]?.modelPolicy;
    const defaults = cfg?.agents?.defaults;
    const defaultPolicy = defaults?.modelPolicy;
    let refs = [];
    if (isRecord(agentPolicy) && Object.hasOwn(agentPolicy, "allow")) {
      refs = agentPolicy.allow ?? [];
    } else if (isRecord(defaultPolicy) && Object.hasOwn(defaultPolicy, "allow")) {
      refs = defaultPolicy.allow ?? [];
    } else if (cfg?.meta?.migrations?.modelPolicyAllowlist !== true &&
               !isRecord(defaultPolicy) && isRecord(defaults?.models)) {
      refs = Object.keys(defaults.models);
    }
    const allow = refs.filter((ref) => typeof ref === "string").map((ref) => ref.trim()).filter(Boolean);
    const resolved = sdk.resolveDefaultModelForAgent({ cfg, agentId: id });
    const provider = resolved?.provider;
    const model = resolved?.model;
    return {
      allow,
      ...(typeof provider === "string" && provider.trim() && typeof model === "string" && model.trim()
        ? { default: `${provider.trim()}/${model.trim()}` } : {}),
    };
  } catch {
    // Model display is optional; a resolver failure must never block a lane.
    return undefined;
  }
}

export function resolveLanes(pluginConfig, openclawConfig, env, sdk) {
  const errors = [];
  const raw = pluginConfig?.lanes;
  // No lanes block is a plan-A-only install: nothing to publish, nothing to report.
  if (raw === undefined) return { settings: null, errors };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("lanes: object required");
    return { settings: null, errors };
  }
  for (const key of Object.keys(raw)) if (!FIELDS.has(key)) errors.push(`lanes.${key}: unknown key`);
  const agents = [];
  if (!raw.agents || typeof raw.agents !== "object" || Array.isArray(raw.agents) || Object.keys(raw.agents).length === 0) {
    errors.push("lanes.agents: non-empty object required");
  } else {
    for (const [id, value] of Object.entries(raw.agents)) {
      if (!ID.test(id)) errors.push(`lanes.agents.${id}: invalid agent id`);
      if (!Object.hasOwn(openclawConfig?.agents?.entries ?? {}, id)) errors.push(`lanes.agents.${id}: unknown agent id`);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`lanes.agents.${id}: object required`);
        continue;
      }
      for (const key of Object.keys(value)) if (key !== "description") errors.push(`lanes.agents.${id}.${key}: unknown key`);
      const description = value.description;
      // OpenClaw 8.2 src/plugins/schema-validator.ts:107,421 compiles with
      // TypeBox 1.3.17; node_modules/typebox/build/guard/string.mjs:165-176
      // counts grapheme clusters for maxLength.
      if (description !== undefined && (typeof description !== "string" || descriptionLength(description) > 120 || /[\r\n]/.test(description))) {
        errors.push(`lanes.agents.${id}.description: one line of at most 120 characters required`);
      }
      if (ID.test(id) && Object.hasOwn(openclawConfig?.agents?.entries ?? {}, id)) {
        try {
          const workspace = sdk.resolveAgentWorkspaceDir(openclawConfig, id, env);
          if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("absolute workspace required");
          const models = agentModelPolicy(openclawConfig, id, sdk);
          agents.push({ id, workspace: path.resolve(workspace), ...(description !== undefined ? { description } : {}),
            ...(models !== undefined ? { models } : {}) });
        } catch (error) {
          errors.push(`lanes.agents.${id}.workspace: ${error?.message ?? error}`);
        }
      }
    }
  }
  if (typeof raw.credentialDir !== "string" || !path.isAbsolute(raw.credentialDir)) errors.push("lanes.credentialDir: absolute path required");
  if (raw.auditLog !== undefined && (typeof raw.auditLog !== "string" || !path.isAbsolute(raw.auditLog))) errors.push("lanes.auditLog: absolute path required");
  if (errors.length) return { settings: null, errors };
  return { settings: {
    agents,
    credentialDir: path.resolve(raw.credentialDir),
    ...(raw.auditLog !== undefined ? { auditLog: path.resolve(raw.auditLog) } : {}),
  }, errors: [] };
}
