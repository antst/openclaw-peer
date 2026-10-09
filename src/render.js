import { isServiceNotice } from "./report.js";

// Rendering follows opencode-kilo wrappers/opencodefamily/plugin/delivery.mjs:9-17
// (renderDelivery), with a reply footer scoped to the sender and a
// no-reply variant for a service-marked body.

function replyFooter(sessionId) {
  return `Reply only if needed, with the sessionbus tool: {"action":"send","arguments":{"target":"${sessionId}","message":"..."}}. Your final text is not delivered to the sender.`;
}

const SERVICE_FOOTER = "This is a service notice from another peer; no reply is expected.";

// Unicode line/paragraph separators are valid inside a JSON string but are
// line terminators in JS/JSON.stringify output; escape them explicitly so
// the rendered envelope never contains a raw one. Built via fromCharCode to
// keep the literal code points out of this source file entirely.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const METADATA_ESCAPE_PATTERN = new RegExp(`[<>&${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, "gu");
const METADATA_ESCAPES = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  [LINE_SEPARATOR]: "\\u2028",
  [PARAGRAPH_SEPARATOR]: "\\u2029",
};

/**
 * @param {{message_id: string, from: {session_id: string, name?: string, product: string, groups: string[]}, body: string}} request
 */
export function renderInbound(request) {
  const clean = (value) => String(value).replace(/["<>\r\n\u2028\u2029]/gu, "");
  const metadata = JSON.stringify({
    fromProduct: request.from.product,
    messageId: request.message_id,
    groups: request.from.groups || [],
  }).replace(METADATA_ESCAPE_PATTERN, (character) => METADATA_ESCAPES[character]);
  const body = request.body.replace(/<\/cross-session-message/giu, "<\\/cross-session-message");
  const footer = isServiceNotice(request.body) ? SERVICE_FOOTER : replyFooter(clean(request.from.session_id));
  return `<cross-session-message from="${clean(request.from.name || request.from.session_id)}" from-session="${clean(request.from.session_id)}">\n[sessionbus-metadata: ${metadata}]\n${body}\n</cross-session-message>\n${footer}`;
}
