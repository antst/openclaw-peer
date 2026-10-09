// The F1a smoke mock must see what the agent was actually asked: OpenClaw wraps every turn with runtime-generated
// user messages (8.2: "OpenClaw runtime context for the active user request ..."; 9.x: an internal-context block).
// Those must never be mistaken for the sender's text, and the sender's text must never be lost behind them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bodyOf, realUsers } from "../smoke/docker/mock-select.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "smoke", "docker");
const RUNTIME = "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context.\nThis context is runtime-generated, not user-authored.\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret metadata SLOW EXEC\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const envelope = (text) => `<cross-session-message from="s" from-session="s@h">\n[sessionbus-metadata: {"messageId":"m1"}]\n${text}\n</cross-session-message>\nReply only if needed, with the sessionbus tool: {}`;

test("a runtime-context user message is not user input (8.2 shape)", () => {
  const users = realUsers([{ role: "user", content: envelope("SLOW busy-mid") }, { role: "user", content: RUNTIME }]);
  assert.deepEqual(users.map(bodyOf), ["SLOW busy-mid"]);
});

test("an internal-context block inside the user message is stripped, the sender's text stays (9.x shape)", () => {
  const content = `hello /status\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nSLOW hidden\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
  assert.deepEqual(realUsers([{ role: "user", content }]), ["hello /status"]);
  // An unterminated block is dropped to the end rather than leaking its text.
  assert.deepEqual(realUsers([{ role: "user", content: "real\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nSLOW" }]), ["real"]);
});

test("text that only the runtime context carries never counts: SLOW/tool/slash triggers inside it are invisible", () => {
  assert.deepEqual(realUsers([{ role: "user", content: RUNTIME }, { role: "assistant", content: "SLOW" }]), []);
  assert.deepEqual(realUsers([{ role: "user", content: [{ type: "text", text: RUNTIME }] }]), []);
});

test("content parts are joined and the envelope body is extracted verbatim (slash text included)", () => {
  const users = realUsers([{ role: "user", content: [{ type: "text", text: envelope("/status") }] }]);
  assert.deepEqual(users.map(bodyOf), ["/status"]);
  assert.equal(bodyOf("plain TG-SIM text"), "plain TG-SIM text");
});

/** Runs the real mock on a free port and posts non-streaming requests. */
async function withMock(t, fn) {
  const port = 20000 + (process.pid % 20000);
  const child = spawn(process.execPath, [path.join(DIR, "mock-model.mjs")], { env: { ...process.env, MOCK_MODEL_PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill());
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock did not start")), 5000);
    child.stdout.on("data", () => { if (log.includes("listening")) { clearTimeout(timer); resolve(); } });
  });
  const post = async (messages, extra = {}) => (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ stream: false, messages, ...extra }) })).json();
  await fn(post, () => log);
}

test("the mock reacts to the sender's text behind the runtime-context message, and logs what it saw", async (t) => {
  await withMock(t, async (post, log) => {
    const ctx = { role: "user", content: RUNTIME };
    // INJECT after SLOW: the history of a steered run.
    const reply = await post([{ role: "user", content: envelope("SLOW x") }, ctx, { role: "user", content: envelope("INJECT-MARK x") }, ctx]);
    assert.equal(reply.choices[0].message.content, "SAW-INJECT");
    // Tool trigger only from the real text.
    const tool = await post([{ role: "user", content: envelope("Smoke check: call sessionbus list, then finish.") }, ctx], { tools: [{ function: { name: "sessionbus" } }] });
    assert.equal(tool.choices[0].message.tool_calls[0].function.name, "sessionbus");
    // The runtime context alone carries SLOW/EXEC words: no trigger, plain echo of the real text.
    const echo = await post([{ role: "user", content: envelope("/status") }, ctx]);
    assert.match(echo.choices[0].message.content, /^ECHO: \/status$/);
    const lines = log().split("\n").filter((line) => line.includes("mock-model: req n="));
    assert.match(lines[0], /users=2 slow=false sawInject=true body="INJECT-MARK x"/);
    assert.match(lines[2], /users=1 slow=false sawInject=false body="\/status"/);
  });
});

test("a request with only runtime context never satisfies a clause pattern", async (t) => {
  await withMock(t, async (post, log) => {
    await post([{ role: "user", content: RUNTIME }]);
    const line = log().split("\n").find((l) => l.includes("mock-model: req n="));
    assert.match(line, /users=0 slow=false sawInject=false body=""/);
  });
});

test("each req line carries the offered tool, and a tool result is logged with the text it answers (clauses bind to both)", async (t) => {
  await withMock(t, async (post, log) => {
    const text = "Smoke check: call sessionbus list, then finish.";
    const ask = [{ role: "user", content: envelope(text) }, { role: "user", content: RUNTIME }];
    await post(ask, { tools: [{ function: { name: "sessionbus" } }] });
    await post([...ask, { role: "assistant", content: null, tool_calls: [{ id: "c", function: { name: "sessionbus" } }] }, { role: "tool", content: "{}" }], { tools: [{ function: { name: "sessionbus" } }] });
    await post([{ role: "user", content: envelope("other") }]);
    const lines = log().split("\n");
    assert.ok(lines.some((l) => /mock-model: req n=1 .* body="Smoke check: call sessionbus list, then finish\." tools=sessionbus$/.test(l)));
    assert.ok(lines.some((l) => /mock-model: tool-result n=2 body="Smoke check: call sessionbus list, then finish\."$/.test(l)));
    assert.ok(lines.some((l) => /mock-model: req n=3 .* body="other" tools=none$/.test(l)));
  });
});

test("a CLI agent turn whose user message carries runtime lines after the text still logs the text (9.8 tg-split shape)", async (t) => {
  await withMock(t, async (post, log) => {
    const content = "[Mon 2026-10-05 11:41 UTC] TG-SIM tg-split\n\nRuntime: agent=smoke | host=gw | os=linux | node_identity=unknown | model=mock/mock-model | default_model=mock/mock-model";
    assert.deepEqual(realUsers([{ role: "user", content }]), [content], "nothing of the user's message is dropped");
    await post([{ role: "user", content }]);
    const line = log().split("\n").find((l) => l.includes("mock-model: req n="));
    // The clause pattern of smoke/docker/run.sh (tg_re): the unique token anywhere in the logged body.
    assert.match(line, /mock-model: req .*body="[^"]*TG-SIM tg-split/);
  });
});
