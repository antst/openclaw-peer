// Docker-only transport for the worker bridge. In production the host worker dials the plugin's unix socket
// directly (SESSIONBUS_OPENCLAW_BRIDGE); here the plugin runs in a container, so the worker's socket is a host
// unix socket that is tunnelled over loopback TCP into the Gateway container's own unix socket:
//
//   host worker -> host unix socket (mode host) -> 127.0.0.1:PORT (published) -> container (mode container)
//               -> unix socket in the volume shared with the Gateway (the plugin's bridge)
//
// Both modes read the same variable: SESSIONBUS_OPENCLAW_BRIDGE (the path on *their* side of the tunnel).
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2];
const port = Number(process.env.LANE_BRIDGE_PORT ?? 47912);
const socketPath = process.env.SESSIONBUS_OPENCLAW_BRIDGE ?? "";
// Container side: the Gateway's uid. The sidecar runs as root; the plugin (uid 1000) must own the directory it binds in.
const gatewayUid = Number(process.env.LANE_BRIDGE_UID ?? 1000);
// The published port is bound to loopback by the compose file; inside the container the tunnel listens on every
// interface so Docker's port mapping can reach it.
const tcpBind = mode === "container" ? "0.0.0.0" : "127.0.0.1";

if (!["host", "container"].includes(mode) || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !path.isAbsolute(socketPath)) {
  console.error("usage: bridge-tunnel.mjs host|container (SESSIONBUS_OPENCLAW_BRIDGE=<absolute path>, LANE_BRIDGE_PORT=1..65535)");
  process.exit(2);
}

function pipeBoth(client, upstream) {
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}

if (mode === "host") {
  // The worker's end: a private directory and a 0600 socket, as the plugin would make them.
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((client) => {
    const upstream = net.createConnection({ host: "127.0.0.1", port });
    pipeBoth(client, upstream);
  });
  server.on("error", (error) => { console.error(`bridge host tunnel: ${error.message}`); process.exitCode = 1; });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    console.log(`bridge host tunnel ${socketPath} -> ${tcpBind}:${port}`);
  });
} else {
  // The plugin creates this directory itself when it does not exist, but it cannot create it inside the
  // root-owned volume mount: make the leaf here, owned by the Gateway's uid, 0700.
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.getuid?.() === 0) fs.chownSync(dir, gatewayUid, gatewayUid);
  fs.chmodSync(dir, 0o700);
  const server = net.createServer((client) => {
    // Connect per client: the plugin may not be listening yet, or may restart.
    const upstream = net.createConnection(socketPath);
    upstream.on("error", () => client.destroy());
    pipeBoth(client, upstream);
  });
  server.on("error", (error) => { console.error(`bridge container tunnel: ${error.message}`); process.exitCode = 1; });
  server.listen(port, tcpBind, () => console.log(`bridge container tunnel ${tcpBind}:${port} -> ${socketPath}`));
}
