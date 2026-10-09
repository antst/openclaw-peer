// Recognize inbound notices from older plugin versions so their messages
// receive the no-reply footer. This plugin no longer sends notices.
export const SERVICE_PREFIX = "[openclaw-peer service]";

/** @param {string} body */
export function isServiceNotice(body) {
  return typeof body === "string" && body.startsWith(SERVICE_PREFIX);
}
