package lane

// PermissionRequest and Decision are the public policy boundary. The wire mapping to and from
// ACP's session/request_permission lives in wrapper.go's answerPermission; this file only
// decides.
type PermissionRequest struct {
	ToolKind  string
	ToolTitle string
	Options   []PermissionOption
}

type PermissionOption struct {
	OptionID string
	Kind     string
}

type Decision struct {
	Outcome  string
	OptionID string
}

// readKinds are the toolCall.kind values approved under "default"/"" (the agent's own exec
// rules decide whether a request is raised at all; this only answers the ones that do reach the
// wrapper).
var readKinds = map[string]bool{"read": true, "search": true, "fetch": true}

// exactKind returns the optionId of the first option whose Kind matches exactly.
func exactKind(options []PermissionOption, kind string) (string, bool) {
	for _, o := range options {
		if o.Kind == kind {
			return o.OptionID, true
		}
	}
	return "", false
}

// Decide answers one session/request_permission per the caller's permission_mode:
// "default"/"" approves reads only, "bypassPermissions" approves everything, "plan" and any
// other/unvalidated mode deny. The chosen outcome is realised by an *exact* allow_once/reject_once
// kind match (8.2 client-helpers.ts:124-125 prefers _once explicitly). An
// *_always option is never selected — it persists the decision for the agent beyond this lane and
// caller, which would let one lane's answer silently decide later lanes' requests under a
// different mode. When the wanted polarity has no _once option, an approve intent falls back to
// reject_once (denying is always the safe outcome, even when approval was wanted); a deny intent
// has no such safe fallback, so it goes straight to cancelled. No matching option at all ->
// Decision{Outcome:"cancelled"}, answered "cancelled" over the wire, never left unanswered.
func Decide(mode string, req PermissionRequest) Decision {
	approve := false
	switch mode {
	case "", "default":
		approve = readKinds[req.ToolKind]
	case "bypassPermissions":
		approve = true
	case "plan":
		approve = false
	}
	if approve {
		if id, ok := exactKind(req.Options, "allow_once"); ok {
			return Decision{Outcome: "allow", OptionID: id}
		}
	}
	if id, ok := exactKind(req.Options, "reject_once"); ok {
		return Decision{Outcome: "deny", OptionID: id}
	}
	return Decision{Outcome: "cancelled"}
}
