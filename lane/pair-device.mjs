// Lane device credential: pair directly with narrow scopes. The older CLI and rotation steps were disproven
// by observing that `openclaw acp` requests no scopes and self-pairs as admin, and
// `devices rotate` afterwards is denied — narrowing an already-admin device needs a caller
// connection scoped to operator.pairing, which no CLI surface exposes non-interactively.
//
// Connects once, directly through GatewayClient (openclaw/plugin-sdk/gateway-runtime), requesting
// exactly operator.read/write/approvals instead of taking the constructor's admin
// default. Silent local pairing (docs/gateway/pairing.md) then mints a device token with those
// scopes and nothing wider, never transiently holding admin. Run once per OpenClaw install: the
// smoke's `run.sh provision_credential` and an install's pairing step (lane/README.md) both call this
// file the same way.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

// Narrow device scopes: never operator.admin, not even transiently.
export const REQUESTED_SCOPES = Object.freeze(["operator.read", "operator.write", "operator.approvals"]);

export function scopeSetsEqual(requested, granted) {
  if (!Array.isArray(requested) || !Array.isArray(granted)) {
    return false;
  }
  const a = Array.from(new Set(requested)).sort();
  const b = Array.from(new Set(granted)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// The shared token is read from env only, once, and never re-exported, argv'd or logged.
export function readGatewayToken(env) {
  const token = env.OPENCLAW_GATEWAY_TOKEN;
  if (!token || !token.trim()) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is required in env (never as an argument)");
  }
  return token;
}

const defaultResolveDeps = Object.freeze({
  existsSync,
  realpathSync,
  homedir,
  which(bin) {
    return execFileSync("command", ["-v", bin], { shell: "/bin/sh" }).toString().trim();
  },
});

// Mirrors 8.2's own default (src/config/paths.ts resolveStateDir/newStateDir): OPENCLAW_HOME (if
// set) or the OS home dir, plus ".openclaw". Legacy (.clawdbot) and profile-suffixed dirs aren't
// reproduced here — this is only the fallback for when the targeted install's own `resolveStateDir`
// (`openclaw/plugin-sdk/state-paths`) can't be loaded; `main` wires that in via
// `deps.resolveStateDir` whenever it's available, which does reproduce all of that.
export function resolveDefaultOpenClawStateDir(env, deps = defaultResolveDeps) {
  if (typeof deps.resolveStateDir === "function") {
    // The install's own resolver reads OPENCLAW_STATE_DIR itself; clearing it here is what makes
    // this call mean "what the *default* would be", not "the override we're checking".
    return deps.resolveStateDir({ ...env, OPENCLAW_STATE_DIR: "" });
  }
  const home = env.OPENCLAW_HOME?.trim() || deps.homedir();
  return join(home, ".openclaw");
}

// A device already paired as admin gets its existing admin token back on the next connect,
// regardless of the requested scopes. This can happen after `openclaw acp` or the TUI used the
// same state dir with the shared token, or when the dir is the Gateway's own state dir in a
// same-user install. The device-pairing implementation preserves that token, so
// `hello.auth.scopes` alone cannot tell "freshly minted
// read/write/approvals" apart from "admin token returned, but this connect asked for less" — so
// refuse up front, before ever dialing, for the ways that state can already be dirty.
export function assertDedicatedLaneStateDir(env, deps = defaultResolveDeps) {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error(
      "OPENCLAW_STATE_DIR is required: point it at a fresh, dedicated lane state dir, never the default OpenClaw state dir",
    );
  }
  // A leading "~" (e.g. "~/.openclaw") or a relative path is never expanded by this
  // guard's own path.resolve — OpenClaw's own resolveUserPath does expand "~", so such a value
  // would compare unequal here yet still land in the real default dir once OpenClaw resolves it.
  // Requiring absolute closes that regardless of whether the install's own resolver is available.
  if (!isAbsolute(stateDir)) {
    throw new Error(`OPENCLAW_STATE_DIR must be an absolute path (got ${stateDir}); a leading "~" is not expanded here`);
  }
  const resolvedStateDir = resolvePath(stateDir);
  const defaultStateDir = resolvePath(resolveDefaultOpenClawStateDir(env, deps));
  if (resolvedStateDir === defaultStateDir) {
    throw new Error(
      `OPENCLAW_STATE_DIR must not be the default OpenClaw state dir (${defaultStateDir}): use a fresh, dedicated lane state dir`,
    );
  }
  const sqlitePath = join(resolvedStateDir, "state", "openclaw.sqlite");
  if (deps.existsSync(sqlitePath)) {
    throw new Error(
      `OPENCLAW_STATE_DIR already holds a device identity/token (${sqlitePath}): use a fresh, dedicated lane state dir; to re-pair, run "devices remove <old id>" as admin first and start over with a new dir`,
    );
  }
}

