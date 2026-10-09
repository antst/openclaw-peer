// unit coverage for lane/pair-device.mjs's pure parts. No live Gateway
// here — the fake GatewayClient below stands in for it; the real connect is proven by
// `run.sh provision_credential` (live docker, master/owner clause).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertDedicatedLaneStateDir,
  loadGatewayClient,
  loadGatewayTarget,
  loadStateDirResolver,
  main,
  pairDevice,
  readGatewayToken,
  REQUESTED_SCOPES,
  resolveDefaultOpenClawStateDir,
  resolveGatewayUrl,
  resolveInstallDir,
  scopeSetsEqual,
} from "../lane/pair-device.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "example-gateway-token-0123456789abcdef";

// A stand-in for GatewayClient that records its constructor options and lets a test drive one of
// the three terminal callbacks (hello-ok / connect error / close) on demand.
class FakeGatewayClient {
  constructor(opts) {
    this.opts = opts;
    this.started = false;
    this.stopped = false;
    FakeGatewayClient.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  async stopAndWait() {
    this.stopped = true;
  }
}
FakeGatewayClient.instances = [];

test.beforeEach(() => {
  FakeGatewayClient.instances.length = 0;
});

// A hello that looks like a freshly minted device token (deviceToken present,
// issuedAtMs after the given start time). Real fields per connect-hello.ts:160-169.
function freshHelloAuth(scopes, { startedAtMs = Date.now(), deviceToken = "example-device-token" } = {}) {
  return { auth: { scopes, deviceToken, issuedAtMs: startedAtMs + 1000 } };
}

test("scopeSetsEqual: same members, different order and duplicates, still equal", () => {
  assert.equal(scopeSetsEqual(["a", "b", "c"], ["c", "a", "b"]), true);
  assert.equal(scopeSetsEqual(["a", "a", "b"], ["b", "a"]), true);
});

test("scopeSetsEqual: extra or missing scope is not equal", () => {
  assert.equal(scopeSetsEqual(["a", "b"], ["a", "b", "c"]), false);
  assert.equal(scopeSetsEqual(["a", "b", "c"], ["a", "b"]), false);
  assert.equal(scopeSetsEqual(["operator.admin"], REQUESTED_SCOPES), false);
});

test("scopeSetsEqual: non-array inputs are never equal", () => {
  assert.equal(scopeSetsEqual(undefined, ["a"]), false);
  assert.equal(scopeSetsEqual(["a"], null), false);
});

test("readGatewayToken: reads OPENCLAW_GATEWAY_TOKEN from env only", () => {
  assert.equal(readGatewayToken({ OPENCLAW_GATEWAY_TOKEN: TOKEN }), TOKEN);
});

test("readGatewayToken: missing or blank token throws, naming the env var", () => {
  assert.throws(() => readGatewayToken({}), /OPENCLAW_GATEWAY_TOKEN/);
  assert.throws(() => readGatewayToken({ OPENCLAW_GATEWAY_TOKEN: "   " }), /OPENCLAW_GATEWAY_TOKEN/);
});

test("resolveInstallDir: an explicit OPENCLAW_INSTALL_DIR with a package.json wins over PATH", () => {
  const deps = {
    existsSync: (p) => p === "/opt/openclaw/package.json",
    realpathSync: () => {
      throw new Error("must not consult PATH when OPENCLAW_INSTALL_DIR is set");
    },
    which: () => {
      throw new Error("must not consult PATH when OPENCLAW_INSTALL_DIR is set");
    },
  };
  assert.equal(resolveInstallDir({ OPENCLAW_INSTALL_DIR: "/opt/openclaw" }, deps), "/opt/openclaw");
});

test("resolveInstallDir: an OPENCLAW_INSTALL_DIR without a package.json is rejected, not silently accepted", () => {
  const deps = { existsSync: () => false, realpathSync: () => "", which: () => "" };
  assert.throws(
    () => resolveInstallDir({ OPENCLAW_INSTALL_DIR: "/nope" }, deps),
    /package\.json/,
  );
});

test("resolveInstallDir: with no override, resolves the openclaw binary on PATH and takes its dirname", () => {
  const deps = {
    existsSync: () => false,
    which: (bin) => {
      assert.equal(bin, "openclaw");
      return "/usr/local/bin/openclaw";
    },
    realpathSync: (p) => {
      assert.equal(p, "/usr/local/bin/openclaw");
      return "/app/openclaw.mjs";
    },
  };
  assert.equal(resolveInstallDir({}, deps), "/app");
});

test("resolveInstallDir: no override and no PATH match throws naming both escape hatches", () => {
  const deps = {
    existsSync: () => false,
    which: () => {
      throw new Error("command not found");
    },
    realpathSync: () => "",
  };
  assert.throws(() => resolveInstallDir({}, deps), /OPENCLAW_INSTALL_DIR/);
});

test("resolveDefaultOpenClawStateDir: OPENCLAW_HOME wins over the OS home dir", () => {
  const deps = { homedir: () => "/home/os-default" };
  assert.equal(resolveDefaultOpenClawStateDir({ OPENCLAW_HOME: "/home/openclaw" }, deps), "/home/openclaw/.openclaw");
});

test("resolveDefaultOpenClawStateDir: falls back to the OS home dir with no OPENCLAW_HOME", () => {
  const deps = { homedir: () => "/home/openclaw" };
  assert.equal(resolveDefaultOpenClawStateDir({}, deps), "/home/openclaw/.openclaw");
});

test("assertDedicatedLaneStateDir: OPENCLAW_STATE_DIR unset is refused", () => {
  const deps = { existsSync: () => false, homedir: () => "/home/openclaw" };
  assert.throws(() => assertDedicatedLaneStateDir({}, deps), /OPENCLAW_STATE_DIR is required/);
});

test("assertDedicatedLaneStateDir: the daemon's own default state dir is refused, not just a blank value", () => {
  const deps = { existsSync: () => false, homedir: () => "/home/openclaw" };
  assert.throws(
    () => assertDedicatedLaneStateDir({ OPENCLAW_STATE_DIR: "/home/openclaw/.openclaw" }, deps),
    /default OpenClaw state dir/,
  );
  // Same directory, spelled with a trailing slash — must still be caught.
  assert.throws(
    () => assertDedicatedLaneStateDir({ OPENCLAW_STATE_DIR: "/home/openclaw/.openclaw/" }, deps),
    /default OpenClaw state dir/,
  );
});

test("assertDedicatedLaneStateDir: a dedicated dir that already holds a device identity is refused", () => {
  const deps = {
    existsSync: (p) => p === "/lane-cli/state/openclaw.sqlite",
    homedir: () => "/home/openclaw",
  };
  assert.throws(
    () => assertDedicatedLaneStateDir({ OPENCLAW_STATE_DIR: "/lane-cli" }, deps),
    /already holds a device identity/,
  );
});

test("assertDedicatedLaneStateDir: a fresh, dedicated dir passes", () => {
  const deps = { existsSync: () => false, homedir: () => "/home/openclaw" };
  assert.doesNotThrow(() => assertDedicatedLaneStateDir({ OPENCLAW_STATE_DIR: "/lane-cli" }, deps));
});

test("assertDedicatedLaneStateDir: a leading ~ is refused, not silently compared unexpanded", () => {
  // path.resolve("~/.openclaw") stays "<cwd>/~/.openclaw" — it never equals the real default dir,
  // so without this check a "~"-spelled value (quoted in a shell, or from a systemd
  // Environment= line) would sail past the default-dir comparison and OpenClaw itself would then
  // expand it straight into the real default state dir.
  const deps = { existsSync: () => false, homedir: () => "/home/openclaw" };
  assert.throws(
    () => assertDedicatedLaneStateDir({ OPENCLAW_STATE_DIR: "~/.openclaw" }, deps),
    /must be an absolute path/,
  );
  assert.throws(() => assertDedicatedLaneStateDir({ OPENCLAW_STATE_DIR: "~" }, deps), /must be an absolute path/);
});

test("assertDedicatedLaneStateDir: a relative path is refused the same way", () => {
  const deps = { existsSync: () => false, homedir: () => "/home/openclaw" };
  assert.throws(
    () => assertDedicatedLaneStateDir({ OPENCLAW_STATE_DIR: "lane-cli" }, deps),
    /must be an absolute path/,
  );
});

test("resolveDefaultOpenClawStateDir: prefers the install's own resolveStateDir when given", () => {
  let seenEnv;
  const deps = {
    homedir: () => {
      throw new Error("must not fall back to homedir when deps.resolveStateDir is provided");
    },
    resolveStateDir(env) {
      seenEnv = env;
      return "/installs/own/answer/.openclaw";
    },
  };
  const result = resolveDefaultOpenClawStateDir({ OPENCLAW_STATE_DIR: "/lane-cli", OPENCLAW_HOME: "/home/openclaw" }, deps);
  assert.equal(result, "/installs/own/answer/.openclaw");
  // Clearing OPENCLAW_STATE_DIR before delegating is what makes the call mean "the default",
  // not "whatever override we're currently checking".
  assert.equal(seenEnv.OPENCLAW_STATE_DIR, "");
  assert.equal(seenEnv.OPENCLAW_HOME, "/home/openclaw");
});

test("loadStateDirResolver: resolves openclaw/plugin-sdk/state-paths's resolveStateDir", async () => {
  const createRequireImpl = () => ({ resolve: () => "/app/dist/plugin-sdk/state-paths.js" });
  const importImpl = async (url) => {
    assert.equal(url, "file:///app/dist/plugin-sdk/state-paths.js");
    return { resolveStateDir: (env) => `/from-install/${env.OPENCLAW_HOME ?? ""}` };
  };
  const fn = await loadStateDirResolver("/app", { createRequireImpl, importImpl });
  assert.equal(typeof fn, "function");
  assert.equal(fn({ OPENCLAW_HOME: "x" }), "/from-install/x");
});

test("loadStateDirResolver: returns undefined instead of throwing when the install can't provide it", async () => {
  const createRequireImpl = () => ({
    resolve: () => {
      throw new Error("MODULE_NOT_FOUND");
    },
  });
  const fn = await loadStateDirResolver("/app", { createRequireImpl, importImpl: async () => ({}) });
  assert.equal(fn, undefined);
});

test("loadGatewayClient: resolves the plugin-sdk export from a referrer inside the given install", async () => {
  let seenReferrerUrl;
  const createRequireImpl = (url) => {
    seenReferrerUrl = url;
    return {
      resolve(specifier) {
        assert.equal(specifier, "openclaw/plugin-sdk/gateway-runtime");
        return "/app/dist/plugin-sdk/gateway-runtime.js";
      },
    };
  };
  const importImpl = async (url) => {
    assert.equal(url, "file:///app/dist/plugin-sdk/gateway-runtime.js");
    return { GatewayClient: FakeGatewayClient };
  };
  const Client = await loadGatewayClient("/app", { createRequireImpl, importImpl });
  assert.equal(Client, FakeGatewayClient);
  assert.equal(seenReferrerUrl, "file:///app/package.json");
});

test("loadGatewayClient: throws if the resolved module has no GatewayClient export", async () => {
  const createRequireImpl = () => ({ resolve: () => "/app/dist/plugin-sdk/gateway-runtime.js" });
  const importImpl = async () => ({});
  await assert.rejects(
    loadGatewayClient("/app", { createRequireImpl, importImpl }),
    /GatewayClient/,
  );
});

test("loadGatewayTarget: resolves resolveGatewayPort/readConfigFileSnapshot from the given install", async () => {
  const seen = [];
  const createRequireImpl = () => ({
    resolve(specifier) {
      seen.push(specifier);
      return `/app/dist/plugin-sdk/${specifier.split("/").pop()}.js`;
    },
  });
  const importImpl = async (url) => {
    if (url.endsWith("core.js")) return { resolveGatewayPort: () => 18789 };
    if (url.endsWith("health.js")) return { readConfigFileSnapshot: async () => ({ runtimeConfig: {} }) };
    throw new Error(`unexpected import ${url}`);
  };
  const target = await loadGatewayTarget("/app", { createRequireImpl, importImpl });
  assert.equal(typeof target.resolveGatewayPort, "function");
  assert.equal(typeof target.readConfigFileSnapshot, "function");
  assert.deepEqual(seen.sort(), ["openclaw/plugin-sdk/core", "openclaw/plugin-sdk/health"].sort());
});

test("resolveGatewayUrl: builds ws://127.0.0.1:<configured port>, never a hardcoded default", async () => {
  const createRequireImpl = () => ({
    resolve: (specifier) => `/app/dist/plugin-sdk/${specifier.split("/").pop()}.js`,
  });
  const importImpl = async (url) => {
    if (url.endsWith("core.js")) {
      return {
        resolveGatewayPort(cfg, env) {
          assert.deepEqual(cfg, { gateway: { mode: "local", port: 18792 } });
          assert.equal(env, process.env);
          return 18792;
        },
      };
    }
    return { readConfigFileSnapshot: async () => ({ exists: true, valid: true, runtimeConfig: { gateway: { mode: "local", port: 18792 } } }) };
  };
  const url = await resolveGatewayUrl("/app", process.env, { createRequireImpl, importImpl });
  assert.equal(url, "ws://127.0.0.1:18792");
});

test("resolveGatewayUrl: never scans — refuses gateway.mode=remote instead of guessing a port", async () => {
  // The fake resolveGatewayPort used to throw its own "remote-mode config" error, which
  // also matched /remote/ — so deleting the real gateway.mode==="remote" guard left this green
  // (the fake's own throw satisfied the assertion instead of the guard). The fake now resolves a
  // real port, so a deleted guard would make the call *succeed*, which assert.rejects then catches.
  const createRequireImpl = () => ({
    resolve: (specifier) => `/app/dist/plugin-sdk/${specifier.split("/").pop()}.js`,
  });
  const importImpl = async (url) => {
    if (url.endsWith("core.js")) {
      return { resolveGatewayPort: () => 18789 };
    }
    return { readConfigFileSnapshot: async () => ({ exists: true, valid: true, runtimeConfig: { gateway: { mode: "remote", remote: { url: "wss://elsewhere" } } } }) };
  };
  await assert.rejects(
    resolveGatewayUrl("/app", process.env, { createRequireImpl, importImpl }),
    /pair-device\.mjs only supports local-mode/,
  );
});

test("resolveGatewayUrl: refuses instead of falling through to a default port when the config is invalid", async () => {
  const createRequireImpl = () => ({
    resolve: (specifier) => `/app/dist/plugin-sdk/${specifier.split("/").pop()}.js`,
  });
  const importImpl = async (url) => {
    if (url.endsWith("core.js")) {
      return {
        resolveGatewayPort: () => {
          throw new Error("must not resolve a port for an invalid config snapshot");
        },
      };
    }
    return {
      readConfigFileSnapshot: async () => ({
        path: "/lane-cli/openclaw.json",
        exists: true,
        valid: false,
        readError: { code: "EJSONPARSE" },
        runtimeConfig: {},
      }),
    };
  };
  await assert.rejects(
    resolveGatewayUrl("/app", process.env, { createRequireImpl, importImpl }),
    /\/lane-cli\/openclaw\.json.*invalid or unreadable/,
  );
});

test("resolveGatewayUrl: a missing targeted config is refused", async () => {
  const createRequireImpl = () => ({
    resolve: (specifier) => `/app/dist/plugin-sdk/${specifier.split("/").pop()}.js`,
  });
  const importImpl = async (url) => {
    if (url.endsWith("core.js")) {
      return { resolveGatewayPort: () => 18789 };
    }
    return { readConfigFileSnapshot: async () => ({ path: "/lane-cli/openclaw.json", exists: false, valid: false, runtimeConfig: {} }) };
  };
  await assert.rejects(
    resolveGatewayUrl("/app", process.env, { createRequireImpl, importImpl }),
    /\/lane-cli\/openclaw\.json.*does not exist/,
  );
});

test("pairDevice: requests exactly the three scopes, client mode/id cli, a configured url, resolves on a freshly minted hello-ok", async () => {
  const before = Date.now();
  const promise = pairDevice({
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN },
    GatewayClient: FakeGatewayClient,
    url: "ws://127.0.0.1:18792",
  });
  const client = FakeGatewayClient.instances[0];
  assert.deepEqual([...client.opts.scopes].sort(), [...REQUESTED_SCOPES].sort());
  assert.equal(client.opts.mode, "cli");
  assert.equal(client.opts.clientName, "cli");
  assert.equal(client.opts.token, TOKEN);
  assert.equal(client.opts.url, "ws://127.0.0.1:18792");
  assert.equal(client.started, true);
  client.opts.onHelloOk(freshHelloAuth([...REQUESTED_SCOPES], { startedAtMs: before }));
  const result = await promise;
  assert.deepEqual([...result.granted].sort(), [...REQUESTED_SCOPES].sort());
});

