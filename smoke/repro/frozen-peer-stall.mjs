// frozen-peer-stall live repro against the installed sessionbus / sessionbus-hub (v0.5.12).
// Private loopback federation: hub + daemons alpha, beta; peers via the kit; beta gets SIGSTOP
// (a laptop lid closed: TLS link open, no answers). Measures on alpha, then SIGCONT.
// Exit 1 while the bug is present: the plugin tool's local send hangs behind the unfiltered list
// and an abandoned send is never delivered.
// Usage: node smoke/repro/frozen-peer-stall.mjs [workdir]   (never touches the installed service)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import kit from "@sessionbus/kit";
import { createToolFactory } from "../../src/tool.js";

const base = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "frozen-peer-stall-")));
const sock = fs.mkdtempSync("/tmp/sbfps-"); // short: unix socket path limit
fs.mkdirSync(base, { recursive: true });
const port = 17000 + Math.floor(Math.random() * 2000);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SESSIONBUS_")));
const procs = [];
const killAll = () => { for (const p of procs) { try { process.kill(p.pid, "SIGCONT"); p.kill("SIGKILL"); } catch {} } };
process.on("exit", killAll);
const t0 = Date.now();
const log = (line) => { const text = `[${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}] ${line}`; console.log(text); fs.appendFileSync(path.join(base, "report.txt"), `${text}\n`); };
function start(name, cmd, args, extra = {}) {
  const out = fs.openSync(path.join(base, `${name}.stderr`), "w");
  const child = spawn(cmd, args, { env: { ...env, ...extra }, stdio: ["ignore", out, out] });
  procs.push(child);
  return child;
}

const failures = [];
try {
  const hubConfig = path.join(base, "hub.json");
  fs.writeFileSync(hubConfig, "{}", { mode: 0o600 });
  for (const host of ["alpha", "beta"]) {
    const key = path.join(base, `${host}.key`);
    fs.writeFileSync(key, execFileSync("sessionbus", ["secret"], { env }), { mode: 0o600 });
    execFileSync("sessionbus-hub", ["add-host", "--secret-file", key, "--config", hubConfig, host], { env });
  }
  start("hub", "sessionbus-hub", ["--listen", `127.0.0.1:${port}`, "--config", hubConfig]);
  await sleep(300);
  const daemons = {};
  for (const host of ["alpha", "beta"]) {
    const state = path.join(base, `state-${host}`);
    fs.mkdirSync(state, { recursive: true });
    daemons[host] = start(host, "sessionbus", ["-host", host, "-hub", `127.0.0.1:${port}`, "-hub-secret-file", path.join(base, `${host}.key`),
      "-socket", path.join(sock, `${host}.sock`), "-table", path.join(state, "sessions.json"), "-comms-log", "off", "-comms-log-dir", path.join(state, "comms"), "-products", ""],
    { XDG_STATE_HOME: state });
  }
  await sleep(1500);

  const delivered = [];
  const connect = (host, id) => kit.connectPeer({ product: "openclaw-peer", session_id: id, groups: ["g"], info: {} },
    async (_signal, request) => { delivered.push(request.body); return { disposition: "written" }; },
    { SESSIONBUS_SOCKET: path.join(sock, `${host}.sock`) }, { connect: (p) => net.createConnection(p) });
  const advisor = connect("alpha", "advisor"), swarm = connect("alpha", "swarm"), remote = connect("beta", "remote");
  await Promise.all([advisor.ready, swarm.ready, remote.ready]);
  await sleep(500);

  const service = { started: true, bindingFor: () => ({ sessionKey: "agent:advisor:main" }), logger: { debug() {}, info() {}, warn() {}, error() {} },
    guard: { wouldExceed: () => false, record() {} }, routeKeys: () => new Set(), laneConn: () => null,
    peerFor: () => ({ action: (action, args, signal) => advisor.caller.action(action, args, signal) }) };
  const tool = createToolFactory(service)({ agentId: "advisor", sessionKey: "agent:advisor:main" });

  async function timed(label, run, ms = 8000) {
    const caller = new AbortController();
    const timer = setTimeout(() => caller.abort(new Error(`client timeout ${ms} ms`)), ms);
    const begin = Date.now();
    try {
      const value = await run(caller.signal);
      log(`${label}: ok ${Date.now() - begin} ms ${JSON.stringify(value).slice(0, 140)}`);
      return true;
    } catch (error) {
      log(`${label}: FAIL ${Date.now() - begin} ms ${error?.message ?? error}`);
      return false;
    } finally { clearTimeout(timer); }
  }
  const viaTool = (params) => async (signal) => {
    const result = await tool.execute("c", params, signal);
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text).deliveries.map((d) => d.disposition);
  };
  const roster = () => {
    try { execFileSync("sessionbus", ["roster", "--socket", path.join(sock, "alpha.sock")], { env, encoding: "utf8" }); return { rc: 0 }; }
    catch (error) { return { rc: error.status, lines: `${error.stdout}${error.stderr}`.split("\n").filter((l) => /beta|incomplete/.test(l)) }; }
  };
  async function round(tag) {
    const ok = {};
    ok.roster = await timed(`${tag} CLI sessionbus roster`, async () => roster(), 20000);
    ok.list = await timed(`${tag} kit list {}`, (s) => advisor.caller.action("list", {}, s).then((r) => r.sessions.map((x) => x.session_id)));
    ok.listHost = await timed(`${tag} kit list {host:alpha}`, (s) => advisor.caller.action("list", { host: "alpha" }, s).then((r) => r.sessions.length));
    ok.rawSend = await timed(`${tag} kit send local (no list)`, (s) => advisor.caller.action("send", { target: "swarm", message: `${tag}-raw-local` }, s).then((r) => r.deliveries.map((d) => d.disposition)));
    ok.toolSend = await timed(`${tag} plugin tool send local`, viaTool({ action: "send", arguments: { target: "swarm", message: `${tag}-tool-local` } }));
    ok.remoteSend = await timed(`${tag} kit send remote@beta`, (s) => advisor.caller.action("send", { target: "remote@beta", message: `${tag}-raw-remote` }, s).then((r) => r.deliveries.map((d) => d.disposition)), 4000);
    return ok;
  }

  await round("BASE");
  process.kill(daemons.beta.pid, "SIGSTOP");
  log("beta SIGSTOP");
  await sleep(1000);
  const frozen = await round("FROZEN");
  process.kill(daemons.beta.pid, "SIGCONT");
  log("beta SIGCONT");
  await sleep(1500);
  await round("AFTER");
  log(`delivered: ${JSON.stringify(delivered)}`);
  if (!frozen.toolSend) failures.push("plugin tool send to a local target hung while beta was frozen");
  if (!delivered.includes("FROZEN-tool-local")) failures.push("the abandoned FROZEN-tool-local send was never delivered, not even after SIGCONT");
  if (!frozen.list) failures.push("upstream: unfiltered list has no deadline for a frozen host");
  for (const peer of [advisor, swarm, remote]) peer.shutdown();
} finally {
  killAll();
  fs.rmSync(sock, { recursive: true, force: true });
}
for (const failure of failures) log(`RED: ${failure}`);
log(`report: ${path.join(base, "report.txt")}`);
process.exit(failures.length ? 1 : 0);
