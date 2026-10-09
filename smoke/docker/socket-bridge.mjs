import net from "node:net";

const mode = process.argv[2];
const port = Number(process.env.SMOKE_BRIDGE_PORT ?? 47911);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !["host", "container"].includes(mode)) {
  console.error("usage: node socket-bridge.mjs host|container (SMOKE_BRIDGE_PORT=1..65535)");
  process.exit(2);
}

const hostSocket = process.env.SESSIONBUS_SOCKET ?? `/tmp/sessionbus-${process.getuid()}/presence.sock`;
const containerSocket = "/tmp/sb/presence.sock";

const server = net.createServer((client) => {
  const upstream = mode === "host"
    ? net.createConnection(hostSocket)
    : net.createConnection({ host: "host.docker.internal", port });
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", (error) => { console.error(`bridge client: ${error.message}`); upstream.destroy(); });
  upstream.on("error", (error) => { console.error(`bridge upstream: ${error.message}`); client.destroy(); });
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});
server.on("error", (error) => { console.error(`bridge listen: ${error.message}`); process.exitCode = 1; });

if (mode === "host") {
  server.listen(port, "127.0.0.1", () => console.log(`bridge host 127.0.0.1:${port} -> ${hostSocket}`));
} else {
  server.listen({ path: containerSocket, readableAll: true, writableAll: true }, () =>
    console.log(`bridge container ${containerSocket} -> host.docker.internal:${port}`));
}