test("pairDevice: literally the three scopes and nothing else — a mutation adding admin must fail", async () => {
  const before = Date.now();
  const promise = pairDevice({ env: { OPENCLAW_GATEWAY_TOKEN: TOKEN }, GatewayClient: FakeGatewayClient });
  const client = FakeGatewayClient.instances[0];
  assert.deepEqual([...client.opts.scopes].sort(), ["operator.approvals", "operator.read", "operator.write"]);
  client.opts.onHelloOk(freshHelloAuth(["operator.approvals", "operator.read", "operator.write"], { startedAtMs: before }));
  const result = await promise;
  assert.deepEqual([...result.granted].sort(), ["operator.approvals", "operator.read", "operator.write"]);
});

test("pairDevice: rejects, does not rotate or retry, when granted scopes differ from requested", async () => {
  const before = Date.now();
  const promise = pairDevice({
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN },
    GatewayClient: FakeGatewayClient,
  });
  const client = FakeGatewayClient.instances[0];
  client.opts.onHelloOk(
    freshHelloAuth(["operator.admin", "operator.read", "operator.write"], { startedAtMs: before }),
  );
  await assert.rejects(promise, /granted scopes .* differ from requested/);
});

test("pairDevice: rejects when hello carries no device token at all", async () => {
  const promise = pairDevice({ env: { OPENCLAW_GATEWAY_TOKEN: TOKEN }, GatewayClient: FakeGatewayClient });
  const client = FakeGatewayClient.instances[0];
  client.opts.onHelloOk({ auth: { scopes: [...REQUESTED_SCOPES] } });
  await assert.rejects(promise, /no device token/);
});

