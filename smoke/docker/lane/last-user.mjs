export const text = (message) => typeof message?.content === "string" ? message.content :
  Array.isArray(message?.content) ? message.content.map((part) => part.text ?? "").join("") : "";

export function lastUserMessage(messages) {
  const users = messages.filter((message) => message.role === "user");
  const user = [...users].reverse().find((message) =>
    !text(message).trimStart().startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")) ?? users.at(-1);
  return text(user);
}
