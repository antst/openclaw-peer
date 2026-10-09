import assert from "node:assert/strict";
import test from "node:test";
import kit from "@sessionbus/kit";
import schemaModule from "@sessionbus/kit/sdk/js/schema.js";
import { createParity } from "./helpers.js";

const { ACTIONS } = kit;
const definitions = schemaModule.schema.$defs;

// peer-common@d41b0ad mcp/sessionbus_tools.go:13-28 — the tool description, one entry per line.
const UPSTREAM_DESCRIPTION_LINES = [
  "Call Sessionbus using the current Sessionbus identity. Written means local write completion only.",
  "Arguments by action (wire validation remains in the public kit):",
  "list: {} or {session_id:string} or {host:string}; session_id and host are exclusive. Returns self_info {session_id,name?,product,groups} for the bound originating caller, independent of filters or queried host. Compare row IDs to self_info.session_id; never infer self from names or order. Older daemons may omit self_info.",
  "send: {message:nonempty string, target:string} or {message, targets:unique nonempty string[]} or {message, group:string, host?:string}; choose exactly one addressing form; host applies only to group. Use returned session IDs or unambiguous names. send accepts only message, target, targets, group and host; there is no summary field. Put all intended content in message. Example: {\"action\":\"send\",\"arguments\":{\"target\":\"RETURNED_SESSION_ID\",\"message\":\"Your complete message\"}}.",
  "describe: {product:string, host?:string}; returns supported open fields and native extra arguments.",
  "spawn fresh: {product:string, name:string, open:object, host?:string, extra_groups?:unique string[], persistent?:boolean, auto_close_ms?:nonnegative integer, notify?:boolean, notify_target?:string, trace?:\"off\"|\"events\"|\"content\"}. open accepts cwd, permission_mode, model, reasoning_effort (strings), arguments (string[]); use describe to check product support. spawn resume: {resume_session_id:string, persistent?:boolean, auto_close_ms?:nonnegative integer, notify?:boolean, notify_target?:string, trace?:\"off\"|\"events\"|\"content\"}. Choose a product using describe (for example \"claude-peer\" or \"codex-peer\"); use returned session_id, never a shell substitute.",
  "trace: {session_id:string, mode:\"off\"|\"events\"|\"content\"}; changes live tracing for a direct child and returns its effective mode. Tracing defaults off, applies only to subsequent Sessionbus message sends and settled delivery metadata, and is not retained. events omits message bodies; content includes them. Trace copies are daemon-generated JSON trace envelopes delivered as ordinary messages. Each starts or schedules native work under the same mandatory-wake contract and is not replayed. It does not include Run or lane lifecycle events.",
  "Policies are independent: persistent=false ends the lane when its owner leaves; true survives owner exit. auto_close_ms defaults to 60000 after a native completed/failed/interrupted terminal; 0 disables. An unavailable record without a native terminal does not start a new grace. Every lane message starts or schedules native work; there is no passive idle mode. Open itself starts no work or retirement deadline. Resume preserves persistence, while omitted auto_close_ms resets to 60000; persistence can be promoted, not demoted. Parent-owned lanes notify their owner unless notify=false; persistent lanes need an explicit notify_target (or one retained on resume/promotion). queued_for_next_turn means the delivery is retained in a bounded in-memory queue for an automatic next native run; it is neither durable storage nor model consumption. A completion pointer is an ordinary peer message from the lane, not the answer. Interactive wake follows its native carrier; delivery success does not prove collection.",
  "run: {session_id:string, input:nonempty string}; starts and waits, returning session_id/run_id/state and either result (done) or reason (unavailable), without consuming the record.",
  "start: same fields as run; returns {session_id,run_id} for collection by an authorized caller while that worker lives.",
  "status: {session_id:string, run_id?:string}; non-consuming read, omitted run_id selects oldest unacknowledged record.",
  "wait: {session_id:string, run_id?:string, timeout_ms?:nonnegative integer}; non-consuming read or running at the requested bound. Cancellation stops this wait, not the native turn or result retention.",
  "ack: {session_id:string, run_id:string}; acknowledge the oldest terminal record: for state=done, first receive and use its result/outcome/native reason; for state=unavailable, first record/report its reason (there is no result). Both states must be acknowledged to advance the cursor. Never acknowledge running or infer an acknowledgeable record from an RPC error. Repeating an acknowledgment is idempotent, without returning the answer again. No skipping older records; unavailable does not claim a native terminal. Closing, auto-close or worker loss makes unacknowledged output unavailable; collection does not reset the retirement deadline.",
  "interrupt: {session_id:string}; acknowledgment is not terminal completion.",
  "close: {session_id:string, forget?:boolean}; forget: {session_id:string} closes with forget=true.",
  "No unlisted argument fields. Message and input strings have a 262144-character wire limit. Native policy can deny any public call."
];
// peer-common@d41b0ad mcp/sessionbus_tools.go:62-63
const UPSTREAM_ARGUMENTS_DESCRIPTION = "Use only the fields listed for the selected action in the tool description. send has no summary field; put the complete content in message.";
// peer-common@d41b0ad mcp/send_test.go:44 — the kit request definitions whose fields make up `arguments`
const REQUEST_DEFINITIONS = ["SessionListRequest", "MessageSendRequest", "LaneDescribeRequest", "LaneSpawnRequest", "TraceConfigureRequest", "TurnRunRequest", "WaitRequest", "RunRef", "TurnInterruptRequest", "SessionCloseRequest"];

