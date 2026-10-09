import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../src/config.js";

const openclawConfig = { agents: { entries: { advisor: {}, other: { identity: { name: "Advisor Bot" } } } } };

test("defaults: disabled agent produces no binding and no error", () => {
  const result = resolveConfig({ agents: { advisor: {} } }, openclawConfig, {}, 1000);
  assert.deepEqual(result.bindings, []);
  assert.deepEqual(result.errors, []);
});

test("defaults: enabled agent without sessionKey gets agent:<id>:main", () => {
  const result = resolveConfig({ agents: { advisor: { enabled: true, groups: ["g"] } } }, openclawConfig, {}, 1000);
  assert.equal(result.errors.length, 0);
  assert.equal(result.bindings[0].sessionKey, "agent:advisor:main");
  assert.deepEqual(Object.keys(result.bindings[0]), ["agentId", "sessionKey", "groups", "busSessionBinding"]);
  assert.equal(result.bindings[0].busSessionBinding, "name");
});

test("explicit non-main sessionKey is accepted", () => {
  const result = resolveConfig(
    { agents: { advisor: { enabled: true, groups: ["g"], sessionKey: "agent:advisor:telegram:direct:123456789" } } },
    openclawConfig,
    {},
    1000,
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.bindings[0].sessionKey, "agent:advisor:telegram:direct:123456789");
});

test("sessionKey with uppercase is rejected", () => {
  const result = resolveConfig(
    { agents: { advisor: { enabled: true, groups: ["g"], sessionKey: "agent:advisor:slack:channel:C0ABC123" } } },
    openclawConfig,
    {},
    1000,
  );
  assert.deepEqual(result.bindings, []);
  assert.deepEqual(result.errors, ["agents.advisor.sessionKey: must be lowercase, as OpenClaw lists it"]);
});

test("disabled agent ignores sessionKey shape", () => {
  const result = resolveConfig({ agents: { advisor: { enabled: false, sessionKey: "agent:other:BAD" } } }, { agents: { entries: { advisor: {} } } });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.bindings, []);
});

test("enabled without groups: error and excluded", () => {
  const result = resolveConfig({ agents: { advisor: { enabled: true } } }, openclawConfig, {}, 1000);
  assert.deepEqual(result.bindings, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /groups/);
});

test("unknown agentId: error", () => {
  const result = resolveConfig({ agents: { ghost: { enabled: true, groups: ["g"] } } }, openclawConfig, {}, 1000);
  assert.deepEqual(result.bindings, []);
  assert.match(result.errors[0], /unknown agent id/);
});

test("cross-agent sessionKey: error", () => {
  const result = resolveConfig(
    { agents: { advisor: { enabled: true, groups: ["g"], sessionKey: "agent:other:main" } } },
    openclawConfig,
    {},
    1000,
  );
  assert.deepEqual(result.bindings, []);
  assert.match(result.errors[0], /sessionKey/);
});

test("name precedence: config name wins, then agent identity name, then omitted", () => {
  const withConfigName = resolveConfig(
    { agents: { other: { enabled: true, groups: ["g"], name: "Explicit" } } },
    openclawConfig,
    {},
    1000,
  );
  assert.equal(withConfigName.bindings[0].name, "Explicit");

  const withIdentityName = resolveConfig({ agents: { other: { enabled: true, groups: ["g"] } } }, openclawConfig, {}, 1000);
  assert.equal(withIdentityName.bindings[0].name, "Advisor Bot");

  const omitted = resolveConfig({ agents: { advisor: { enabled: true, groups: ["g"] } } }, openclawConfig, {}, 1000);
  assert.equal(Object.hasOwn(omitted.bindings[0], "name"), false);
});

test("name over the wire limit: error quoting the field, excluded", () => {
  const longName = "a".repeat(129);
  const result = resolveConfig(
    { agents: { advisor: { enabled: true, groups: ["g"], name: longName } } },
    openclawConfig,
    {},
    1000,
  );
  assert.deepEqual(result.bindings, []);
  assert.match(result.errors[0], /name/);
});

test("name with a control character: error quoting the field, excluded", () => {
  const result = resolveConfig(
    { agents: { advisor: { enabled: true, groups: ["g"], name: "bad\u0007name" } } },
    openclawConfig,
    {},
    1000,
  );
  assert.deepEqual(result.bindings, []);
  assert.match(result.errors[0], /name/);
});

test("socket precedence: config socket wins", () => {
  const result = resolveConfig({ socket: "/configured.sock" }, openclawConfig, { SESSIONBUS_SOCKET: "/env.sock" }, 1000);
  assert.equal(result.socket, "/configured.sock");
});

test("relative config socket is reported and falls back to unset resolution", () => {
  const result = resolveConfig({ socket: "relative.sock" }, openclawConfig, { SESSIONBUS_SOCKET: "/env.sock" }, 1000);
  assert.deepEqual(result.errors, ["socket: absolute path required"]);
  assert.equal(result.socket, "/env.sock");
});

test("socket precedence: env SESSIONBUS_SOCKET next", () => {
  const result = resolveConfig({}, openclawConfig, { SESSIONBUS_SOCKET: "/env.sock", XDG_RUNTIME_DIR: "/run/user/1000" }, 1000);
  assert.equal(result.socket, "/env.sock");
});

test("socket precedence: XDG_RUNTIME_DIR next", () => {
  const result = resolveConfig({}, openclawConfig, { XDG_RUNTIME_DIR: "/run/user/1000" }, 1000);
  assert.equal(result.socket, "/run/user/1000/sessionbus/presence.sock");
});

test("socket precedence: /tmp fallback with uid", () => {
  const result = resolveConfig({}, openclawConfig, {}, 1000);
  assert.equal(result.socket, "/tmp/sessionbus-1000/presence.sock");
});

test("busSessionBinding: default, root, per-agent override, invalid", () => {
  const enabled = { enabled: true, groups: ["g"] };
  const byDefault = resolveConfig({ agents: { advisor: enabled } }, openclawConfig, {}, 1000);
  assert.deepEqual(byDefault.errors, []);
  assert.equal(byDefault.bindings[0].busSessionBinding, "name");

  const root = resolveConfig({ busSessionBinding: "singleton", agents: { advisor: enabled } }, openclawConfig, {}, 1000);
  assert.deepEqual(root.errors, []);
  assert.equal(root.bindings[0].busSessionBinding, "singleton");

  const override = resolveConfig(
    { busSessionBinding: "singleton", agents: { advisor: { ...enabled, busSessionBinding: "sessionId" } } },
    openclawConfig,
    {},
    1000,
  );
  assert.deepEqual(override.errors, []);
  assert.equal(override.bindings[0].busSessionBinding, "sessionId");

  const badRoot = resolveConfig(
    { busSessionBinding: "bogus", agents: { advisor: enabled, other: { ...enabled, busSessionBinding: "name" } } },
    openclawConfig,
    {},
    1000,
  );
  assert.deepEqual(badRoot.errors, ["busSessionBinding: must be one of name, sessionId, singleton"]);
  assert.deepEqual(badRoot.bindings, []);

  const badAgent = resolveConfig(
    { agents: { advisor: { ...enabled, busSessionBinding: "Name" }, other: { ...enabled, busSessionBinding: "singleton" } } },
    openclawConfig,
    {},
    1000,
  );
  assert.deepEqual(badAgent.errors, ["agents.advisor.busSessionBinding: must be one of name, sessionId, singleton"]);
  assert.deepEqual(
    badAgent.bindings.map((binding) => [binding.agentId, binding.busSessionBinding]),
    [["other", "singleton"]],
  );
});