test("pairDevice: rejects a reused admin token that merely reports the requested scopes back", async () => {
  const promise = pairDevice({ env: { OPENCLAW_GATEWAY_TOKEN: TOKEN }, GatewayClient: FakeGatewayClient });
  const client = FakeGatewayClient.instances[0];
  // A device paired long ago as admin: ensureDeviceToken hands back the existing token unchanged,
  // whatever this connect asked for — its issuedAtMs predates this run by a long way.
  client.opts.onHelloOk({
    auth: { scopes: [...REQUESTED_SCOPES], deviceToken: "example-old-admin-token", issuedAtMs: Date.now() - 3_600_000 },
  });
  await assert.rejects(promise, /not issued by this connection/);
});

test("pairDevice: a token issued exactly at the connection start still counts as fresh (>=, not >)", async () => {
  const fixedNow = 1_700_000_000_000;
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  let promise;
  try {
    promise = pairDevice({ env: { OPENCLAW_GATEWAY_TOKEN: TOKEN }, GatewayClient: FakeGatewayClient });
  } finally {
    Date.now = originalNow;
  }
  const client = FakeGatewayClient.instances[0];
  client.opts.onHelloOk({ auth: { scopes: [...REQUESTED_SCOPES], deviceToken: "dt", issuedAtMs: fixedNow } });
  const result = await promise;
  assert.deepEqual([...result.granted].sort(), [...REQUESTED_SCOPES].sort());
});

