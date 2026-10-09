import assert from "node:assert/strict";
import test from "node:test";
import { createSessionbusCommand } from "../src/command.js";

// OpenClaw 2026.9.8 Telegram route of a presentation-button press (sources: extensions/telegram/src, src/auto-reply/reply).
// command action → `tgcmd:<command>` (button-types.ts:155-166); the native callback dispatcher only knows /login
// (bot-native-commands.ts:293-333), so the press becomes a synthetic message with commandSource "native"
// (bot-handlers.callback-router.ts:377-393); every native-source turn is marked PLUGIN_COMMAND_DISPATCH non-plugin
// (bot-message-dispatch-turn.ts:172-175), handlePluginCommand returns null on it (commands-plugin.ts:39-41) and the
// turn runs the model. Built-in commands are not gated by that marker, hence /subagents buttons work.
// callback action → opaque callback data handed to plugin interactive handlers
// (bot-handlers.callback-router.ts:316-338, bot-handlers.callback-router-controls.ts:550).
function telegramPressRoute(button) {
  const { action } = button;
  if (action.type === "command") return "model";
  if (action.type === "callback") return "plugin-interactive";
  return "unsupported";
}

test("tg-cmd-button: every /sessionbus menu button on Telegram (OpenClaw 9.8) reaches the plugin, not a model turn", async () => {
  const reply = await createSessionbusCommand({}).handler({ channel: "telegram", senderIsOwner: true, agentId: "advisor", args: "" });
  const buttons = reply.presentation.blocks.filter((block) => block.type === "buttons").flatMap((block) => block.buttons);
  assert.equal(buttons.length, 3);
  assert.deepEqual(
    buttons.map((button) => [button.label, telegramPressRoute(button)]),
    buttons.map((button) => [button.label, "plugin-interactive"]),
  );
});