async function offeredTool(t) {
  const h = await createParity();
  t.after(() => h.close());
  const tool = h.tool();
  assert.ok(tool, "the bound session is offered the sessionbus tool");
  return tool;
}

// peer-common@d41b0ad mcp/send_test.go:84-112 assertArgumentType — the advertised type a kit field maps to
function expectedType(wire) {
  if (wire.$ref === "#/$defs/SessionOpenOptions") return "object";
  if (Array.isArray(wire.enum)) return "string";
  return wire.type;
}

function assertFieldType(key, advertised, wire) {
  assert.equal(advertised.type, expectedType(wire), `${key} type`);
  if (Array.isArray(wire.enum)) assert.deepEqual(advertised.enum, wire.enum, `${key} enum`);
  if (wire.type === "array") assert.equal(advertised.items?.type, wire.items.type, `${key} item type`);
}

test("arguments schema is the closed union of kit action fields", { timeout: 10000 }, async (t) => {
  const tool = await offeredTool(t);
  const root = tool.parameters;
  assert.equal(root.type, "object");
  assert.equal(root.additionalProperties, false, "root is closed");
  assert.deepEqual([...root.required].sort(), ["action", "arguments"]);
  assert.deepEqual(Object.keys(root.properties).sort(), ["action", "arguments"]);

  const expected = {};
  for (const name of REQUEST_DEFINITIONS) Object.assign(expected, definitions[name].properties);

  const args = root.properties.arguments;
  assert.equal(args.type, "object");
  assert.equal(args.additionalProperties, false, "arguments is closed");
  assert.equal(args.description, UPSTREAM_ARGUMENTS_DESCRIPTION);
  assert.deepEqual(Object.keys(args.properties).sort(), Object.keys(expected).sort());
  for (const [key, wire] of Object.entries(expected)) assertFieldType(key, args.properties[key], wire);
  assert.equal(Object.hasOwn(args.properties, "summary"), false, "summary is not advertised");
  assert.equal(Object.hasOwn(args.properties, "idle_message"), false, "idle_message is not advertised");

  const open = args.properties.open;
  const openWire = definitions.SessionOpenOptions.properties;
  assert.equal(open.additionalProperties, false, "open is closed");
  assert.deepEqual(Object.keys(open.properties).sort(), Object.keys(openWire).sort());
  for (const [key, wire] of Object.entries(openWire)) assertFieldType(`open.${key}`, open.properties[key], wire);
});

test("action enum equals kit ACTIONS and the description covers every action", { timeout: 10000 }, async (t) => {
  const tool = await offeredTool(t);
  assert.equal(tool.name, "sessionbus");
  assert.equal(tool.parameters.properties.action.type, "string");
  assert.deepEqual(tool.parameters.properties.action.enum, [...ACTIONS]);
  assert.equal(ACTIONS.length, 13);

  const description = tool.description;
  for (const line of UPSTREAM_DESCRIPTION_LINES) {
    if (line.startsWith("Policies are independent:")) continue;
    assert.ok(description.includes(line), `description keeps the upstream line: ${line.slice(0, 60)}…`);
  }
  // The policies line is kept sentence by sentence, except the auto_close_ms defaults this plugin replaces.
  const policies = UPSTREAM_DESCRIPTION_LINES.find((line) => line.startsWith("Policies are independent:"));
  for (const sentence of policies.split(/(?<=\.) /)) {
    if (sentence.includes("60000")) continue;
    assert.ok(description.includes(sentence), `description keeps: ${sentence}`);
  }
  assert.match(description, /600000/, "states the plugin's 600000 auto_close_ms default");
  assert.doesNotMatch(description, /auto_close_ms defaults to 60000\b/, "drops the daemon's 60000 default claim");
});
