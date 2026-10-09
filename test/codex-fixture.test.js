// The fake Responses API behind the real codex app-server (smoke/docker/codex-fixture.mjs): SSE shape, the SLOW ->
// exec_command -> SAW-INJECT flow, and that only the conversation input (not instructions/tools) drives it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isCodexRequest } from "../smoke/docker/codex-fixture.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "smoke", "docker", "codex-fixture.mjs");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function withFixture(t, env, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, CODEX_FIXTURE_PORT: String(port), CODEX_FIXTURE_SLOW_SECONDS: "7", ...env }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill());
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      log += chunk;
      if (log.includes("listening")) { clearTimeout(timer); resolve(); }
    });
  });
  const post = async (body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    const events = text.split("\n\n").filter(Boolean).map((block) => ({ name: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) }));
    return { res, events };
  };
  await fn(post, () => log);
}

const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const toolOutput = { type: "function_call_output", call_id: "call-fixture-1", output: "done" };

test("SLOW without a tool output asks for exec_command sleep, in the Responses SSE shape", async (t) => {
  await withFixture(t, {}, async (post, log) => {
    const { res, events } = await post({ model: "fixture-model", input: [user("SLOW busy-mid-codex")] }, { "user-agent": "codex/0.151.0", authorization: "Bearer fixture-not-a-real-key" });
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.deepEqual(events.map((e) => e.name), ["response.created", "response.output_item.done", "response.completed"]);
    const item = events[1].data.item;
    assert.equal(item.type, "function_call");
    assert.equal(item.name, "exec_command");
    assert.equal(JSON.parse(item.arguments).cmd, "sleep 7");
    assert.deepEqual(events[2].data.response.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    assert.match(log(), /codex-fixture: req n=1 ua="codex\/0\.151\.0" auth="Bearer fixture" tool_output=false slow=true sawInject=false/);
    assert.match(log(), /codex-fixture: tool-call n=1 sleep=7/);
    assert.match(log(), /codex-fixture: body n=1 /);
  });
});

test("after the tool output an INJECT-MARK that follows the SLOW text is reported as SAW-INJECT", async (t) => {
  await withFixture(t, {}, async (post, log) => {
    const { events } = await post({ input: [user("SLOW busy-mid-codex"), { type: "function_call", call_id: "call-fixture-1" }, toolOutput, user("INJECT-MARK busy-mid-codex")] });
    assert.equal(events[1].data.item.content[0].text, "SAW-INJECT");
    assert.match(log(), /req n=1 .*tool_output=true slow=true sawInject=true/);
    assert.match(log(), /reply n=1 "SAW-INJECT"/);
  });
});

test("without the steered message the run ends DONE-NO-INJECT; an INJECT-MARK before the SLOW text does not count", async (t) => {
  await withFixture(t, {}, async (post) => {
    const none = await post({ input: [user("SLOW x"), toolOutput] });
    assert.equal(none.events[1].data.item.content[0].text, "DONE-NO-INJECT");
    const stale = await post({ input: [user("INJECT-MARK old"), user("SLOW x"), toolOutput] });
    assert.equal(stale.events[1].data.item.content[0].text, "DONE-NO-INJECT");
  });
});

test("instructions and tools never trigger anything; plain input is echoed", async (t) => {
  await withFixture(t, {}, async (post) => {
    const { events } = await post({ instructions: "You may be told SLOW or INJECT-MARK", tools: [{ name: "SLOW" }], input: [user("hello /status")] });
    assert.match(events[1].data.item.content[0].text, /^ECHO: .*hello \/status/);
  });
});

test("CODEX_FIXTURE_DELTAS adds the added/delta events before the done item", async (t) => {
  await withFixture(t, { CODEX_FIXTURE_DELTAS: "1" }, async (post) => {
    const { events } = await post({ input: [user("hi")] });
    assert.deepEqual(events.map((e) => e.name), ["response.created", "response.output_item.added", "response.output_text.delta", "response.output_item.done", "response.completed"]);
    assert.match(events[2].data.delta, /^ECHO/);
  });
});

test("any other path or method is a 404", async (t) => {
  await withFixture(t, {}, async (_post, log) => {
    const port = /listening (\d+)/.exec(log())[1];
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: "{}" })).status, 404);
  });
});

