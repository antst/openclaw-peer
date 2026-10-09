import assert from "node:assert/strict";
import test from "node:test";
import { lastUserMessage } from "../smoke/docker/lane/last-user.mjs";

test("mock echoes the latest real user message before OpenClaw runtime context", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: [{ type: "text", text: "actual request" }] },
    { role: "user", content: "  <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate metadata" },
  ];
  assert.equal(lastUserMessage(messages), "actual request");
  assert.equal(lastUserMessage(messages.slice(-1)), messages.at(-1).content);
  assert.equal(lastUserMessage([]), "");
});
