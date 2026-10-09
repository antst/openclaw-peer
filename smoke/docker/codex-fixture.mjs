// Fake OpenAI Responses API for the real `codex app-server` (Amendment 2(a)): the codex harness of OpenClaw runs
// unmodified, only the model behind it is this fixture. Wire per OpenClaw's own sandbox test
// (extensions/codex/src/app-server/transport-stdio.sandbox.test.ts): POST /v1/responses, SSE events
// response.created -> response.output_item.done -> response.completed{usage}.
//
// Behaviour, from the user-authored part of the request (`input`, never `instructions` or `tools`):
//   "SLOW <tag>" in the input and no tool output yet -> one function_call exec_command `sleep <SLOW_SECONDS>`:
//        the agent is demonstrably busy with a native tool while the test sends its second message;
//   a tool output present, INJECT-MARK after the last SLOW -> text SAW-INJECT (the steered message reached the model
//        at the next model boundary; `turn=same` when that chain had no final yet, `turn=followup` after it);
//   a tool output present, no INJECT-MARK -> text DONE-NO-INJECT;
//   anything else -> text ECHO: <tail of the input>.
// Logs (stdout), read by the smoke clauses: `codex-fixture: req n=.. ua=.. auth=.. tool_output=.. slow=.. sawInject=.. turn=same|followup|new codex=yes|no`,
// `codex-fixture: tool-call n=..`, `codex-fixture: reply n=.. <text>`; the first requests' bodies are dumped as
// `codex-fixture: body n=.. <json>` (the probe reads the steer item's shape there).
import http from "node:http";
import { pathToFileURL } from "node:url";

const port = Number(process.env.CODEX_FIXTURE_PORT ?? 8001);
const slowSeconds = Number(process.env.CODEX_FIXTURE_SLOW_SECONDS ?? 12);
const deltas = process.env.CODEX_FIXTURE_DELTAS === "1"; // probe: also emit output_item.added / output_text.delta
const dumpFirst = Number(process.env.CODEX_FIXTURE_DUMP ?? 8);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid CODEX_FIXTURE_PORT");
let sequence = 0;

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

// Per-chain state, so a steered message (same turn) can be told from a followup turn (CR-X1-1): every tool call the
// fixture issues opens a chain; a later request that carries that call's output continues it. While the chain has not
// had its final text the request is the SAME turn; after the final it is a FOLLOWUP (its history replays the old output).
const chains = new Map(); // call_id -> {finalized}

function outputCallIds(body) {
  const items = Array.isArray(body.input) ? body.input : [];
  return items.filter((item) => item?.type === "function_call_output" && typeof item.call_id === "string").map((item) => item.call_id);
}

// Is this request from the managed codex app-server of the codex harness? The managed binary identifies itself as
// `openclaw/<codex version> (<os>; <arch>) ...` (seen on 8.2: `openclaw/0.151.0 (Debian 12.0.0; aarch64) unknown
// (openclaw; 2026.8.2)`, on 9.8: `openclaw/0.158.0 ...`) and sends the fixture's dummy bearer. Both must hold: a request
// with another user agent, or without the fixture's key, is not counted as codex evidence.
export const CODEX_UA = /^openclaw\/0\.\d+\.\d+ \(/;
export function isCodexRequest(userAgent, authorization) {
  return CODEX_UA.test(String(userAgent ?? "")) && /^Bearer fixture/.test(String(authorization ?? ""));
}

function decide(body) {
  // Only the conversation input counts: instructions/tools of the agent may mention SLOW or INJECT-MARK.
  const input = JSON.stringify(body.input ?? "");
  const toolOutput = /"type":"function_call_output"/.test(input);
  const slowAt = input.lastIndexOf("SLOW ");
  const injectAt = input.lastIndexOf("INJECT-MARK");
  const slow = slowAt >= 0;
  const sawInject = slow && injectAt > slowAt;
  const known = outputCallIds(body).filter((id) => chains.has(id));
  const chain = known.at(-1);
  const turn = !toolOutput ? "new" : chain && !chains.get(chain).finalized ? "same" : "followup";
  if (slow && !toolOutput) return { kind: "tool", slow, sawInject, toolOutput, turn };
  if (slow && toolOutput) {
    if (chain) chains.get(chain).finalized = true;
    return { kind: "text", text: sawInject ? "SAW-INJECT" : "DONE-NO-INJECT", slow, sawInject, toolOutput, turn };
  }
  return { kind: "text", text: `ECHO: ${input.slice(-160)}`, slow, sawInject, toolOutput, turn };
}

function respond(response, n, decision) {
  const id = `resp-fixture-${n}`;
  const events = [{ type: "response.created", response: { id } }];
  let item;
  if (decision.kind === "tool") {
    chains.set(`call-fixture-${n}`, { finalized: false });
    item = {
      type: "function_call",
      call_id: `call-fixture-${n}`,
      name: "exec_command",
      arguments: JSON.stringify({ cmd: `sleep ${slowSeconds}`, shell: "/bin/sh", login: false, max_output_tokens: 1000 }),
    };
    console.log(`codex-fixture: tool-call n=${n} sleep=${slowSeconds}`);
  } else {
    item = { type: "message", role: "assistant", id: `msg-fixture-${n}`, content: [{ type: "output_text", text: decision.text }] };
    console.log(`codex-fixture: reply n=${n} ${JSON.stringify(decision.text.slice(0, 80))}`);
    if (deltas) {
      events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
      events.push({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: decision.text });
    }
  }
  events.push({ type: "response.output_item.done", output_index: 0, item });
  events.push({ type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  response.end(sse(events));
}

// Importable for the unit test (isCodexRequest); the server starts only when run as a script.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  http.createServer(async (request, response) => {
    if (request.method === "GET" && /\/models$/.test(request.url)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      console.log(`codex-fixture: unhandled ${request.method} ${request.url}`);
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
    const n = ++sequence;
    const decision = decide(body);
    console.log(`codex-fixture: req n=${n} ua=${JSON.stringify(request.headers["user-agent"] ?? "")} auth=${JSON.stringify(String(request.headers.authorization ?? "").slice(0, 14))} tool_output=${decision.toolOutput} slow=${decision.slow} sawInject=${decision.sawInject} turn=${decision.turn} codex=${isCodexRequest(request.headers["user-agent"], request.headers.authorization) ? "yes" : "no"}`);
    if (n <= dumpFirst || raw.includes("INJECT-MARK")) console.log(`codex-fixture: body n=${n} ${JSON.stringify({ ...body, instructions: undefined, tools: undefined }).slice(0, 6000)}`);
    respond(response, n, decision);
  }).listen(port, "0.0.0.0", () => console.log(`codex-fixture: listening ${port} slow=${slowSeconds}s deltas=${deltas}`));
}