test("pairDevice: rejects on a connect error and stops the client (no reconnect loop left running)", async () => {
  const promise = pairDevice({
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN },
    GatewayClient: FakeGatewayClient,
  });
  const client = FakeGatewayClient.instances[0];
  client.opts.onConnectError(new Error("gateway_credentials_required"));
  await assert.rejects(promise, /gateway_credentials_required/);
  assert.equal(client.stopped, true);
});

test("pairDevice: a pending-pairing close before hello-ok rejects and stops the client", async () => {
  const promise = pairDevice({
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN },
    GatewayClient: FakeGatewayClient,
  });
  const client = FakeGatewayClient.instances[0];
  client.opts.onClose(1008, "pairing pending approval");
  await assert.rejects(promise, /closed before pairing completed/);
  assert.equal(client.stopped, true);
});

test("pairDevice: a constructor that throws synchronously rejects without a delayed crash", async () => {
  class ThrowingGatewayClient {
    constructor() {
      throw new Error("boom");
    }
  }
  await assert.rejects(
    pairDevice({ env: { OPENCLAW_GATEWAY_TOKEN: TOKEN }, GatewayClient: ThrowingGatewayClient, timeoutMs: 20 }),
    /boom/,
  );
  // Before the fix, the watchdog (still armed) fires ~20ms later and calls `.stop()` on the
  // never-assigned `client` binding — an uncaught ReferenceError inside a bare setTimeout callback,
  // which aborts the whole test process rather than just this test.
  await new Promise((resolve) => setTimeout(resolve, 60));
});

