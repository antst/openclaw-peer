// `/sessionbus` chat command: roster, status, help for the owner, answered by the host without a model turn.
import { readFileSync } from "node:fs";
import kit from "@sessionbus/kit";
import { resolveService } from "./active.js";

const { ProtocolError } = kit;

const MAX_ROWS = 40;
const MAX_CELL = 40;
const MAX_ERROR = 200;
/** How long roster/status wait for the whole federation before answering with this host only. */
const LIST_TIMEOUT_MS = 5_000;

const SUBCOMMANDS = ["roster", "status", "help"];

const HELP_LINES = [
  "**sessionbus**",
  "- /sessionbus roster — peers on the bus",
  "- /sessionbus status — this agent's connection",
  "- /sessionbus help — this help",
];

const MENU_BUTTONS = [
  ["👥 Roster", "roster"],
  ["📡 Status", "status"],
  ["❓ Help", "help"],
];

// Telegram marks a pressed command button native, and the host skips plugin commands for native turns
// (a model turn runs instead); a callback button goes to the interactive handler below, which resubmits the text.
function buildMenu(channel) {
  const action = (sub) => (channel === "telegram"
    ? { type: "callback", value: `sessionbus:${sub}` }
    : { type: "command", command: `/sessionbus ${sub}` });
  return {
    title: "sessionbus",
    blocks: [
      { type: "text", text: "/sessionbus roster · status · help" },
      { type: "buttons", buttons: MENU_BUTTONS.map(([label, sub]) => ({ label, action: action(sub) })) },
    ],
  };
}

const MENU_TEXT = ["**sessionbus**", ...SUBCOMMANDS.map((sub) => `/sessionbus ${sub}`)].join("\n");

const STATE_ICON = { idle: "○ idle", running: "● running", disconnected: "✕ disconnected" };