// loads the targeted install's own default-state-dir algorithm
// (`openclaw/plugin-sdk/state-paths`'s `resolveStateDir`) so the default-dir comparison above
// matches 8.2 exactly (OPENCLAW_HOME, "~" expansion, legacy .clawdbot fallback, profile suffixes)
// instead of the hand-rolled approximation. Returns undefined if the install can't provide it —
// resolveDefaultOpenClawStateDir's fallback still applies, and the absolute-path/sqlite checks
// above are unaffected either way.
export async function loadStateDirResolver(installDir, opts) {
  try {
    const mod = await importFromInstall(installDir, "openclaw/plugin-sdk/state-paths", opts);
    if (typeof mod.resolveStateDir === "function") {
      return mod.resolveStateDir;
    }
  } catch {
    // fall through — the caller uses the hand-rolled default instead
  }
  return undefined;
}

// "Resolved from the OpenClaw install it targets": an explicit OPENCLAW_INSTALL_DIR
// wins; otherwise the `openclaw` binary on PATH names its own install root (global installs and the
// smoke's /app both put the package root there, one symlink hop away).
export function resolveInstallDir(env, deps = defaultResolveDeps) {
  const override = env.OPENCLAW_INSTALL_DIR?.trim();
  if (override) {
    if (!deps.existsSync(join(override, "package.json"))) {
      throw new Error(`OPENCLAW_INSTALL_DIR has no package.json: ${override}`);
    }
    return override;
  }
  let binPath = "";
  try {
    binPath = deps.which("openclaw");
  } catch {
    binPath = "";
  }
  if (!binPath) {
    throw new Error('cannot find an OpenClaw install: set OPENCLAW_INSTALL_DIR or put "openclaw" on PATH');
  }
  return dirname(deps.realpathSync(binPath));
}

// Node's package "exports" self-reference needs a referrer inside the target install; seeding
// `createRequire` at that install's own package.json satisfies it regardless of where this file
// itself was invoked from (a bind mount, a global install, anywhere).
export async function importFromInstall(installDir, specifier, { createRequireImpl = createRequire, importImpl = (u) => import(u) } = {}) {
  const req = createRequireImpl(pathToFileURL(join(installDir, "package.json")).href);
  const resolved = req.resolve(specifier);
  return importImpl(pathToFileURL(resolved).href);
}

export async function loadGatewayClient(installDir, opts) {
  const mod = await importFromInstall(installDir, "openclaw/plugin-sdk/gateway-runtime", opts);
  if (typeof mod.GatewayClient !== "function") {
    throw new Error("openclaw/plugin-sdk/gateway-runtime has no GatewayClient export");
  }
  return mod.GatewayClient;
}

// The helper has no URL or port override of its own. It reads the
// same local-mode port the targeted install's own config resolves, never a hardcoded default and
// never a port scan (a host can run unrelated services on 18790/18791).
export async function loadGatewayTarget(installDir, opts) {
  const core = await importFromInstall(installDir, "openclaw/plugin-sdk/core", opts);
  const health = await importFromInstall(installDir, "openclaw/plugin-sdk/health", opts);
  if (typeof core.resolveGatewayPort !== "function") {
    throw new Error("openclaw/plugin-sdk/core has no resolveGatewayPort export");
  }
  if (typeof health.readConfigFileSnapshot !== "function") {
    throw new Error("openclaw/plugin-sdk/health has no readConfigFileSnapshot export");
  }
  return { resolveGatewayPort: core.resolveGatewayPort, readConfigFileSnapshot: health.readConfigFileSnapshot };
}

// Reads the config this process's own env already points at (the lane's dedicated
// OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH, the same one both lane children will use) and resolves
// the local Gateway URL the real CLI would dial. Refuses remote mode: silent local pairing needs a
// same-host connect, and a remote target's device-auth storage differs (origin-scoped), so a
// helper pairing would land somewhere the lane CLI never reads.
export async function resolveGatewayUrl(installDir, env = process.env, opts) {
  const { resolveGatewayPort, readConfigFileSnapshot } = await loadGatewayTarget(installDir, opts);
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot?.exists) {
    throw new Error(`the targeted config at ${snapshot?.path ?? "<unknown>"} does not exist; create the lane's dedicated tokenless config before pairing`);
  }
  // readConfigFileSnapshot reports a bad file via valid:false/readError rather than
  // throwing. Reading runtimeConfig regardless would let a typo (e.g. gateway.port as a string)
  // fall straight through to OPENCLAW_GATEWAY_PORT or the hardcoded default port — silently
  // dialing the wrong Gateway instead of the one this config names.
  if (snapshot?.exists && (!snapshot.valid || snapshot.readError)) {
    throw new Error(
      `the targeted config at ${snapshot.path} exists but is invalid or unreadable (readError=${snapshot.readError?.code ?? "<none>"}); fix it before pairing`,
    );
  }
  const cfg = snapshot?.runtimeConfig ?? snapshot?.config ?? {};
  if (cfg.gateway?.mode === "remote") {
    throw new Error(
      'gateway.mode is "remote" in the targeted config: pair-device.mjs only supports local-mode silent pairing; switch to gateway.mode="local" for the lane\'s dedicated config, or pair this device by hand',
    );
  }
  const port = resolveGatewayPort(cfg, env);
  return `ws://127.0.0.1:${port}`;
}

