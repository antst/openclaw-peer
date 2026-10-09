// Worker ↔ plugin bridge (Bridge wire v1, PLAN `## Interface`): JSON Lines over a unix socket.
// The plugin is the server. A worker asks for its settings, registers its lane key, and asks the plugin to steer
// text into the lane's running turn; the plugin hands lane-voice actions (`bus.action`) to the worker.
import net from "node:net";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { clearStaleSocket, ensureBridgeDir } from "./bridge-path.js";

const MAX_CONNECTIONS = 256;
const MAX_PENDING = 64;
const MAX_FRAME_BYTES = 1 << 20;
const FRAME_DEADLINE_MS = 10_000;
const MAX_STEER_BYTES = 128 * 1024;
// The shape of keys minted by lane/mintKey.
export const LANE_KEY = /^agent:([a-z0-9][a-z0-9_-]{0,63}):sb-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class BridgeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {string} options.path - socket path (resolveBridgePath).
 * @param {() => ({agents: object[], credentialDir: string, auditLog?: string}|{error: string})} options.settings
 * @param {{resolveActiveEmbeddedRunSessionId: (key: string) => string|undefined|Promise<string|undefined>, queueAgentHarnessMessage: (sessionId: string, text: string) => boolean|Promise<boolean>}} options.harness
 * @param {(agentId: string) => string|undefined} [options.configuredModel]
 * @param {object} [options.logger]
 * @param {number} [options.maxConnections] - default 256 (injectable for tests).
 * @param {number} [options.frameDeadlineMs] - default 10 s for a partial frame (injectable for tests).
 */
