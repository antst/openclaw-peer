import fs from "node:fs";
import path from "node:path";

/** `$SESSIONBUS_OPENCLAW_BRIDGE` ∥ `$XDG_RUNTIME_DIR/openclaw-sessionbus/bridge.sock` ∥ `/tmp/openclaw-sessionbus-<uid>/bridge.sock`. */
export function resolveBridgePath(env, uid) {
  if (env?.SESSIONBUS_OPENCLAW_BRIDGE) return env.SESSIONBUS_OPENCLAW_BRIDGE;
  if (env?.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "openclaw-sessionbus", "bridge.sock");
  return path.join("/tmp", `openclaw-sessionbus-${uid}`, "bridge.sock");
}

/**
 * The endpoint directory must be a real directory of this uid. A directory this call creates is made 0700; one that
 * already exists is never re-permissioned (it may be an operator's $HOME or project directory) — if it is group or
 * world accessible the start is refused instead (D8).
 */
export function ensureBridgeDir(socketPath, uid = process.getuid?.() ?? 0) {
  const dir = path.dirname(socketPath);
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`bridge directory ${dir} is not a plain directory`);
  if (stat.uid !== uid) throw new Error(`bridge directory ${dir} is not owned by uid ${uid}`);
  if (created === undefined && (stat.mode & 0o077) !== 0) {
    throw new Error(`bridge directory ${dir} must be 0700 (set SESSIONBUS_OPENCLAW_BRIDGE to a path in a private directory)`);
  }
}

/**
 * Removes a stale socket file: only a socket of this uid whose listener is gone (connect → ECONNREFUSED).
 * A live listener is `bridge endpoint already served`; anything else at the path is refused.
 */
export async function clearStaleSocket(socketPath, connect, uid = process.getuid?.() ?? 0) {
  let stat;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket() || stat.uid !== uid) throw new Error(`bridge endpoint ${socketPath} exists and is not a socket of this uid`);
  const outcome = await new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve("live");
    });
    probe.once("error", (error) => resolve(error.code));
  });
  if (outcome === "live") throw new Error(`bridge endpoint already served: ${socketPath}`);
  if (outcome !== "ECONNREFUSED") throw new Error(`bridge endpoint ${socketPath} is not usable (${outcome})`);
  fs.unlinkSync(socketPath);
}
