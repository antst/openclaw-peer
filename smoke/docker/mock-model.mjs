import http from "node:http";
import { bodyOf, realUsers } from "./mock-select.mjs";

const port = Number(process.env.MOCK_MODEL_PORT ?? 8000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid MOCK_MODEL_PORT");
let sequence = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reply(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

// Behaviour, driven by the user texts of the request:
//   "SLOW" in the last user text  -> stream ~15 s of ticks (the "agent is working" evidence); the line
//                                    `mock-model: boundary n=<n>` is printed 500 ms before the last chunk;
//   INJECT-MARK after the last SLOW -> the reply is SAW-INJECT (the message reached the model);
//   "Smoke check: call sessionbus list" -> one sessionbus tool call, then a plain reply;
//   anything else -> ECHO of the last user text.
// Every request logs `mock-model: req n=.. users=.. slow=.. sawInject=.. body=<json> tools=sessionbus|none` — the smoke clauses read these.
async function completion(request, response, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Only user-authored text counts (see mock-select.mjs): never the runtime-context messages OpenClaw adds.
  const users = realUsers(messages);
  const last = users.at(-1) ?? "";
  const lastBody = bodyOf(last);
  const slowIndex = users.findLastIndex((user) => /SLOW/.test(bodyOf(user)));
  const injectIndex = users.findLastIndex((user) => bodyOf(user).includes("INJECT-MARK"));
  const slow = slowIndex >= 0 && slowIndex === users.length - 1;
  const sawInject = slowIndex >= 0 && injectIndex > slowIndex;
  const toolResult = messages.some((message) => message.role === "tool" || message.role === "function");
  const toolOffered = Array.isArray(body.tools) && body.tools.some((tool) => tool.function?.name === "sessionbus" || tool.name === "sessionbus");
  const n = ++sequence;
  console.log(`mock-model: chat tools=${toolOffered ? "sessionbus" : "none"} tool_result=${toolResult}`);
  console.log(`mock-model: req n=${n} users=${users.length} slow=${slow} sawInject=${sawInject} body=${JSON.stringify(lastBody.slice(0, 300))} tools=${toolOffered ? "sessionbus" : "none"}`);
  if (toolResult) {
    console.log("mock-model: tool-result request");
    console.log(`mock-model: tool-result n=${n} body=${JSON.stringify(lastBody.slice(0, 300))}`);
  }
  const id = `chatcmpl-smoke-${n}`;
  const callId = `call-smoke-${n}`;
  const wantTool = toolOffered && !toolResult && /Smoke check: call sessionbus list/.test(lastBody);
  const toolCalls = wantTool ? [{ id: callId, type: "function", function: { name: "sessionbus", arguments: '{"action":"list","arguments":{}}' } }] : undefined;
  const text = sawInject ? "SAW-INJECT" : slow ? "" : toolCalls ? "" : toolResult ? "Sessionbus smoke complete." : `ECHO: ${lastBody.slice(-80)}`;
  const message = toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: text };
  const finishReason = toolCalls ? "tool_calls" : "stop";
  const base = { id, created: Math.floor(Date.now() / 1000), model: "mock-model" };

  if (!body.stream) {
    reply(response, 200, { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const chunk = (delta, reason = null) => response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  chunk({ role: "assistant" });
  if (toolCalls) chunk({ tool_calls: [{ index: 0, ...toolCalls[0] }] });
  else if (slow && !sawInject) {
    let closed = false;
    request.on("close", () => { closed = true; });
    console.log(`mock-model: stream n=${n} start`);
    for (let i = 0; i < 14 && !closed; i++) {
      chunk({ content: `tick${i} ` });
      await sleep(1000);
    }
    if (!closed) {
      console.log(`mock-model: boundary n=${n}`);
      await sleep(500);
      chunk({ content: "tick14 " });
    }
    console.log(`mock-model: stream n=${n} end closed=${closed}`);
  } else chunk({ content: text });
  chunk({}, finishReason);
  response.end("data: [DONE]\n\n");
}

http.createServer(async (request, response) => {
  console.log(`mock-model: request ${request.method} ${request.url}`);
  if (request.method === "GET" && request.url === "/v1/models") {
    reply(response, 200, { object: "list", data: [{ id: "mock-model", object: "model", created: 0, owned_by: "smoke" }] });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    reply(response, 404, { error: { message: "not found", type: "invalid_request_error" } });
    return;
  }
  try {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    await completion(request, response, JSON.parse(raw));
  } catch (error) {
    if (!response.headersSent) reply(response, 400, { error: { message: error.message, type: "invalid_request_error" } });
    else response.end();
  }
}).listen(port, "0.0.0.0", () => console.log(`mock-model: listening ${port}`));