// Client mode/id "cli" (packages/gateway-protocol/src/client-info.ts GATEWAY_CLIENT_MODES.CLI /
// GATEWAY_CLIENT_IDS.CLI) is load-bearing: the server's local-pairing and scope-preservation checks
// (handshake-auth-helpers.ts shouldPreserveLocalCliSharedAuthScopes) key on exactly this id+mode
// pair for a shared-secret loopback connect, so the requested scopes are kept as-is rather than
// clamped or expanded to a default.
export function pairDevice({ env = process.env, GatewayClient, url, timeoutMs = 30_000 } = {}) {
  const token = readGatewayToken(env);
  const startedAtMs = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    // `client` is declared with `let`, not assigned inline in the constructor call, so a
    // watchdog firing before construction finishes (or after a synchronous constructor throw) sees
    // `undefined` and can no-op via `?.` instead of hitting a TDZ ReferenceError 30s later.
    let client;
    const settle = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      fn();
    };
    const watchdog = setTimeout(() => {
      settle(() => {
        client?.stop();
        reject(new Error(`gateway pairing timed out after ${timeoutMs} ms`));
      });
    }, timeoutMs);
    try {
      client = new GatewayClient({
        url,
        token,
        mode: "cli",
        clientName: "cli",
        scopes: [...REQUESTED_SCOPES],
        onHelloOk: (hello) => {
          const auth = hello?.auth ?? {};
          const granted = auth.scopes ?? [];
          settle(() => {
            client
              .stopAndWait({ timeoutMs: 2000 })
              .catch(() => {})
              .finally(() => {
                // `hello.auth.scopes` is this *connection's* scopes, not proof the
                // device token itself was minted narrow. A device already paired as admin gets its
                // existing admin token handed back unchanged, whatever this connect asked for — so
                // a bare scope check alone can't tell "fresh read/write/approvals" apart from
                // "reused admin, coincidentally reported at the requested scopes". Require a
                // device token that (a) exists and (b) was issued at or after this connection
                // started — a reused token carries its old createdAtMs/rotatedAtMs.
                if (!auth.deviceToken) {
                  reject(
                    new Error(
                      "gateway hello carried no device token: this connect did not receive a paired device credential",
                    ),
                  );
                } else if (typeof auth.issuedAtMs !== "number" || auth.issuedAtMs < startedAtMs) {
                  reject(
                    new Error(
                      `the granted device token was not issued by this connection (reused an existing token: issuedAtMs=${auth.issuedAtMs ?? "<none>"}, this run started ${startedAtMs}); use a fresh, dedicated OPENCLAW_STATE_DIR`,
                    ),
                  );
                } else if (!scopeSetsEqual(REQUESTED_SCOPES, granted)) {
                  reject(
                    new Error(
                      `granted scopes [${granted.join(",")}] differ from requested [${REQUESTED_SCOPES.join(",")}]`,
                    ),
                  );
                } else {
                  resolve({ granted });
                }
              });
          });
        },
        // A pending-pairing request (silent pairing declined) arrives here, as a connect-request
        // error response, before any hello-ok (connect-device-pairing.ts). No fallback to admin, no
        // rotate — report and stop.
        onConnectError: (error) => {
          settle(() => {
            client.stop();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        },
        // Also stop() here: a transient pre-hello clean close that isn't reported as a
        // connect error otherwise leaves the protocol client's own reconnect loop running
        // (unbounded backoff, unref'd timer) after this promise has already rejected.
        onClose: (code, reason) => {
          settle(() => {
            client.stop();
            reject(new Error(`gateway connection closed before pairing completed: code=${code} reason=${reason || "<none>"}`));
          });
        },
      });
      client.start();
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

// Deps are injectable so a test can drive the whole CLI flow without a real OpenClaw install or
// Gateway (`main` was otherwise untested, so a mutation appending the token to the
// success line stayed green).
export async function main({
  env = process.env,
  assertDedicatedLaneStateDirImpl = assertDedicatedLaneStateDir,
  resolveInstallDirImpl = resolveInstallDir,
  loadStateDirResolverImpl = loadStateDirResolver,
  loadGatewayClientImpl = loadGatewayClient,
  resolveGatewayUrlImpl = resolveGatewayUrl,
  pairDeviceImpl = pairDevice,
  log = console.log,
} = {}) {
  const installDir = resolveInstallDirImpl(env);
  const resolveStateDirFn = await loadStateDirResolverImpl(installDir);
  assertDedicatedLaneStateDirImpl(env, resolveStateDirFn ? { ...defaultResolveDeps, resolveStateDir: resolveStateDirFn } : undefined);
  const GatewayClient = await loadGatewayClientImpl(installDir);
  const url = await resolveGatewayUrlImpl(installDir, env);
  const { granted } = await pairDeviceImpl({ env, GatewayClient, url });
  log(`paired: scopes ${granted.join(",")}`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main()
    .catch((error) => {
      console.error(`pair-device: ${error.message}`);
      process.exitCode = 1;
    })
    // pairDevice() always stops its client before settling, but exit explicitly rather
    // than trust that nothing else in the process (a stray timer, an open handle) keeps it alive.
    .finally(() => {
      process.exit(process.exitCode ?? 0);
    });
}