export function createBridgeServer({ path: socketPath, settings, harness, configuredModel = () => undefined, logger, maxConnections = MAX_CONNECTIONS, frameDeadlineMs = FRAME_DEADLINE_MS }) {
  const connections = new Set();
  const registry = new Map(); // sessionKey -> Connection
  let server = null;
  let listening = false; // close() removes the socket path only when this server bound it

  class Connection {
    constructor(socket) {
      this.socket = socket;
      this.key = null;
      this.pending = 0; // worker requests in flight
      this.requests = new Map(); // "p:<n>" -> {resolve, reject}
      this.next = 0;
      this.closed = false;
      this.decoder = new StringDecoder("utf8");
      this.buffer = "";
      this.frameTimer = null;
      socket.on("data", (chunk) => this.#data(chunk));
      socket.on("error", () => this.#close());
      socket.on("close", () => this.#close());
    }

    send(frame) {
      if (this.closed || this.socket.destroyed) return;
      this.socket.write(`${JSON.stringify({ v: 1, ...frame })}\n`);
    }

    /** plugin → worker request; resolves with the worker's result, rejects with its error frame. */
    request(method, params, signal) {
      if (this.closed) return Promise.reject(new BridgeError("cancelled", "bridge connection closed"));
      if (signal?.aborted) return Promise.reject(signal.reason ?? new BridgeError("cancelled"));
      const id = `p:${++this.next}`;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (!this.requests.delete(id)) return;
          reject(signal.reason ?? new BridgeError("cancelled"));
          this.send({ id: `p:${++this.next}`, method: "rpc.cancel", params: { id } });
        };
        this.requests.set(id, {
          resolve: (value) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        this.send({ id, method, params });
      });
    }

    fail(code, message) {
      this.send({ id: null, error: { code, message } });
      // end() flushes the error frame; the socket is destroyed once the peer has read it.
      this.socket.end();
      this.#close(false);
    }

    #data(chunk) {
      this.buffer += this.decoder.write(chunk);
      for (let newline; (newline = this.buffer.indexOf("\n")) >= 0;) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        clearTimeout(this.frameTimer);
        this.frameTimer = null;
        if (Buffer.byteLength(line) + 1 > MAX_FRAME_BYTES) return this.fail("frame_too_large", "frame exceeds 1 MiB");
        if (line.trim()) this.#frame(line);
        if (this.closed) return;
      }
      if (Buffer.byteLength(this.buffer) + 1 > MAX_FRAME_BYTES) return this.fail("frame_too_large", "frame exceeds 1 MiB");
      // A partial frame must complete within the deadline.
      if (this.buffer && !this.frameTimer) {
        this.frameTimer = setTimeout(() => this.fail("frame_timeout", "frame not completed within 10 s"), frameDeadlineMs);
        this.frameTimer.unref?.();
      }
    }

    #frame(line) {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return this.fail("bad_frame", "invalid JSON");
      }
      if (!frame || frame.v !== 1 || typeof frame.id !== "string") return this.fail("bad_frame", "expected a v1 frame with a string id");
      if (typeof frame.method === "string") return void this.#serve(frame);
      const waiting = this.requests.get(frame.id);
      if (!waiting) return; // a reply to a cancelled request
      this.requests.delete(frame.id);
      if (frame.error) waiting.reject(Object.assign(new BridgeError(frame.error.code ?? "action_failed", frame.error.message ?? ""), {}));
      else waiting.resolve(frame.result);
    }

    async #serve(frame) {
      if (!frame.id.startsWith("w:")) return this.send({ id: frame.id, error: { code: "bad_frame", message: "worker request ids start with w:" } });
      if (this.pending >= MAX_PENDING) return this.send({ id: frame.id, error: { code: "busy", message: "too many pending requests" } });
      this.pending += 1;
      try {
        const result = await handlers(this, frame.method, frame.params ?? {});
        this.send({ id: frame.id, result });
      } catch (error) {
        this.send({ id: frame.id, error: { code: error.code ?? "internal", message: error.message ?? String(error) } });
      } finally {
        this.pending -= 1;
      }
    }

    #close(destroy = true) {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.frameTimer);
      connections.delete(this);
      if (this.key && registry.get(this.key) === this) {
        registry.delete(this.key);
        logger?.info?.(`sessionbus: lane unregistered ${this.key}`);
      }
      for (const waiting of this.requests.values()) waiting.reject(new BridgeError("cancelled", "bridge connection closed"));
      this.requests.clear();
      if (destroy) this.socket.destroy();
    }

    close() {
      this.#close();
    }
  }

  async function handlers(conn, method, params) {
    switch (method) {
      case "settings.get": {
        const current = settings();
        if (current?.error) throw new BridgeError("lanes_not_configured", current.error);
        return { agents: current.agents, credentialDir: current.credentialDir, ...(current.auditLog ? { auditLog: current.auditLog } : {}) };
      }
      case "lane.register": {
        const { sessionKey, agentId } = params;
        if (conn.key) throw new BridgeError("already_bound");
        const match = typeof sessionKey === "string" ? LANE_KEY.exec(sessionKey) : null;
        if (!match) throw new BridgeError("bad_key");
        const current = settings();
        if (current?.error || !current?.agents?.some((agent) => agent.id === agentId)) throw new BridgeError("unknown_agent");
        if (registry.has(sessionKey)) throw new BridgeError("key_in_use");
        if (match[1] !== agentId) throw new BridgeError("agent_mismatch");
        registry.set(sessionKey, conn);
        conn.key = sessionKey;
        logger?.info?.(`sessionbus: lane registered ${sessionKey} agent=${agentId}`);
        return { ready: true };
      }
      case "lane.steer": {
        const { sessionKey, messageId, text } = params;
        if (!conn.key || sessionKey !== conn.key) throw new BridgeError("unbound");
        if (typeof text !== "string" || Buffer.byteLength(text) > MAX_STEER_BYTES) throw new BridgeError("too_large");
        const sessionId = await harness.resolveActiveEmbeddedRunSessionId(sessionKey);
        // The connection may have gone (or the key been re-registered) while the resolver ran (D9).
        if (registry.get(sessionKey) !== conn) throw new BridgeError("unbound");
        let eligible = false;
        let reason;
        if (!sessionId) reason = "registry_absent";
        else if (await harness.queueAgentHarnessMessage(sessionId, text)) eligible = true;
        else reason = "not_eligible";
        const agentId = LANE_KEY.exec(sessionKey)?.[1];
        logger?.info?.(`sessionbus: steer ${sessionKey} ${String(messageId).replace(/[^A-Za-z0-9._:@-]/g, "_")} eligible=${eligible} reason=${reason ?? "-"} configured_model=${configuredModel(agentId) ?? "unknown"}`);
        return eligible ? { eligible: true } : { eligible: false, reason };
      }
      default:
        throw new BridgeError("unknown_method", `unknown method ${method}`);
    }
  }

  return {
    connections,
    laneConn: (key) => registry.get(key),
    async listen() {
      ensureBridgeDir(socketPath);
      await clearStaleSocket(socketPath, (p) => net.createConnection(p));
      server = net.createServer((socket) => {
        if (connections.size >= maxConnections) {
          socket.end(`${JSON.stringify({ v: 1, id: null, error: { code: "too_many_connections", message: "bridge connection limit reached" } })}\n`);
          return;
        }
        const conn = new Connection(socket);
        connections.add(conn);
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        // A path listen binds synchronously inside listen(): the narrowed umask covers the bind and nothing else.
        // Worker threads cannot set the umask; there the chmod below is the only guard, as before.
        let mask;
        try {
          mask = process.umask(0o177);
        } catch (err) {
          if (err?.code !== "ERR_WORKER_UNSUPPORTED_OPERATION") throw err;
        }
        try {
          server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
          });
        } finally {
          if (mask !== undefined) process.umask(mask);
        }
      });
      listening = true;
      fs.chmodSync(socketPath, 0o600);
    },
    async close() {
      for (const conn of [...connections]) conn.close();
      registry.clear();
      if (!server) return;
      const closing = server;
      server = null;
      await new Promise((resolve) => closing.close(resolve));
      if (listening) fs.rmSync(socketPath, { force: true });
      listening = false;
    },
  };
}