/** Bus values are untrusted text: control characters and line breaks become spaces. */
function clean(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeMarkdown(text) {
  return text.replace(/[\\|*_`[\]<>]/g, (char) => `\\${char}`);
}

/** A cell or inline value from the bus: cleaned, cut to `max`, markdown-escaped. */
function cell(value, max = MAX_CELL) {
  return escapeMarkdown(truncate(clean(value), max));
}

function hostOf(sessionId) {
  if (typeof sessionId !== "string") return undefined;
  const at = sessionId.lastIndexOf("@");
  return at >= 0 ? sessionId.slice(at + 1) : undefined;
}

function participantName(row) {
  const host = hostOf(row.session_id);
  const fromId = typeof row.session_id === "string" && host !== undefined ? row.session_id.slice(0, row.session_id.lastIndexOf("@")) : row.session_id;
  const suffix = host === undefined ? "" : `@${host}`;
  const name = typeof row.name === "string" && row.name ? (suffix && row.name.endsWith(suffix) ? row.name.slice(0, -suffix.length) : row.name) : fromId;
  return name;
}

function stateOf(row) {
  if (row.connected === false) return STATE_ICON.disconnected;
  return row.running ? STATE_ICON.running : STATE_ICON.idle;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The bus error message, prefixed with its code for a daemon ProtocolError only (as tool.js formatError). */
function errorDetail(error) {
  const message = error?.message || error;
  return cell(error instanceof ProtocolError ? `${error.code}: ${message}` : message, MAX_ERROR);
}

function errorText(error) {
  return `sessionbus: bus unavailable: ${errorDetail(error)}`;
}

function renderRoster(agentId, listResult) {
  const selfId = listResult?.self_info?.session_id;
  const selfHost = hostOf(selfId);
  const sessions = Array.isArray(listResult?.sessions) ? listResult.sessions : [];

  const rows = sessions
    .map((row) => ({
      row,
      host: hostOf(row.session_id) ?? "?",
      isLane: row.kind === "lane",
      name: participantName(row),
    }))
    .sort((a, b) =>
      (b.host === selfHost) - (a.host === selfHost)
      || compareText(a.host, b.host)
      || a.isLane - b.isLane
      || compareText(a.name, b.name));

  const lines = [`**sessionbus roster** · ${cell(agentId)} · ${sessions.length} sessions`];
  if (!rows.length) return lines.join("\n");

  lines.push("", "| HOST | KIND | STATE | PRODUCT | NAME |", "|---|---|---|---|---|");
  for (const { row, host, name } of rows.slice(0, MAX_ROWS)) {
    const me = selfId !== undefined && row.session_id === selfId ? " (self)" : "";
    lines.push(`| ${cell(host)} | ${cell(row.kind ?? "?")} | ${stateOf(row)} | ${cell(row.product)} | ${cell(name)}${me} |`);
  }
  if (rows.length > MAX_ROWS) lines.push("", `… +${rows.length - MAX_ROWS} more`);
  return lines.join("\n");
}

/** The package's own build record (src/build-info.json, written by prepack); absent for a source checkout. */
function loadBuild() {
  const read = (relative) => {
    try {
      return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
    } catch {
      return null;
    }
  };
  return { version: read("../package.json")?.version, ...read("./build-info.json") };
}

function pluginLine(build) {
  const version = cell(build.version ?? "?");
  if (typeof build.release !== "string" || typeof build.revision !== "string") return `- plugin: ${version} (build unknown)`;
  const revision = cell(build.revision.slice(0, 12));
  return build.release.startsWith("v")
    ? `- plugin: ${cell(build.release)} (${revision})`
    : `- plugin: ${version} ${cell(build.release)} (${revision})`;
}

function renderStatus(agentId, binding, runtime, connection, build) {
  const info = connection.result?.self_info;
  const id = info?.session_id ?? `openclaw-${agentId}`;
  const name = binding?.name ?? info?.name ?? agentId;
  const groups = binding?.groups ?? info?.groups ?? [];
  const sessions = Array.isArray(connection.result?.sessions) ? connection.result.sessions.length : undefined;
  return [
    `**sessionbus status** · ${cell(agentId)}`,
    `- session: ${cell(id, MAX_ERROR)} · ${connection.error ? `error: ${errorDetail(connection.error)}` : "connected"}`,
    `- name: ${cell(name)}`,
    `- groups: ${groups.length ? groups.map((group) => cell(group)).join(", ") : "—"}`,
    `- sessions: ${sessions ?? "—"}${connection.incomplete ? ` (this host only; other hosts did not answer within ${connection.listTimeoutMs / 1000} s)` : ""}`,
    pluginLine(build),
    `- OpenClaw: ${cell(runtime?.version ?? "—")}`,
  ].join("\n");
}

/** `registeredService` is this load's service; the started one (maybe from another load) answers. */
export function createSessionbusCommand(registeredService, { buildInfo, listTimeoutMs = LIST_TIMEOUT_MS } = {}) {
  return {
    name: "sessionbus",
    description: "Sessionbus: roster, status, help",
    acceptsArgs: true,
    requiredScopes: ["operator.read"],
    async handler(ctx) {
      try {
        if (ctx?.senderIsOwner !== true) return { text: "sessionbus: owner only", isError: true };

        const word = String(ctx.args ?? "").trim().split(/\s+/)[0].toLowerCase();
        if (!word) return { text: MENU_TEXT, presentation: buildMenu(ctx.channel), presentationTextMode: "fallback" };
        if (word === "help") return { text: HELP_LINES.join("\n") };
        if (word !== "roster" && word !== "status") {
          return { text: [`sessionbus: unknown subcommand "${cell(word)}"`, ...HELP_LINES].join("\n") };
        }

        const agentId = ctx.agentId;
        const service = resolveService(registeredService);
        if (!service.started) return { text: "sessionbus: plugin not started", isError: true };
        const peer = service.peerFor(agentId);
        if (!peer) {
          return { text: `sessionbus: agent ${cell(agentId)} not connected (plugins.entries.sessionbus.config.agents.${cell(agentId)}.enabled)`, isError: true };
        }

        let result;
        let error;
        let incomplete = false;
        const listSignal = AbortSignal.timeout(listTimeoutMs);
        try {
          result = await peer.action("list", {}, listSignal);
        } catch (caught) {
          error = caught;
          if (listSignal.aborted && caught === listSignal.reason) {
            try {
              // A bare session ID routes locally and bypasses federation aggregation.
              // Sessionbus v0.5.12 daemon/handlers.go:103-122, helpers.go:48-55.
              const localSignal = AbortSignal.timeout(listTimeoutMs);
              const self = await peer.action("list", { session_id: `openclaw-${agentId}` }, localSignal);
              const host = hostOf(self?.self_info?.session_id);
              if (!host) throw caught;
              result = await peer.action("list", { host }, localSignal);
              error = undefined;
              incomplete = true;
            } catch (localError) {
              error = localError;
            }
          }
        }
        if (word === "roster") return error ? { text: errorText(error), isError: true } : {
          text: renderRoster(agentId, result) + (incomplete ? `\n\nincomplete: other hosts did not answer within ${listTimeoutMs / 1000} s` : ""),
        };
        return { text: renderStatus(agentId, service.bindingFor(agentId), service.runtime, { result, error, incomplete, listTimeoutMs }, buildInfo === undefined ? loadBuild() : { version: loadBuild().version, ...buildInfo }) };
      } catch (error) {
        return { text: errorText(error), isError: true };
      }
    },
  };
}

/** Telegram menu button press: resubmit `/sessionbus <sub>` as text, the command itself checks the owner. */
export function createSessionbusInteractiveHandler() {
  return {
    channel: "telegram",
    namespace: "sessionbus",
    async handler(ctx) {
      const sub = String(ctx?.callback?.payload ?? "").trim().toLowerCase();
      return SUBCOMMANDS.includes(sub) ? { submitText: `/sessionbus ${sub}` } : { handled: true };
    },
  };
}