test("pairDevice: times out rather than hanging forever when hello-ok never arrives", async () => {
  const promise = pairDevice({
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN },
    GatewayClient: FakeGatewayClient,
    timeoutMs: 20,
  });
  await assert.rejects(promise, /timed out/);
});

test("pairDevice: the token never appears in a rejection message (no token in output)", async () => {
  const promise = pairDevice({
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN },
    GatewayClient: FakeGatewayClient,
  });
  const client = FakeGatewayClient.instances[0];
  client.opts.onConnectError(new Error(`refused near token ${TOKEN.slice(0, 6)}...-should-not-echo-full`));
  try {
    await promise;
    assert.fail("expected rejection");
  } catch (error) {
    assert.equal(error.message.includes(TOKEN), false);
  }
});

test("pairDevice: throws before ever constructing a client when the token is missing (no argv fallback)", () => {
  assert.throws(() => pairDevice({ env: {}, GatewayClient: FakeGatewayClient }), /OPENCLAW_GATEWAY_TOKEN/);
  assert.equal(FakeGatewayClient.instances.length, 0);
});

test("module has no CLI flag for the token: the file's source never reads --token from argv", () => {
  const source = readFileSync(path.join(HERE, "..", "lane", "pair-device.mjs"), "utf8");
  assert.equal(/--token/.test(source), false);
  assert.equal(/process\.argv\[.*token/i.test(source), false);
});

test("main: the success log line is exactly the scopes, never the token — kills an appended-token mutation", async () => {
  const logs = [];
  await main({
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN, OPENCLAW_STATE_DIR: "/lane-cli" },
    assertDedicatedLaneStateDirImpl: () => {},
    resolveInstallDirImpl: (env) => {
      assert.equal(env.OPENCLAW_STATE_DIR, "/lane-cli");
      return "/app";
    },
    loadStateDirResolverImpl: async (installDir) => {
      assert.equal(installDir, "/app");
      return undefined;
    },
    loadGatewayClientImpl: async (installDir) => {
      assert.equal(installDir, "/app");
      return FakeGatewayClient;
    },
    resolveGatewayUrlImpl: async (installDir) => {
      assert.equal(installDir, "/app");
      return "ws://127.0.0.1:18789";
    },
    pairDeviceImpl: async (opts) => {
      assert.equal(opts.GatewayClient, FakeGatewayClient);
      assert.equal(opts.url, "ws://127.0.0.1:18789");
      assert.equal(opts.env.OPENCLAW_GATEWAY_TOKEN, TOKEN);
      return { granted: ["operator.read", "operator.write", "operator.approvals"] };
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(logs, ["paired: scopes operator.read,operator.write,operator.approvals"]);
});

test("main: resolves the install (needed for the state-dir resolver), then asserts, before ever dialing out", async () => {
  const order = [];
  await assert.rejects(
    main({
      env: {},
      resolveInstallDirImpl: () => {
        order.push("resolveInstallDir");
        return "/app";
      },
      loadStateDirResolverImpl: async () => {
        order.push("loadStateDirResolver");
        return undefined;
      },
      assertDedicatedLaneStateDirImpl: () => {
        order.push("assert");
        throw new Error("OPENCLAW_STATE_DIR is required");
      },
      loadGatewayClientImpl: async () => {
        order.push("loadGatewayClient");
        return FakeGatewayClient;
      },
      resolveGatewayUrlImpl: async () => "ws://127.0.0.1:18789",
      pairDeviceImpl: async () => ({ granted: [] }),
      log: () => {},
    }),
    /OPENCLAW_STATE_DIR/,
  );
  assert.deepEqual(order, ["resolveInstallDir", "loadStateDirResolver", "assert"]);
});

test("pair-device.mjs: none of the helper's own error messages interpolate the token", () => {
  const source = readFileSync(path.join(HERE, "..", "lane", "pair-device.mjs"), "utf8");
  const errorLiterals = [...source.matchAll(/new Error\(\s*`([^`]*)`/g)].map((m) => m[1]);
  assert.ok(errorLiterals.length > 0);
  for (const literal of errorLiterals) {
    assert.equal(
      /\$\{[^}]*token[^}]*\}/i.test(literal),
      false,
      `error literal interpolates a token-named value: ${literal}`,
    );
  }
});

test("pairing uses an interactive SSH login before the remote bash block", () => {
  const readme = readFileSync(path.join(HERE, "..", "lane", "README.md"), "utf8");
  assert.doesNotMatch(readme, /^ssh\s+[^\n]*\bbash -c '/m);
  assert.match(readme, /^ssh <daemon-user>@<host>\s*$/m);
  assert.match(readme, /IFS= read -rsp "Gateway token: " OPENCLAW_GATEWAY_TOKEN/);
});