test("turn=same while the tool chain has no final, turn=followup once it has one (CR-X1-1)", async (t) => {
  await withFixture(t, {}, async (post, log) => {
    const call = { type: "function_call", call_id: "call-fixture-1", name: "exec_command" };
    await post({ input: [user("SLOW chain")] }); // n=1: the fixture opens chain call-fixture-1
    // The steered message arrives with the tool output, before any final: same turn.
    const steered = await post({ input: [user("SLOW chain"), call, toolOutput, user("INJECT-MARK chain")] }); // n=2
    assert.equal(steered.events[1].data.item.content[0].text, "SAW-INJECT");
    // After the final, the replayed history plus a new message is a followup turn, however it looks otherwise.
    const followup = await post({ input: [user("SLOW chain"), call, toolOutput, user("INJECT-MARK chain"), user("INJECT-MARK later")] }); // n=3
    assert.equal(followup.events[1].data.item.content[0].text, "SAW-INJECT");
    const lines = log().split("\n").filter((l) => l.includes("codex-fixture: req n="));
    assert.match(lines[0], /tool_output=false slow=true sawInject=false turn=new codex=no$/);
    assert.match(lines[1], /tool_output=true slow=true sawInject=true turn=same codex=no$/);
    assert.match(lines[2], /tool_output=true slow=true sawInject=true turn=followup codex=no$/);
  });
});

test("a tool output of a chain the fixture never issued is a followup, and bodies carrying INJECT-MARK are always dumped", async (t) => {
  await withFixture(t, { CODEX_FIXTURE_DUMP: "0" }, async (post, log) => {
    const unknown = await post({ input: [user("SLOW x"), { type: "function_call_output", call_id: "call-elsewhere", output: "o" }, user("INJECT-MARK x")] });
    assert.equal(unknown.events[1].data.item.content[0].text, "SAW-INJECT");
    assert.match(log(), /turn=followup/);
    assert.match(log(), /codex-fixture: body n=1 .*INJECT-MARK x/);
  });
});

test("isCodexRequest: the managed codex app-server's real user agents with the fixture bearer, nothing else (X1-6)", () => {
  const ua82 = "openclaw/0.151.0 (Debian 12.0.0; aarch64) unknown (openclaw; 2026.8.2)";
  const ua98 = "openclaw/0.158.0 (Debian 12.0.0; aarch64) unknown (openclaw; 2026.9.8)";
  const bearer = "Bearer fixture-not-a-real-key";
  assert.equal(isCodexRequest(ua82, bearer), true);
  assert.equal(isCodexRequest(ua98, bearer), true);
  // Anything else that could reach the fixture is not codex evidence.
  assert.equal(isCodexRequest("curl/8.4.0", bearer), false);
  assert.equal(isCodexRequest("node", bearer), false);
  assert.equal(isCodexRequest("openclaw/0.151.0", bearer), false, "needs the parenthesised platform part");
  assert.equal(isCodexRequest("openclaw/2026.8.2 (Debian)", bearer), false, "the gateway's own version form is not a codex version");
  assert.equal(isCodexRequest(ua82, "Bearer something-else"), false);
  assert.equal(isCodexRequest(ua82, undefined), false);
  assert.equal(isCodexRequest(undefined, bearer), false);
});

test("the req log line marks codex requests: codex=yes for the real UA and bearer, codex=no otherwise", async (t) => {
  await withFixture(t, {}, async (post, log) => {
    const ua = "openclaw/0.151.0 (Debian 12.0.0; aarch64) unknown (openclaw; 2026.8.2)";
    await post({ input: [user("hello")] }, { "user-agent": ua, authorization: "Bearer fixture-not-a-real-key" });
    await post({ input: [user("hello")] }, { "user-agent": "curl/8.4.0", authorization: "Bearer fixture-not-a-real-key" });
    const lines = log().split("\n").filter((l) => l.includes("codex-fixture: req n="));
    assert.match(lines[0], / codex=yes$/);
    assert.match(lines[1], / codex=no$/);
  });
});
