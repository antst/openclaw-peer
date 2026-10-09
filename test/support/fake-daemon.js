// Hermetic Sessionbus daemon double, rebuilt from sessionbus@53c5f80 sources
// from sessionbus @53c5f80. Paths below are relative to that upstream; `D/` = bus/internal/daemon/,
// `SDK/` = bus/sdk/go/, `SPEC` = bus/docs/PROTOCOL.md.
//
// Every frame goes through the real kit `Connection`, so requests and results
// are validated by the actual wire schema (kit sdk/js/connection.js:40-49).
// The fake plays both halves a real deployment splits: the daemon (routing,
// visibility, admission, lane policy) and the lane worker behind it (run
// records, status/wait/ack), because a caller only ever sees their sum
// (D/session.go:264-337 routes turn.* to the worker, SDK/runs.go builds the replies).
import { Duplex } from "node:stream";
import net from "node:net";
import fs from "node:fs";
import connectionModule from "@sessionbus/kit/sdk/js/connection.js";

const { Connection, ProtocolError } = connectionModule;

// sessionbus@53c5f80 bus/sdk/go/protocol/types.go:16-33
export const CODES = Object.freeze({
  invalid_frame: -32600,
  invalid_hello: -32602,
  internal: -32603,
  unknown_session: -32001,
  not_connected: -32002,
  busy: -32003,
  not_running: -32004,
  already_connected: -32005,
  unknown_product: -32007,
  unsupported_open_field: -32008,
  spawn_failed: -32009,
  timeout: -32010,
  not_committed: -32011,
  superseded: -32012,
  name_taken: -32013,
  unknown_host: -32014,
  forward_lost: -32015,
  unsupported_trace: -32016,
});

// sessionbus@53c5f80 bus/internal/daemon/policy.go:16
export const DEFAULT_AUTO_CLOSE_MS = 60000;
// sessionbus@53c5f80 bus/sdk/go/protocol (MaxOperations), D/handlers.go:33-45 — in-flight requests per connection
const MAX_OPERATIONS = 256;
// sessionbus@53c5f80 bus/sdk/go/runs.go:132-214 — unacked run records a worker keeps
const MAX_RUN_RECORDS = 256;
// sessionbus@53c5f80 bus/internal/daemon/helpers.go:18 (hostPattern, same grammar as kit schema `host`)
const HOST_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Error a scripted handler throws to answer with a wire error. */
export class DaemonError extends Error {
  constructor(code, data) {
    super(`daemon error ${code}`);
    this.code = code;
    this.data = data;
  }
}

const RAW = Symbol("raw result");
/** Scripted handlers return this to write a result frame that bypasses kit encoding (invalid on purpose). */
export function rawResult(value) {
  return { [RAW]: value };
}

/**
 * The exact completion pointer text.
 * sessionbus@53c5f80 bus/internal/daemon/policy.go:196
 */
export function completionPointer(sessionId, runId, state) {
  return `Lane ${sessionId} run ${runId} is ${state}. Collect with the public wait action (session_id=${sessionId}, run_id=${runId}), then use the public ack action after collecting.`;
}

class MemorySocket extends Duplex {
  _read() {}
  _write(chunk, _encoding, callback) {
    if (!this.peer.destroyed) this.peer.push(Buffer.from(chunk));
    callback();
  }
  _destroy(error, callback) {
    if (!this.peer.destroyed) this.peer.destroy();
    callback(error);
  }
}

function pair() {
  const one = new MemorySocket();
  const two = new MemorySocket();
  one.peer = two;
  two.peer = one;
  return [one, two];
}

