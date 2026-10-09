# PARITY — peer-common/mcp tests → OpenClaw intent tests

Source of the upstream list: `grep -ho '^func Test[A-Za-z0-9_]*' mcp/*_test.go` in
peer-common @d41b0ad, 30 functions.
One row per upstream function: the OpenClaw test named in column 3 checks the same intent through the
public surface only — the tool's `execute`, the fake daemon wire and the fake host (`test/parity/helpers.js`).
Upstream MCP-transport tests (stdio framing, EOF, output pipe) map to the OpenClaw carrier of the same
guarantee: the tool call's AbortSignal, service start/stop, the daemon connection and the plugin's work bounds.
Family files may hold extra tests; those have no row here.

| Upstream | File | Test | Intent |
|---|---|---|---|
| TestSendRejectsUnknownSummaryBeforeDispatch | test/parity/send.test.js | send with summary is rejected before any daemon call, the corrected send succeeds | a send the kit schema rejects never reaches session.list or message.send; the same send without summary goes through |
| TestAdvertisedArgumentsMatchPublicActionFieldUnion | test/parity/surface.test.js | arguments schema is the closed union of kit action fields | `arguments` properties and types equal the kit request field union, `open` equals SessionOpenOptions, all closed, no summary |
| TestServerMethods | test/parity/surface.test.js | action enum equals kit ACTIONS and the description covers every action | the one tool advertises exactly kit ACTIONS and peer-common's per-action description, with this plugin's 600000 default |
| TestServerUsesStatelessActionBackend | test/parity/dispatch.test.js | each action reaches its wire method with arguments verbatim | every action maps to its kit wire method with the agent's arguments unchanged; forget is session.close with forget true |
| TestInvalidRequests | test/parity/errors.test.js | unknown or missing action is rejected with zero daemon calls | a malformed call (unknown action, no action, no arguments) is a tool error, nothing reaches the daemon, the next valid call works |
| TestToolArgumentsMustBeObject | test/parity/errors.test.js | arguments null, array or string are rejected with zero daemon calls | non-object arguments are a tool error before the daemon |
| TestServerReturnsOutputFailure | test/parity/errors.test.js | invalid daemon result becomes a tool error, not a throw | a result the wire schema rejects surfaces as isError, execute resolves |
| TestLaneBackendRequiresSocket | test/parity/errors.test.js | daemon down gives a tool error, never a hang | with no daemon connection a call returns an error promptly |
| TestListSelfInfoSurvivesCallerAndNativeToolResponse | test/parity/list.test.js | host-filtered list returns self_info verbatim | list with a host filter that excludes the caller still returns the daemon's self_info unchanged |
| TestSpawnResultTraceSurvivesSDKAndMCP | test/parity/spawn.test.js | spawn result is returned verbatim for fresh and resume in every trace mode | the daemon's spawn result (session_id, policy incl. trace) reaches the agent unchanged, fresh and resume × trace absent/off/events/content |
| TestPrivateActionKeepsCallerInResidentServer | test/parity/lifecycle.test.js | start then status running and wait done by run_id from the same agent | a run started by the agent is collectable by that agent across separate tool calls |
| TestPrivateActionPreservesWorkerCollectionError | test/parity/lifecycle.test.js | scripted worker -32004 on wait and status reaches the agent with its code | a worker collection error (scripted fake -32004, as peer-common lane_test.go:53) reaches the agent with its code, for wait and status |
| TestServerUsesBackendCallerAfterPrepare | test/parity/offer.test.js | unstarted registration resolves the started service | a tool from a never-started snapshot registration drives the started service's daemon identity |
| TestSessionbusNativeReportsAreExplicitAndHidden | test/parity/offer.test.js | exactly one tool named sessionbus, declared in contracts.tools | the bound session gets one tool, named sessionbus, which the manifest declares; nothing else is registered |
| TestSessionbusReportCannotShadowPublicTool | test/parity/offer.test.js | two registrations still offer one sessionbus tool per session | a second registration of the plugin cannot add or shadow a sessionbus tool |
| TestSessionbusMetadataIsPerNativeRequest | test/parity/offer.test.js | two bound agents use their own identities | each call carries the calling agent's identity, per call |
| TestInactiveMCPStaysUntilEOFAndAdvertisesNothing | test/parity/offer.test.js | unbound session or agent gets no tool | outside the bound session, or for an unbound agent, no sessionbus tool is offered |
| TestLaneBackendCrossingCallsAndErrors | test/parity/concurrency.test.js | a blocked run does not block interrupt, and a close error keeps its code | while run blocks, interrupt from the same agent completes; a daemon error on close reaches the agent with its code |
| TestServerCancelWithStoppedOutput | test/parity/cancel.test.js | aborting the call signal ends wait, sends no ack, record stays collectable | cancelling a tool call stops only that call; the run and its result stay on the lane |
| TestServeLaneJoinsAdmittedActions | test/parity/cancel.test.js | service stop settles an in-flight run with an error and no late result | stopping the service ends an admitted call with an error, never a later success |
| TestMCPBlockedResponsesDoNotHoldEOF | test/parity/cancel.test.js | daemon connection loss settles a blocked wait with an error | a blocked call whose daemon connection drops returns an error instead of hanging |
| TestMCPBlockedOSPipeWriteJoinsOnEOF | test/parity/cancel.test.js | service stop returns while a daemon call never replies | shutdown is not held by a daemon that never answers |
| TestMCPInitializedOnlyAfterSuccessfulWrite | test/parity/cancel.test.js | tool is offered only after the service has started | before the service is up the agent gets no working tool |
| TestMCPCompletedActionDoesNotWriteAfterEOF | test/parity/cancel.test.js | a result arriving after service stop is not returned as success | a daemon answer that lands after shutdown does not produce a successful tool result |
| TestMCPCancelledCallsReleaseWorkWithoutReplies | test/parity/cancel.test.js | aborted calls release their work slots without late results | 257 aborted calls in a row each free their slot; the aborted calls never resolve as success |
| TestMCPResponseWorkAndRetainedInputLimits | test/parity/bounds.test.js | the 257th concurrent action gets the owner work limit error | at most 256 actions per agent are in flight; the next one fails fast and never reaches the wire |
| TestMCPResponseReservationsReleaseAndIDsCanBeReused | test/parity/bounds.test.js | freed work slots are reusable after completed and failed calls | more than 256 sequential calls, successes and errors alternating, all complete |
| TestMCPReturnedPayloadBudgetStopsBlockedResponses | test/parity/bounds.test.js | many large concurrent results are each returned or errored, none hang | concurrent calls returning large results all settle |
| TestMCPFrameAndEscapedResultBounds | test/parity/bounds.test.js | a result near the frame limit is returned intact | a large result escaping-heavy text reaches the agent byte for byte |
| TestMCPOversizedPayloadStopsWithoutOutput | test/parity/bounds.test.js | message over 262144 characters is rejected before the wire | an oversized message or input is a tool error and no frame is sent |
