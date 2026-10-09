// Local OpenAI-compatible fixture. SLOW keeps a turn active (30 s of ticks), EXEC:<cmd> requests the exec tool,
// SBSEND:<target> <text> requests the sessionbus tool (action send), and other prompts echo their model and text.
// A message steered into a running turn arrives as the last user message of the turn's next model call, so the
// echo of that call (`ECHO[model=..]: ...INJECT-MARK...`) is the evidence that it reached the run. Full requests are logged for smoke assertions.
import http from "node:http";
import fs from "node:fs";
import { lastUserMessage, text } from "./last-user.mjs";

const log = (entry) => fs.appendFileSync("/log/requests.jsonl", JSON.stringify(entry) + "\n");

http.createServer(async (req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) raw += chunk;
  if (req.url.endsWith("/models")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: ["mock-a", "mock-b"].map((id) => ({ id })) }));
    return;
  }
  let body;
  try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400); res.end(); return; }
  const messages = body.messages ?? [];
  // lastUserMessage skips <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> blocks from 9.5+.
  const last = lastUserMessage(messages);
  const toolResult = messages.filter((message) => message.role === "tool").at(-1);
  log({ model: body.model, lastUser: last, messages, thinking: body.reasoning_effort ?? body.reasoning?.effort ?? body.thinking ?? null, toolResult: !!toolResult });
  const command = last.match(/EXEC:(.+)$/m)?.[1]?.trim();
  const sbsend = last.match(/SBSEND:(\S+)\s+(\S+)/);
  const call = toolResult ? null
    : command ? { id: `call_${Date.now()}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ command }) } }
    : sbsend ? { id: `call_${Date.now()}`, type: "function", function: { name: "sessionbus", arguments: JSON.stringify({ action: "send", arguments: { target: sbsend[1], message: sbsend[2] } }) } }
    : null;
  const answer = toolResult ? `TOOL-DONE: ${text(toolResult).slice(0, 1000)}` : `ECHO[model=${body.model}]: ${last.slice(-500)}`;
  const id = `cmpl-${Date.now()}`;
  const base = { id, model: body.model, created: Math.floor(Date.now() / 1000) };
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, finish_reason: call ? "tool_calls" : "stop", message: call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: answer } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (call) { send({ role: "assistant", tool_calls: [{ index: 0, ...call }] }); send({}, "tool_calls"); }
  else if (/SLOW/.test(last)) {
    send({ role: "assistant", content: "" });
    for (let n = 0; n < 30 && !res.destroyed; n++) {
      send({ content: `tick${n} ` });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!res.destroyed) send({}, "stop");
  } else { send({ role: "assistant", content: answer }); send({}, "stop"); }
  if (!res.destroyed) res.end("data: [DONE]\n\n");
}).listen(8000, "0.0.0.0");