// sessionbus@53c5f80 bus/internal/daemon/helpers.go:121-129
function randomID(prefix) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let index = 0; index < 12; index++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}-${out}`;
}

// sessionbus@53c5f80 bus/internal/daemon/helpers.go:34-39
function qualify(value, host) {
  return value ? `${value}@${host}` : "";
}

// sessionbus@53c5f80 bus/internal/daemon/helpers.go:41-46
function unqualify(value) {
  const index = value.lastIndexOf("@");
  return index >= 0 ? value.slice(0, index) : value;
}

function hostOf(value) {
  const index = value.lastIndexOf("@");
  return index >= 0 ? value.slice(index + 1) : "";
}

// sessionbus@53c5f80 bus/internal/daemon/directory.go:57-59
function shares(left, right) {
  return left.some((value) => right.includes(value));
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * Lane policy normalization, fresh and resume.
 * sessionbus@53c5f80 bus/internal/daemon/policy.go:28-83; idle_message dropped in v0.5.8 (#94).
 */
export function normalizePolicy(input, previous, ownerId) {
  let value = { persistent: false, auto_close_ms: DEFAULT_AUTO_CLOSE_MS, notify: true, owner_session_id: ownerId };
  if (previous) {
    // policy.go:30-34 — resume keeps the old policy but resets auto_close_ms and owner
    value = { ...previous, auto_close_ms: DEFAULT_AUTO_CLOSE_MS, owner_session_id: ownerId };
  }
  if (input.persistent !== undefined) {
    if (value.persistent && !input.persistent) throw new DaemonError(CODES.unsupported_open_field); // policy.go:36-38
    value.persistent = input.persistent;
  }
  if (input.auto_close_ms !== undefined) value.auto_close_ms = input.auto_close_ms; // policy.go:41-43
  if (value.persistent) {
    // policy.go:47-66
    delete value.owner_session_id;
    if (!previous) value.notify = false;
    if (previous && !previous.persistent && previous.notify) value.notify_target = previous.owner_session_id;
    if (input.notify_target) {
      value.notify_target = input.notify_target;
      value.notify = true;
    }
    if (input.notify !== undefined) value.notify = input.notify;
    if (!value.notify) delete value.notify_target;
    if (value.notify && !value.notify_target) throw new DaemonError(CODES.unsupported_open_field);
  } else {
    // policy.go:67-75
    if (input.notify_target && input.notify_target !== ownerId) throw new DaemonError(CODES.unsupported_open_field);
    value.notify = true;
    delete value.notify_target;
    if (input.notify !== undefined) value.notify = input.notify;
  }
  // policy.go:76-78
  if (input.notify === false && input.notify_target) throw new DaemonError(CODES.unsupported_open_field);
  if (!value.owner_session_id) delete value.owner_session_id;
  return value;
}

const DEFAULT_PRODUCTS = {
  "claude-peer": {
    product: "claude-peer",
    version: "0.0.0-fake",
    supported_open_fields: ["cwd", "permission_mode", "model", "reasoning_effort", "arguments"],
    extra_arguments: [],
  },
};

/**
 * Default lane worker: completes the run with its input echoed back.
 * Return `undefined` (or use `worker: "manual"`) to keep the run running until
 * the test calls `daemon.finish` / `daemon.unavailable`.
 */
function echoWorker(input) {
  return { outcome: "completed", result: input };
}

/**
 * @param {object} [scripted]
 * @param {object|Function} [scripted.list]  legacy: fixed or computed `session.list` result
 * @param {object|Function} [scripted.send]  legacy: fixed or computed `message.send` result
 * @param {{code:number, data?:unknown}} [scripted.helloError]
 * @param {Record<string, Function>} [scripted.methods]  per-method override `(params, ctx) => result | rawResult(x)`; throw DaemonError for a wire error; `ctx.next()` runs the built-in handler
 * @param {object} [options]
 * @param {string} [options.host] daemon host suffix (default "testhost")
 * @param {Record<string, object>} [options.products] lane products known to lane.describe/lane.spawn
 * @param {Function|"manual"} [options.worker] `(input, lane) => {outcome, result} | Promise | undefined`
 * @param {Function} [options.laneId] `(request) => native session id` (unqualified)
 * @param {Array<{host:string, products:string[]}>} [options.hosts] `hosts` field of session.list
 */
export function createFakeDaemon(scripted = {}, options = {}) {
  const host = options.host ?? "testhost";
  const products = { ...DEFAULT_PRODUCTS, ...(options.products ?? {}) };
  const worker = options.worker ?? echoWorker;
  const laneIdFor = options.laneId ?? (() => randomID("lane"));
  const methods = { ...(scripted.methods ?? {}) };

  // Observation logs (public surface for assertions).
  const hellos = [];
  const sends = [];
  const lists = [];
  const spawns = [];
  const requests = [];
  const connects = [];

  /** @type {Map<string, object>} session_id → entry (peers and lanes), D/directory.go entries */
  const entries = new Map();
  /** @type {Set<object>} live connection states */
  const sessions = new Set();
  const attachedStreams = new Set();
  /** @type {Map<string, object>} federation: host → linked fake daemon */
  const linked = new Map();
  let current = null;
  let server = null;

  // ---- virtual clock for auto-close and wait timeouts ----
  let now = 0;
  const timers = new Set();
  function schedule(delayMs, fn) {
    const timer = { at: now + delayMs, fn };
    timers.add(timer);
    return timer;
  }
  function cancel(timer) {
    if (timer) timers.delete(timer);
  }
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due);
      now = due.at;
      due.fn();
      await flush();
    }
    now = target;
    await flush();
  }

  function selfInfo(entry) {
    // sessionbus@53c5f80 bus/internal/daemon/federation.go:203-206
    const info = { session_id: entry.row.session_id, product: entry.row.product, groups: [...entry.row.groups] };
    if (entry.row.name) info.name = entry.row.name;
    return info;
  }

  function summary(entry) {
    // sessionbus@53c5f80 bus/internal/daemon/directory.go:431-438, protocol/types.go:178-188
    const row = { session_id: entry.row.session_id, kind: entry.peer ? "peer" : "lane", product: entry.row.product, groups: [...entry.row.groups] };
    if (entry.row.name) row.name = entry.row.name;
    row.connected = entry.peer ? true : entry.connected;
    row.running = entry.peer ? false : entry.connected && Boolean(entry.running);
    if (entry.peer && entry.info) row.info = { ...entry.info };
    if (!entry.peer) row.policy = { ...entry.row.policy };
    return row;
  }

  // sessionbus@53c5f80 bus/internal/daemon/directory.go:344-346 — visibility = one shared group
  function visible(groups, entry) {
    return entry && shares(groups, entry.row.groups);
  }

  function localRows(groups) {
    // D/directory.go:352-361 — sorted by session_id
    return [...entries.values()].filter((entry) => visible(groups, entry)).sort((a, b) => (a.row.session_id < b.row.session_id ? -1 : 1));
  }

  // sessionbus@53c5f80 bus/internal/daemon/helpers.go:48 canonicalTarget — bare label → label@host
  function canonical(label) {
    return label.includes("@") ? label : qualify(label, host);
  }

  function resolveLabel(groups, label) {
    const id = canonical(label);
    const direct = entries.get(id);
    if (direct && visible(groups, direct)) return direct;
    return [...entries.values()].find((entry) => entry.row.name === id && visible(groups, entry));
  }

  function daemonFor(targetHost) {
    if (!targetHost || targetHost === host) return api;
    return linked.get(targetHost);
  }

  // ---- delivery (message.deliver to a connected session) ----
  async function deliverLocal(entry, params) {
    if (entry.peer || entry.attachment) {
      const state = entry.attachment;
      if (!state || state.connection.signal.aborted) return { disposition: "rejected", reason: "no_receipt" };
      try {
        return await write(() => state.connection.call("message.deliver", params));
      } catch {
        return { disposition: "rejected", reason: "no_receipt" };
      }
    }
    // A simulated lane: the message is recorded; the worker takes it as input.
    if (!entry.connected) return { disposition: "rejected", reason: "unknown_session" };
    entry.inbox.push(params);
    return { disposition: "written" };
  }

  /**
   * message.send routing.
   * sessionbus@53c5f80 bus/internal/daemon/handlers.go:286-365, federation.go:366-429
   */
  async function routeSend(from, callerGroups, input) {
    const messageId = randomID("message"); // handlers.go:294
    const deliveries = [];
    const body = { message_id: messageId, from, body: input.message };
    const seen = new Set();
    if (input.group !== undefined) {
      const hosts = input.host ? [input.host] : [host, ...linked.keys()];
      for (const h of hosts) {
        const peer = daemonFor(h);
        if (!peer) {
          deliveries.push({ target: input.group, disposition: "rejected", reason: "unknown_host" });
          continue;
        }
        // federation.go:196-201, directory.go:354 — a group send leaves out the sender
        const members = peer._localRows(callerGroups).filter((entry) => entry.row.groups.includes(input.group) && entry.row.session_id !== from.session_id);
        for (const entry of members) await peer._one(input.group, entry, body, deliveries, seen);
      }
    } else {
      const labels = input.targets ?? [input.target];
      for (const label of labels) {
        const id = canonical(label);
        const peer = daemonFor(hostOf(id));
        if (!peer) {
          deliveries.push({ target: label, disposition: "rejected", reason: "unknown_host" });
          continue;
        }
        const entry = peer._resolveLabel(callerGroups, label);
        if (!entry) {
          deliveries.push({ target: label, disposition: "rejected", reason: "unknown_session" });
          continue;
        }
        await peer._one(label, entry, body, deliveries, seen);
      }
    }
    return { message_id: messageId, deliveries };
  }

  async function oneDelivery(targetLabel, entry, body, deliveries, seen) {
    if (seen.has(entry.row.session_id)) return;
    seen.add(entry.row.session_id);
    const receipt = await deliverLocal(entry, body);
    if (receipt.disposition === "rejected") deliveries.push({ target: targetLabel, disposition: "rejected", reason: receipt.reason ?? "no_receipt" });
    else deliveries.push({ target: targetLabel, session_id: entry.row.session_id, delivery_id: randomID("delivery"), disposition: receipt.disposition });
  }

  // ---- lanes ----
  function laneEntry(caller, input, spawnHost) {
    // sessionbus@53c5f80 bus/internal/daemon/handlers.go:254-262 — lane name and groups
    const parentName = unqualify(caller.name ?? "");
    const composedName = `${parentName}/${input.name}`;
    const parentGroup = caller.private_group;
    const privateGroup = `${parentGroup}/${input.name}`;
    const groups = unique([parentGroup, privateGroup, ...(input.extra_groups ?? [])]);
    const policy = normalizePolicy(input, null, caller.session_id);
    const name = qualify(composedName, spawnHost); // handlers.go:268
    // D/lane.go:76 — the lane id is the worker's native id, qualified with this host
    const id = qualify(laneIdFor(input), spawnHost);
    return {
      peer: false,
      row: { session_id: id, product: input.product, name, groups, policy, open: input.open },
      owner: caller.session_id,
      connected: true,
      running: false,
      trace: input.trace,
      runs: [],
      generation: randomID("run"),
      sequence: 0,
      inbox: [],
      deadline: null,
      waiters: new Set(),
    };
  }

  function laneSpawnLocal(caller, input) {
    if (input.resume_session_id !== undefined) {
      // sessionbus@53c5f80 bus/internal/daemon/directory.go:182-210 reserveResume
      const previous = entries.get(input.resume_session_id);
      if (!previous || previous.peer || !shares(caller.groups, previous.row.groups)) throw new DaemonError(CODES.unknown_session);
      if (previous.connected) throw new DaemonError(CODES.already_connected);
      previous.row.policy = normalizePolicy(input, previous.row.policy, caller.session_id);
      previous.owner = caller.session_id;
      previous.connected = true;
      previous.running = false;
      previous.runs = [];
      previous.generation = randomID("run"); // SPEC:435-439 — a resume is a new generation without old answers
      previous.sequence = 0;
      if (input.trace !== undefined) previous.trace = input.trace;
      spawns.push({ caller: caller.session_id, params: input, session_id: previous.row.session_id, host });
      return spawnResult(previous);
    }
    // handlers.go:250-253
    if (!HOST_PATTERN.test(input.product) || !products[input.product]) throw new DaemonError(CODES.unknown_product);
    const entry = laneEntry(caller, input, host);
    // directory.go:170-172
    if ([...entries.values()].some((other) => other.row.name === entry.row.name)) throw new DaemonError(CODES.name_taken);
    entries.set(entry.row.session_id, entry);
    spawns.push({ caller: caller.session_id, params: input, session_id: entry.row.session_id, host });
    return spawnResult(entry);
  }

  // sessionbus@53c5f80 bus/internal/daemon/directory.go:282-301 — policy.trace filled for the parent ("off" if unset)
  function spawnResult(entry) {
    return { session_id: entry.row.session_id, policy: { ...entry.row.policy, trace: entry.trace ?? "off" } };
  }

  function runStatus(entry, record) {
    // sessionbus@53c5f80 bus/sdk/go/protocol RunStatus; SPEC:486-502
    const status = { session_id: entry.row.session_id, run_id: record.run_id, state: record.state };
    if (record.state === "done") status.result = { ...record.result };
    if (record.state === "unavailable") status.reason = record.reason;
    return status;
  }

  function settle(entry, record, state, value) {
    if (record.state !== "running") return;
    record.state = state;
    if (state === "done") record.result = { outcome: value.outcome ?? "completed", result: value.result ?? "", ...(value.truncated !== undefined ? { truncated: value.truncated } : {}) };
    else record.reason = value;
    entry.running = false;
    for (const waiter of [...entry.waiters]) if (waiter.record === record) waiter.resolve();
    const policy = entry.row.policy;
    // sessionbus@53c5f80 bus/internal/daemon/policy.go:183-185 — auto-close armed only on done
    if (state === "done" && policy.auto_close_ms > 0) {
      cancel(entry.deadline);
      entry.deadline = schedule(policy.auto_close_ms, () => closeLane(entry, false));
    }
    // sessionbus@53c5f80 bus/internal/daemon/policy.go:190-203 — completion pointer, sent as the lane itself
    if (policy.notify) {
      const target = policy.persistent ? policy.notify_target : policy.owner_session_id;
      if (target) {
        const from = selfInfo(entry);
        // The lane reaches its owner through the owner's private group, groups[0] (handlers.go:260-262).
        void routeSend(from, entry.row.groups, { target, message: completionPointer(entry.row.session_id, record.run_id, state) });
      }
    }
  }

  function startRun(entry, input) {
    // sessionbus@53c5f80 bus/internal/daemon/policy.go:130-141 reserveRun
    cancel(entry.deadline);
    entry.deadline = null;
    entry.sequence += 1;
    const record = { run_id: `${entry.generation}/${entry.sequence}`, input, state: "running", acked: false };
    entry.runs.push(record);
    entry.running = true;
    if (worker !== "manual") {
      setImmediate(async () => {
        let value;
        try {
          value = await worker(input, { session_id: entry.row.session_id, record });
        } catch (error) {
          settle(entry, record, "unavailable", String(error?.message || error) || "failed");
          return;
        }
        if (value !== undefined) settle(entry, record, "done", value);
      });
    }
    return record;
  }

  function closeLane(entry, forget) {
    // sessionbus@53c5f80 bus/internal/daemon/lane.go:114-121,224-231; SPEC:541-564 — results were only in the worker, gone after close
    cancel(entry.deadline);
    entry.deadline = null;
    entry.connected = false;
    entry.running = false;
    for (const record of entry.runs) if (record.state === "running") record.state = "closed";
    entry.runs = [];
    for (const waiter of [...entry.waiters]) waiter.reject(new DaemonError(CODES.not_connected));
    if (forget) entries.delete(entry.row.session_id);
  }

  function findRecord(entry, runId) {
    // sessionbus@53c5f80 bus/sdk/go/runs.go:132-192 — no run_id: oldest record not yet acked
    const record = runId === undefined ? entry.runs.find((r) => !r.acked) : entry.runs.find((r) => r.run_id === runId);
    if (!record || record.acked) throw new DaemonError(CODES.unknown_session);
    return record;
  }

  /**
   * Lookup for turn.* and session.close.
   * sessionbus@53c5f80 bus/internal/daemon/handlers.go:152-185, directory.go:446-472
   */
  function routeTarget(caller, sessionId) {
    const entry = entries.get(canonical(sessionId)) ?? resolveLabel(caller.groups, sessionId);
    if (!entry || !visible(caller.groups, entry) || entry.peer) throw new DaemonError(CODES.unknown_session);
    return entry;
  }

  // ---- built-in method handlers (dispatch: sessionbus@53c5f80 bus/internal/daemon/handlers.go:49-76) ----
  const builtins = {
    // handlers.go:101-150; federation.go:265-333 fan-out when unfiltered
    "session.list"(params, ctx) {
      const caller = ctx.caller;
      if (params.session_id !== undefined) {
        const id = canonical(params.session_id);
        const peer = daemonFor(hostOf(id));
        if (!peer) throw new DaemonError(CODES.unknown_host);
        const entry = peer._resolveLabel(caller.groups, params.session_id);
        if (!entry) throw new DaemonError(CODES.unknown_session); // handlers.go:134-140
        return { self_info: selfInfo(ctx.entry), sessions: [summary(entry)] };
      }
      let rows;
      if (params.host !== undefined && params.host !== host) {
        if (params.host === "local") throw new DaemonError(CODES.unknown_host); // handlers.go:114-117
        const peer = linked.get(params.host);
        if (!peer) throw new DaemonError(CODES.unknown_host); // federation.go:568-570
        rows = peer._localRows(caller.groups);
      } else if (params.host !== undefined) {
        rows = localRows(caller.groups);
      } else {
        rows = [host, ...linked.keys()].flatMap((h) => daemonFor(h)._localRows(caller.groups));
      }
      const result = { self_info: selfInfo(ctx.entry), sessions: rows.map(summary) };
      if (options.hosts) result.hosts = options.hosts.map((item) => ({ host: item.host, products: [...item.products] }));
      return result;
    },
    // handlers.go:286-365
    async "message.send"(params, ctx) {
      return routeSend(selfInfo(ctx.entry), ctx.caller.groups, params);
    },
    // handlers.go:187-208
    "lane.describe"(params) {
      if (params.host !== undefined && params.host !== host) {
        if (params.host === "local") throw new DaemonError(CODES.unknown_host);
        const peer = linked.get(params.host);
        if (!peer) throw new DaemonError(CODES.unknown_host);
        return peer._describe(params.product);
      }
      return describe(params.product);
    },
    // handlers.go:210-278
    "lane.spawn"(params, ctx) {
      const caller = ctx.caller;
      if (params.host !== undefined && params.host !== host) {
        if (params.host === "local") throw new DaemonError(CODES.unknown_host); // handlers.go:218-225
        const peer = linked.get(params.host);
        if (!peer) throw new DaemonError(CODES.unknown_host);
        const { host: _forwarded, ...rest } = params;
        return peer._spawn(caller, rest);
      }
      if (params.resume_session_id !== undefined) {
        const target = daemonFor(hostOf(params.resume_session_id)); // handlers.go:232-235
        if (!target) throw new DaemonError(CODES.unknown_host);
        return target._spawn(caller, params);
      }
      const { host: _local, ...rest } = params;
      return laneSpawnLocal(caller, rest);
    },
    // trace.go:51-82 — only the lane's direct parent may configure it
    "trace.configure"(params, ctx) {
      const peer = daemonFor(hostOf(canonical(params.session_id)));
      const entry = peer?._entries.get(canonical(params.session_id));
      if (!entry || entry.peer || entry.owner !== ctx.caller.session_id) throw new DaemonError(CODES.unknown_session);
      entry.trace = params.mode;
      return { session_id: entry.row.session_id, mode: params.mode };
    },
    "turn.start"(params, ctx) {
      return forTarget(ctx, params.session_id, (peer) => peer._start(ctx.caller, params, false));
    },
    "turn.run"(params, ctx) {
      return forTarget(ctx, params.session_id, (peer) => peer._start(ctx.caller, params, true));
    },
    "turn.status"(params, ctx) {
      return forTarget(ctx, params.session_id, (peer) => peer._status(ctx.caller, params));
    },
    "turn.wait"(params, ctx) {
      return forTarget(ctx, params.session_id, (peer) => peer._wait(ctx.caller, params, ctx.connection));
    },
    "turn.ack"(params, ctx) {
      return forTarget(ctx, params.session_id, (peer) => peer._ack(ctx.caller, params));
    },
    "turn.interrupt"(params, ctx) {
      return forTarget(ctx, params.session_id, (peer) => peer._interrupt(ctx.caller, params));
    },
    "session.close"(params, ctx) {
      return forTarget(ctx, params.session_id, (peer) => peer._close(ctx.caller, params));
    },
  };

  function forTarget(ctx, sessionId, fn) {
    const id = canonical(sessionId);
    const peer = daemonFor(hostOf(id));
    if (!peer) throw new DaemonError(CODES.unknown_host);
    return fn(peer);
  }

  function describe(product) {
    if (!HOST_PATTERN.test(product) || !products[product]) throw new DaemonError(CODES.unknown_product); // handlers.go:196-199
    const value = products[product];
    return { product, supported_open_fields: [...(value.supported_open_fields ?? [])], extra_arguments: [...(value.extra_arguments ?? [])], ...(value.version ? { version: value.version } : {}), ...(value.supports_message_run !== undefined ? { supports_message_run: value.supports_message_run } : {}) };
  }

  async function turnStart(caller, params, collect) {
    const entry = routeTarget(caller, params.session_id);
    if (!entry.connected) throw new DaemonError(CODES.not_connected); // directory.go:446-472
    if (entry.running) throw new DaemonError(CODES.busy); // directory.go:117-119
    if (entry.runs.filter((r) => !r.acked).length >= MAX_RUN_RECORDS) throw new DaemonError(CODES.busy);
    const record = startRun(entry, params.input);
    if (!collect) return { session_id: entry.row.session_id, run_id: record.run_id };
    // D/session.go:397-400 — turn.run = start + non-consuming wait
    await waitFor(entry, record, undefined, null);
    return runStatus(entry, record);
  }

  function waitFor(entry, record, timeoutMs, connection) {
    if (record.state !== "running") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        record,
        resolve: () => done(resolve),
        reject: (error) => done(() => reject(error)),
      };
      let timer = null;
      const onClose = () => done(() => reject(new DaemonError(CODES.not_connected)));
      function done(fn) {
        entry.waiters.delete(waiter);
        cancel(timer);
        connection?.stream.off?.("close", onClose);
        fn();
      }
      entry.waiters.add(waiter);
      if (timeoutMs !== undefined) timer = schedule(timeoutMs, () => done(resolve));
      connection?.stream.on?.("close", onClose);
    });
  }

  function turnStatus(caller, params) {
    const entry = routeTarget(caller, params.session_id);
    if (!entry.connected) throw new DaemonError(CODES.not_connected);
    return runStatus(entry, findRecord(entry, params.run_id));
  }

  async function turnWait(caller, params, connection) {
    const entry = routeTarget(caller, params.session_id);
    if (!entry.connected) throw new DaemonError(CODES.not_connected);
    const record = findRecord(entry, params.run_id);
    // runs.go:132-192 — blocks until terminal; with timeout_ms may return running
    await waitFor(entry, record, params.timeout_ms, connection);
    return runStatus(entry, record);
  }

  function turnAck(caller, params) {
    // sessionbus@53c5f80 bus/sdk/go/runs.go:194-214
    const entry = routeTarget(caller, params.session_id);
    if (!entry.connected) throw new DaemonError(CODES.not_connected);
    const record = entry.runs.find((r) => r.run_id === params.run_id);
    if (!record) throw new DaemonError(CODES.unknown_session);
    if (record.acked) return {};
    const oldest = entry.runs.find((r) => !r.acked);
    if (oldest !== record || record.state === "running") throw new DaemonError(CODES.busy);
    record.acked = true;
    entry.runs = entry.runs.filter((r) => r !== record);
    return {};
  }

  function turnInterrupt(caller, params) {
    const entry = routeTarget(caller, params.session_id);
    if (!entry.connected) throw new DaemonError(CODES.not_connected);
    // sessionbus@53c5f80 bus/sdk/go/worker.go:226-237 — no run → not_running
    const record = entry.runs.find((r) => r.state === "running");
    if (!record) throw new DaemonError(CODES.not_running);
    settle(entry, record, "done", { outcome: "interrupted", result: "" });
    return {};
  }

  function sessionClose(caller, params) {
    const entry = routeTarget(caller, params.session_id);
    // directory.go:380-388,399-429 — an offline row closes without a worker; forget deletes it
    closeLane(entry, Boolean(params.forget));
    return {};
  }

  // ---- connection handling ----
  function attach(stream) {
    attachedStreams.add(stream);
    stream.once("close", () => attachedStreams.delete(stream));
    const state = { stream, connection: null, entry: null, inflight: 0 };
    stream.setMaxListeners?.(0); // one close listener per blocked wait
    const connection = new Connection(stream, false, (request) => void handle(state, request));
    state.connection = connection;
    sessions.add(state);
    current = state;
    stream.on("close", () => detach(state));
    return state;
  }

  function detach(state) {
    if (!sessions.delete(state)) return;
    const entry = state.entry;
    if (entry && entry.attachment === state) {
      entries.delete(entry.row.session_id);
      // sessionbus@53c5f80 bus/internal/daemon/policy.go:97-113 endOwner — non-persistent lanes of an ended owner close
      for (const peer of [api, ...linked.values()]) {
        for (const lane of peer._entries.values()) {
          if (!lane.peer && lane.owner === entry.row.session_id && !lane.row.policy.persistent && lane.connected) peer._closeLane(lane, false);
        }
      }
    }
    if (current === state) current = [...sessions].at(-1) ?? null;
  }

  function writeRaw(state, frame) {
    if (!state.stream.destroyed) state.stream.write(`${JSON.stringify(frame)}\n`);
  }

  function reject(state, request, code) {
    // sessionbus@53c5f80 bus/internal/daemon/session.go:466-481 — error reply, then the connection closes
    void state.connection.error(request, code).finally(() => state.connection.close());
  }

  async function handle(state, request) {
    const { method, params } = request;
    requests.push({ method, params, session_id: state.entry?.row.session_id ?? null });
    if (method === "session.hello") return hello(state, request);
    // sessionbus@53c5f80 bus/internal/daemon/session.go:237-240 — first frame must be a hello
    if (!state.entry) return reject(state, request, CODES.invalid_hello);
    if (!builtins[method] && !methods[method]) return reject(state, request, CODES.invalid_frame); // handlers.go:74-75
    if (method === "session.list") lists.push(params);
    if (method === "message.send") sends.push(params);
    // handlers.go:33-45 — MaxOperations in-flight → busy
    if (state.inflight >= MAX_OPERATIONS) return void state.connection.error(request, CODES.busy);
    state.inflight += 1;
    const entry = state.entry;
    const ctx = {
      method,
      connection: state.connection,
      entry,
      caller: { session_id: entry.row.session_id, name: entry.row.name, groups: entry.row.groups, private_group: `session:${entry.row.session_id}` },
      next: () => (builtins[method] ? builtins[method](params, ctx) : Promise.reject(new DaemonError(CODES.invalid_frame))),
    };
    try {
      const override = methods[method] ?? legacy(method);
      const value = await (override ? override(params, ctx) : builtins[method](params, ctx));
      if (value && typeof value === "object" && Object.hasOwn(value, RAW)) writeRaw(state, { jsonrpc: "2.0", id: request.id, result: value[RAW] });
      else await write(() => state.connection.result(request, value));
    } catch (error) {
      if (state.connection.signal.aborted) return;
      if (error instanceof DaemonError) {
        if (error.code === CODES.invalid_frame) return reject(state, request, error.code);
        await write(() => state.connection.error(request, error.code, error.code === CODES.internal ? String(error.data ?? "internal") : error.data)).catch(() => {});
      } else {
        await write(() => state.connection.error(request, CODES.internal, String(error?.message || error) || "internal")).catch(() => {});
      }
    } finally {
      state.inflight -= 1;
    }
  }

  function legacy(method) {
    if (method === "session.list" && scripted.list !== undefined) return (params) => (typeof scripted.list === "function" ? scripted.list(params) : scripted.list);
    if (method === "message.send" && scripted.send !== undefined) return (params) => (typeof scripted.send === "function" ? scripted.send(params) : scripted.send);
    return null;
  }

  function hello(state, request) {
    hellos.push(request.params);
    if (scripted.helloError) {
      void state.connection.error(request, scripted.helloError.code, scripted.helloError.data);
      return;
    }
    const params = request.params;
    // sessionbus@53c5f80 bus/internal/daemon/directory.go:57-92 installPeer; helpers.go:81-87 private group appended
    const id = qualify(params.session_id, host);
    const existing = entries.get(id);
    if (existing && !existing.peer) return reject(state, request, CODES.invalid_hello);
    if (existing?.attachment === state &&
        (existing.row.product !== params.product ||
         JSON.stringify(existing.row.groups.filter((group) => group !== `session:${id}`)) !== JSON.stringify(params.groups ?? []))) {
      return reject(state, request, CODES.invalid_hello);
    }
    if (existing?.attachment && existing.attachment !== state) {
      // A newer connection for the same identity supersedes the old one (SPEC:167).
      const displaced = existing.attachment;
      existing.attachment = null;
      void displaced.connection.call("session.superseded", {}).catch(() => {});
    }
    const privateGroup = `session:${id}`;
    const groups = (params.groups ?? []).includes(privateGroup) ? [...params.groups] : [...(params.groups ?? []), privateGroup];
    const entry = { peer: true, row: { session_id: id, product: params.product, name: qualify(params.name ?? "", host), groups }, info: params.info, attachment: state };
    entries.set(id, entry);
    state.entry = entry;
    // The peer may already be gone (plugin stopped before its hello completed): nobody awaits this write.
    state.connection.result(request, {}).catch(() => {});
  }

  function flush() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  // kit sdk/js/connection.js:53 caps a Connection at 256 queued writes and rejects the next with busy.
  // The real daemon writes through its own bounded writer (D/session.go), so a burst of replies is
  // never dropped there; the fake waits for the queue to drain instead of losing a reply.
  async function write(send) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
      } catch (error) {
        if (error?.code !== CODES.busy || attempt >= 1000) throw error;
        await flush();
      }
    }
  }

  const api = {
    host,
    hellos,
    sends,
    lists,
    spawns,
    requests,
    connects,
    CODES,
    /** In-memory client stream (pass as the peer's `connect` dependency). */
    connect(path) {
      connects.push(path);
      const [clientStream, serverStream] = pair();
      attach(serverStream);
      return clientStream;
    },
    /** Listen on a real unix socket, for code that dials the daemon itself. */
    async listen(path) {
      try {
        fs.unlinkSync(path);
      } catch {}
      server = net.createServer((socket) => {
        connects.push(path);
        attach(socket);
      });
      await new Promise((resolve, reject) => server.listen(path, resolve).once("error", reject));
      return path;
    },
    /** Stop listening and drop every connection (daemon down). */
    async close() {
      for (const state of [...sessions]) state.connection.close();
      for (const stream of [...attachedStreams]) stream.destroy();
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    },
    /** Link two fake daemons as one federation (host forwarding for list/send/spawn/turn.*). */
    link(other) {
      linked.set(other.host, other);
      other._linked.set(host, api);
    },
    /** Issue a daemon-initiated `message.deliver` on the most recent connection. */
    async deliver(params, signal) {
      if (!current) throw new Error("fake daemon has no active connection");
      return current.connection.call("message.deliver", params, signal);
    },
    /** Issue a `message.deliver` to the connection that said hello as `sessionId` (bare or qualified). */
    async deliverTo(sessionId, params, signal) {
      const entry = entries.get(canonical(sessionId));
      if (!entry?.attachment) throw new Error(`fake daemon has no connection for ${sessionId}`);
      return entry.attachment.connection.call("message.deliver", params, signal);
    },
    /** Simulate the connection dying under the client (e.g. daemon restart). */
    drop() {
      if (!current) return;
      current.stream.destroy();
    },
    /**
     * Simulate the daemon closing this identity as superseded by another connection. Since
     * sessionbus v0.5.10 (#103) the JS peer closes without writing its reply, so none is awaited.
     */
    async supersede() {
      if (!current) throw new Error("fake daemon has no active connection");
      void current.connection.call("session.superseded", {}).catch(() => {});
    },
    /** Visible session rows as the daemon would list them for `groups` on this host only. */
    rows(groups) {
      return localRows(groups).map(summary);
    },
    /** A lane's state for assertions and control. */
    lane(sessionId) {
      const entry = entries.get(canonical(sessionId));
      if (!entry || entry.peer) return undefined;
      return {
        row: summary(entry),
        owner: entry.owner,
        trace: entry.trace,
        inbox: entry.inbox,
        runs: entry.runs.map((r) => ({ run_id: r.run_id, input: r.input, state: r.state, acked: r.acked, result: r.result, reason: r.reason })),
      };
    },
    /** Complete the lane's running run (`worker: "manual"`). */
    async finish(sessionId, value = { outcome: "completed", result: "" }) {
      const entry = entries.get(canonical(sessionId));
      const record = entry?.runs.find((r) => r.state === "running");
      if (!record) throw new Error(`no running run on ${sessionId}`);
      settle(entry, record, "done", value);
      await flush();
      return record.run_id;
    },
    /** End the lane's running run as `unavailable` (product error, SDK/runs.go:84-97). */
    async unavailable(sessionId, reason = "product failed") {
      const entry = entries.get(canonical(sessionId));
      const record = entry?.runs.find((r) => r.state === "running");
      if (!record) throw new Error(`no running run on ${sessionId}`);
      settle(entry, record, "unavailable", reason);
      await flush();
      return record.run_id;
    },
    /** Advance the daemon's virtual clock (auto-close deadlines, wait timeout_ms). */
    advance,
    now: () => now,
    // ---- federation internals (used by a linked fake daemon) ----
    _entries: entries,
    _linked: linked,
    _localRows: localRows,
    _resolveLabel: resolveLabel,
    _one: oneDelivery,
    _describe: describe,
    _spawn: laneSpawnLocal,
    _start: turnStart,
    _status: turnStatus,
    _wait: turnWait,
    _ack: turnAck,
    _interrupt: turnInterrupt,
    _close: sessionClose,
    _closeLane: closeLane,
  };
  return api;
}

export { ProtocolError };
