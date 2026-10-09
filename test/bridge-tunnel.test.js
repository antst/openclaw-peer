// The lane smoke's docker-only transport (smoke/docker/lane/bridge-tunnel.mjs): a host unix socket tunnelled over
// loopback TCP into a unix socket "inside the container". Both halves run here as real processes; a plain unix
// echo server stands in for the plugin's bridge.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "smoke", "docker", "lane", "bridge-tunnel.mjs");

function tmp(t) {
  const dir = mkdtempSync("/tmp/bt-"); // short: unix socket paths
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Starts the tunnel in `mode` and resolves with its first stdout line. */
function tunnel(t, mode, socketPath, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, mode], {
      env: { ...process.env, SESSIONBUS_OPENCLAW_BRIDGE: socketPath, LANE_BRIDGE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill());
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`tunnel produced no output within 5s: ${err}`)), 5000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) {
        clearTimeout(timer);
        resolve(out.slice(0, out.indexOf("\n")));
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`tunnel exited ${code}: ${err}`));
      }
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a message crosses host socket -> TCP -> container socket and the reply comes back", async (t) => {
  const dir = tmp(t);
  const port = await freePort();
  const containerSide = path.join(dir, "c", "bridge.sock");
  const hostSide = path.join(dir, "h", "bridge.sock");

  const first = await tunnel(t, "container", containerSide, port);
  assert.match(first, new RegExp(`^bridge container tunnel 0\\.0\\.0\\.0:${port} -> ${containerSide}$`));
  // The "plugin": a unix echo server in the directory the tunnel prepared.
  const plugin = net.createServer((socket) => socket.on("data", (chunk) => socket.write(`echo:${chunk}`)));
  await new Promise((resolve) => plugin.listen(containerSide, resolve));
  t.after(() => plugin.close());

  const second = await tunnel(t, "host", hostSide, port);
  assert.match(second, new RegExp(`^bridge host tunnel ${hostSide} -> 127\\.0\\.0\\.1:${port}$`));

  const client = net.createConnection(hostSide);
  const reply = await new Promise((resolve, reject) => {
    client.once("error", reject);
    client.once("data", (chunk) => resolve(String(chunk)));
    client.once("connect", () => client.write("hello\n"));
  });
  client.destroy();
  assert.equal(reply, "echo:hello\n");
});

test("the host side is a private 0600 socket in a 0700 directory", async (t) => {
  const dir = tmp(t);
  const hostSide = path.join(dir, "h", "bridge.sock");
  await tunnel(t, "host", hostSide, await freePort());
  assert.equal(statSync(hostSide).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(hostSide)).mode & 0o777, 0o700);
});

test("the container side creates its 0700 directory for the plugin", async (t) => {
  const dir = tmp(t);
  const containerSide = path.join(dir, "vol", "b", "bridge.sock");
  await tunnel(t, "container", containerSide, await freePort());
  assert.equal(statSync(path.dirname(containerSide)).mode & 0o777, 0o700);
});

test("a relative bridge path is refused", async (t) => {
  const child = spawn(process.execPath, [SCRIPT, "host"], { env: { ...process.env, SESSIONBUS_OPENCLAW_BRIDGE: "relative.sock" }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => child.kill());
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 2);
});
