// Which user messages are the agent's real input? OpenClaw adds runtime-generated user messages around the
// turn ("OpenClaw runtime context for the active user request in this turn ..." on 8.2, an
// <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> block on 9.x). Those are not what a sender wrote, so a clause must never
// pass (or fail) on them: they are dropped here, and a message made only of them disappears.

export const textOf = (message) => (typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part) => part.text ?? "").join("") : "");

const RUNTIME_CONTEXT_LEAD = /^\s*OpenClaw runtime context for the active user request/;
const INTERNAL_BLOCK = /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?(?:<<<END_OPENCLAW_INTERNAL_CONTEXT>>>|$)/g;

/** The user-authored text of one message, or "" when it is runtime context only. */
export function realText(message) {
  const text = textOf(message);
  if (RUNTIME_CONTEXT_LEAD.test(text)) return "";
  return text.replace(INTERNAL_BLOCK, "").trim();
}

/** User-authored texts of a chat-completions `messages` array, in order. */
export function realUsers(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => message?.role === "user").map(realText).filter((text) => text !== "");
}

// The text a bus sender wrote, out of the plugin's <cross-session-message> envelope (src/render.js);
// any other user text (an `openclaw agent` turn) is its own body.
export function bodyOf(text) {
  const match = /\[sessionbus-metadata:[^\n]*\]\n([\s\S]*?)\n<\/cross-session-message>/.exec(text);
  return match ? match[1] : text;
}
