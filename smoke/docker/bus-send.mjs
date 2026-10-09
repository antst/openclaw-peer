// A bus sender with a STABLE session id, so several messages come from the same sender (sessionbus-call
// picks a fresh id every run). Dependency-free: raw JSON-RPC lines over the host daemon's unix socket.
//
//   node bus-send.mjs --id smoke-sender --group oc-smoke --target openclaw-smoke@host msg=SLOW sleep=3000 msg=INJECT-MARK
//
// Prints one receipt JSON per `msg=` item. Socket: $SESSIONBUS_SOCKET or /tmp/sessionbus-<uid>/presence.sock.
import net from "node:net";

const argv = process.argv.slice(2);
const opts = { id: "smoke-sender", group: "oc-smoke", target: "" };
const steps = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--id" || arg === "--group" || arg === "--target") opts[arg.slice(2)] = argv[++i];
  else if (arg.startsWith("msg=")) steps.push({ send: arg.slice(4) });
  else if (arg.startsWith("sleep=")) steps.push({ sleep: Number(arg.slice(6)) });
  else { console.error(`bus-send: unknown argument ${arg}`); process.exit(2); }
}
if (!opts.target || steps.length === 0) { console.error("usage: bus-send.mjs --id ID --group G --target SESSION msg=TEXT [sleep=MS msg=TEXT ...]"); process.exit(2); }

const socketPath = process.env.SESSIONBUS_SOCKET ?? `/tmp/sessionbus-${process.getuid()}/presence.sock`;
const socket = net.createConnection(socketPath);
let nextId = 0;
const waiting = new Map();
let buffer = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\n")) >= 0;) {
    const frame = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (frame.method) {
      // A daemon-initiated delivery to this sender: acknowledge it, nothing more.
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { disposition: "injected" } })}\n`);
    } else waiting.get(frame.id)?.(frame);
  }
});
socket.on("error", (error) => { console.error(`bus-send: ${error.message}`); process.exit(1); });
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  waiting.set(id, (frame) => (frame.error ? reject(new Error(JSON.stringify(frame.error))) : resolve(frame.result)));
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});

await new Promise((resolve) => socket.once("connect", resolve));
await call("session.hello", { protocol: 1, product: "sessionbus-call", session_id: opts.id, groups: [opts.group], info: {} });
for (const step of steps) {
  if (step.sleep !== undefined) await new Promise((resolve) => setTimeout(resolve, step.sleep));
  else console.log(JSON.stringify(await call("message.send", { target: opts.target, message: step.send })));
}
socket.end();
