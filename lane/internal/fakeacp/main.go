// Command fakeacp is a hermetic stand-in for `openclaw acp` and `openclaw gateway call`
// (OpenClaw 2026.8.2) used by the openclaw-peer lane tests. One binary, dispatched on argv:
// `... gateway call <method> --json --params <json>` selects Gateway mode, any argv containing
// `acp` selects ACP mode.
//
// Behaviour is modelled on, and cites:
//   - measured against OpenClaw 8.2 (2026-09-25): initialize
//     result, session/new returning a fresh uuid sessionId, agent-prefixed `_meta.sessionKey`,
//     `session/cancel` resolving the pending prompt `cancelled`, `session/close` then "not found",
//     `session/resume` by Gateway key (also from a fresh process), exec approvals relayed as
//     `session/request_permission` with options allow-once/allow_once and deny/reject_once;
//     JSON-RPC failures as `{code:-32603, message:"Internal error", data:{details}}`.
//   - measured against OpenClaw 8.2 (2026-09-25): `sessions.create {key, cwd}` sets the exec cwd,
//     so `EXEC:pwd` answers with that cwd, else the ACP session cwd.
//   - OpenClaw 8.2 sources: src/acp/translator.session-lifecycle.ts:68-98 (newSession; the
//     Gateway row appears lazily at the first prompt), lines 216-251 (resumeSession: absolute cwd,
//     existing Gateway session required), lines 256-265 (closeSession), lines 396-403 (mcpServers refused);
//     src/acp/translator.prompt-stream.ts:182-186 (prompt lookup by ACP sessionId only, as in
//     packages/acp-core/src/session.ts:134), lines 236-275 (prefixCwd, `_meta.thinking`);
//     src/acp/permission-relay.ts:116-156 (request_permission payload);
//     src/cli/gateway-cli/register.ts:95-126 + src/gateway/call.ts:296-310 (`--json` failure
//     envelope on stdout, exit 1); packages/gateway-protocol/src/schema/error-codes.ts:133-139
//     (missing scope = FORBIDDEN, `missing scope: <scope>`, details.missingScope);
//     src/gateway/sessions-patch.ts:77-79,487-513 (unknown model = INVALID_REQUEST);
//     src/gateway/methods/core-descriptors.ts:111 + src/gateway/server-methods/exec-approvals.ts:
//     93-98,195-202 (exec.approvals.get needs operator.admin; a non-admin credential gets the
//     plain missing-scope refusal — call.ts:1296-1329 retries only sessions.create with a cwd);
//     src/auto-reply/reply/directive-handling.impl.ts:429 (thinking-level refusal text).
//
// Environment:
//
//	FAKEACP_SCRIPT  inline JSON (starts with `{`) or a path to a JSON file; see Script.
//	FAKEACP_LOG     ndjson event log, appended by every fake process (both modes).
//	FAKEACP_STATE   directory holding sessions.json, shared by both modes and across processes.
//
// Prompt text commands (ACP mode): `SLOW` (emit one chunk, then wait for cancel, max 60 s),
// `EXEC:pwd`, `/tools compact` (checked before every scripted reply), `ASK:<kind>[:<title>]`
// (raise one permission request; kind read|search|fetch|execute|edit|…), `CRASH` (one chunk,
// then exit like crashAfter), `CRASH0` (one chunk, then a clean exit 0 mid-turn),
// `EXIT_AFTER` (answer, then exit 1), `CRASH_NOW` (exit 1 before any update or response),
// `OVERLONG:<bytes>` (one stdout line of at least that size).
// With holdOutputFile scripted, EXIT_AFTER leaves a helper holding stdout/stderr until the
// test unlocks its file, pinning a stdin write failure before the worker observes EOF. The
// helper logs stdin_closed_for_exit once the fake has really exited (its fd 0 released).
//
// Tripwire: a live `/model` directive in the caller's prompt text exits 3.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

// Script drives every scripted behaviour. Unknown fields are rejected so a test typo fails loudly.
type Script struct {
	// ACP replies.
	Chunks       []string `json:"chunks,omitempty"`       // reply chunks; default: one ECHO chunk
	StopReason   string   `json:"stopReason,omitempty"`   // default end_turn
	DelayMs      int      `json:"delayMs,omitempty"`      // cancellable wait before the prompt response
	ChunkDelayMs int      `json:"chunkDelayMs,omitempty"` // wait between chunks
	NoChunks     bool     `json:"noChunks,omitempty"`     // reply with no agent_message_chunk at all (except `/tools compact`)
	ExtraUpdates bool     `json:"extraUpdates,omitempty"` // thought chunk + tool_call + tool_call_update + a foreign-session chunk before the reply
	// Big replies.
	BigReplyBytes   int    `json:"bigReplyBytes,omitempty"`   // reply of exactly this many bytes (replaces chunks)
	BigReplyEscapes bool   `json:"bigReplyEscapes,omitempty"` // big reply made of JSON-escape-heavy characters
	BigChunkBytes   int    `json:"bigChunkBytes,omitempty"`   // chunk size for the big reply, default 64 KiB
	BigReplyUnit    string `json:"bigReplyUnit,omitempty"`    // repeating unit of the big reply (overrides bigReplyEscapes), e.g. "\u0001" for 6-byte JSON escapes
	// Transport faults.
	OverlongLineBytes int               `json:"overlongLineBytes,omitempty"` // first prompt emits one stdout line of at least this many bytes
	Noise             []string          `json:"noise,omitempty"`             // non-JSON stdout lines at start and before each prompt response
	Stderr            []string          `json:"stderr,omitempty"`            // stderr lines at start (both modes)
	Marker            string            `json:"marker,omitempty"`            // printed to stderr and, in ACP mode, as a stdout noise line; appended to every error message (both modes)
	CrashAfter        int               `json:"crashAfter,omitempty"`        // the N-th prompt of this process emits one chunk, then the process exits
	CrashExitCode     int               `json:"crashExitCode,omitempty"`     // default 1
	HoldOutputFile    string            `json:"holdOutputFile,omitempty"`    // test-only: hold stdout/stderr after EXIT_AFTER until file unlock
	HoldExitMs        int               `json:"holdExitMs,omitempty"`        // test-only, with holdOutputFile: stay alive this long after closing stdin, reading but not handling input (flake-deadchild-deliver)
	Fail              map[string]string `json:"fail,omitempty"`              // ACP method -> JSON-RPC error details
	// Sessions.
	KnownKeys      []string          `json:"knownKeys,omitempty"`      // keys session/resume accepts besides the state file
	Tools          []string          `json:"tools,omitempty"`          // `/tools compact` list; default exec, read, write, sessionbus
	NoSessionbus   bool              `json:"noSessionbus,omitempty"`   // drop sessionbus from the tool list
	RejectThinking map[string]string `json:"rejectThinking,omitempty"` // `_meta.thinking` value -> provider/model named in the refusal
	// Permissions.
	Permissions          []PermissionSpec `json:"permissions,omitempty"`          // raised on every prompt, before the reply
	PermissionTimeoutMs  int              `json:"permissionTimeoutMs,omitempty"`  // 0 = wait for the answer forever (like 8.2)
	PermissionOnClose    bool             `json:"permissionOnClose,omitempty"`    // session/close first raises one execute request and waits ≤3 s for its answer
	ReadinessPermissions bool             `json:"readinessPermissions,omitempty"` // the readiness prompt (`/tools compact`) raises the scripted permissions too
	// Gateway mode.
	Gateway      map[string]GatewaySpec `json:"gateway,omitempty"`      // method -> scripted outcome
	SpawnedCwd   map[string]string      `json:"spawnedCwd,omitempty"`   // sessions.get drift: key (or "*") -> reported spawnedCwd
	GatewayNoise []string               `json:"gatewayNoise,omitempty"` // non-JSON stdout lines before the Gateway result
	DecoyCwd     string                 `json:"decoyCwd,omitempty"`     // sessions.list adds rows <key>:thread:1 (before) and <key>:thread:2 (after) with this spawnedCwd; "=original" = the row's stored cwd
	Admin        bool                   `json:"admin,omitempty"`        // the Gateway credential carries operator.admin: exec.approvals.get succeeds (default: refused, missing operator.admin)
}

// PermissionSpec is one scripted `session/request_permission`.
type PermissionSpec struct {
	Kind    string            `json:"kind"`              // toolCall.kind, e.g. execute, read
	Title   string            `json:"title,omitempty"`   // default "<kind>: fake"
	Options []json.RawMessage `json:"options,omitempty"` // override the option list (malformed allowed)
}

// GatewaySpec scripts one Gateway method.
type GatewaySpec struct {
	Fail    string `json:"fail,omitempty"`    // missing_admin | unknown_model | transport | credentials_required | unrelated_internal | unrelated_missing_scope
	Message string `json:"message,omitempty"` // override the failure message
	DelayMs int    `json:"delayMs,omitempty"`
}

// SessionRow is one Gateway session row in $FAKEACP_STATE/sessions.json.
type SessionRow struct {
	SpawnedCwd string `json:"spawnedCwd,omitempty"`
	Model      string `json:"model,omitempty"`
	Turns      int    `json:"turns"`
	Created    bool   `json:"created,omitempty"` // by sessions.create
}

type stateFile struct {
	Sessions map[string]*SessionRow `json:"sessions"`
}

var (
	script   Script
	logMu    sync.Mutex
	mode     string
	logPath  = os.Getenv("FAKEACP_LOG")
	stateDir = os.Getenv("FAKEACP_STATE")
)

func main() {
	args := os.Args[1:]
	if len(args) == 4 && args[0] == "hold-output" {
		mode = "acp"
		waitParentExit(args[2], args[3])
		f, err := os.Open(args[1])
		if err != nil {
			os.Exit(2)
		}
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_SH); err != nil {
			os.Exit(2)
		}
		_ = f.Close()
		return
	}
	if err := loadScript(); err != nil {
		fmt.Fprintf(os.Stderr, "fakeacp: FAKEACP_SCRIPT: %v\n", err)
		os.Exit(2)
	}
	switch {
	case gatewayIndex(args) >= 0:
		mode = "gateway"
		os.Exit(runGateway(args[gatewayIndex(args)+2:]))
	case contains(args, "acp"):
		mode = "acp"
		os.Exit(runACP())
	default:
		fmt.Fprintln(os.Stderr, "fakeacp: usage: fakeacp acp | fakeacp gateway call <method> --json --params <json>")
		os.Exit(2)
	}
}

func loadScript() error {
	raw := os.Getenv("FAKEACP_SCRIPT")
	if raw == "" {
		return nil
	}
	data := []byte(raw)
	if !strings.HasPrefix(strings.TrimSpace(raw), "{") {
		b, err := os.ReadFile(raw)
		if err != nil {
			return err
		}
		data = b
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(&script)
}

func gatewayIndex(args []string) int {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "gateway" && args[i+1] == "call" {
			return i
		}
	}
	return -1
}

func contains(args []string, s string) bool {
	for _, a := range args {
		if a == s {
			return true
		}
	}
	return false
}

// waitParentExit logs stdin_closed_for_exit once the fake (pid) has exited. The kernel releases
// an exiting process's files before it reparents its children, so a changed ppid means the fake's
// fd 0 is closed. Waiting for ESRCH instead would deadlock: the wrapper reaps the fake only after
// stdout EOF, which this helper holds (flake-deadchild-deliver).
func waitParentExit(pid, key string) {
	deadline := time.Now().Add(10 * time.Second)
	for strconv.Itoa(os.Getppid()) == pid {
		if time.Now().After(deadline) {
			logEvent("hold_output_error", map[string]any{"error": "fake did not exit in 10s"})
			os.Exit(2)
		}
		time.Sleep(5 * time.Millisecond)
	}
	logEvent("stdin_closed_for_exit", map[string]any{"key": key})
}

// ---------------------------------------------------------------- log and state

// exiting drops input read after a holdExitMs stdin close: the process is dying.
var exiting atomic.Bool

// logEvent appends one ndjson line to FAKEACP_LOG with a single write (O_APPEND), so the lines
// of concurrent fake processes interleave whole and in order of occurrence.
func logEvent(event string, fields map[string]any) {
	if logPath == "" {
		return
	}
	rec := map[string]any{"t": time.Now().UnixMicro(), "pid": os.Getpid(), "mode": mode, "event": event}
	for k, v := range fields {
		rec[k] = v
	}
	line, err := json.Marshal(rec)
	if err != nil {
		return
	}
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

// processInfo is logged once per process: argv and the names (never values) of the child env,
// plus the values of the two banner switches.
func processInfo() map[string]any {
	names := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		names = append(names, name)
	}
	sort.Strings(names)
	_, tok := os.LookupEnv("OPENCLAW_GATEWAY_TOKEN")
	_, pw := os.LookupEnv("OPENCLAW_GATEWAY_PASSWORD")
	return map[string]any{
		"argv":               os.Args,
		"envNames":           names,
		"stateDir":           os.Getenv("OPENCLAW_STATE_DIR"),
		"configPath":         os.Getenv("OPENCLAW_CONFIG_PATH"),
		"hasGatewayToken":    tok,
		"hasGatewayPassword": pw,
		"hideBanner":         os.Getenv("OPENCLAW_HIDE_BANNER"),
		"suppressNotes":      os.Getenv("OPENCLAW_SUPPRESS_NOTES"),
	}
}

// withState runs fn on the shared session table under an exclusive flock. Without FAKEACP_STATE
// the table is per process.
var memState = stateFile{Sessions: map[string]*SessionRow{}}

func withState(write bool, fn func(*stateFile)) {
	if stateDir == "" {
		fn(&memState)
		return
	}
	_ = os.MkdirAll(stateDir, 0o700)
	lock, err := os.OpenFile(filepath.Join(stateDir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err == nil {
		defer lock.Close()
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX)
		defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	}
	path := filepath.Join(stateDir, "sessions.json")
	st := stateFile{Sessions: map[string]*SessionRow{}}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &st)
		if st.Sessions == nil {
			st.Sessions = map[string]*SessionRow{}
		}
	}
	fn(&st)
	if write {
		b, _ := json.MarshalIndent(st, "", "  ")
		tmp := path + fmt.Sprintf(".%d.tmp", os.Getpid())
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, path)
		}
	}
}

func row(st *stateFile, key string) *SessionRow {
	r := st.Sessions[key]
	if r == nil {
		r = &SessionRow{}
		st.Sessions[key] = r
	}
	return r
}

func withMarker(msg string) string {
	if script.Marker == "" {
		return msg
	}
	return msg + " [ref " + script.Marker + "]"
}

func startupOutput(stdout io.Writer) {
	for _, l := range script.Stderr {
		fmt.Fprintln(os.Stderr, l)
	}
	if script.Marker != "" {
		fmt.Fprintf(os.Stderr, "gateway auth token=%s\n", script.Marker)
	}
	if stdout != nil {
		for _, l := range script.Noise {
			fmt.Fprintln(stdout, l)
		}
		if script.Marker != "" {
			fmt.Fprintf(stdout, "[openclaw] credential %s\n", script.Marker)
		}
	}
}

// ---------------------------------------------------------------- Gateway mode

func runGateway(rest []string) int {
	info := processInfo()
	if len(rest) == 0 || strings.HasPrefix(rest[0], "-") {
		fmt.Fprintln(os.Stderr, "error: missing gateway method")
		return 1
	}
	method := rest[0]
	var paramsRaw string
	jsonOut := false
	flags := []string{}
	for i := 1; i < len(rest); i++ {
		a := rest[i]
		switch {
		case a == "--json":
			jsonOut = true
		case a == "--params" && i+1 < len(rest):
			paramsRaw = rest[i+1]
			i++
		case strings.HasPrefix(a, "--params="):
			paramsRaw = strings.TrimPrefix(a, "--params=")
		case strings.HasPrefix(a, "-"):
			flags = append(flags, a)
		}
	}
	var params map[string]any
	if paramsRaw == "" {
		paramsRaw = "{}"
	}
	info["method"] = method
	if err := json.Unmarshal([]byte(paramsRaw), &params); err != nil {
		info["params"] = paramsRaw
		logEvent("gateway_call", info)
		fmt.Fprintln(os.Stderr, "Error: --params must be valid JSON.")
		return 1
	}
	info["params"] = params
	info["json"] = jsonOut
	info["flags"] = flags
	logEvent("gateway_call", info)
	startupOutput(nil)
	for _, l := range script.GatewayNoise {
		fmt.Println(l)
	}
	for _, f := range flags {
		// src/gateway/client-bootstrap.ts:44-75: a URL override without explicit credentials throws.
		// Under --json it is formatGatewayAuthErrorJson's envelope (call.ts:348-364).
		if f == "--url" || strings.HasPrefix(f, "--url=") {
			return gatewayFailure(jsonOut, credentialsRequired(urlOverrideMessage))
		}
	}
	spec := script.Gateway[method]
	if spec.DelayMs > 0 {
		time.Sleep(time.Duration(spec.DelayMs) * time.Millisecond)
	}
	key, _ := params["key"].(string)
	switch spec.Fail {
	case "":
	case "transport":
		fmt.Println(withMarker(nonEmpty(spec.Message, "Gateway call failed: Error: gateway closed (1006 abnormal closure (no close frame))")))
		return 1
	case "credentials_required":
		return gatewayFailure(jsonOut, credentialsRequired(nonEmpty(spec.Message, "gateway credentials required: pair this device or set a token")))
	case "missing_admin":
		return gatewayFailure(jsonOut, missingAdmin(spec.Message))
	case "unrelated_internal":
		return gatewayFailure(jsonOut, map[string]any{"type": "gateway_request_error", "code": "INTERNAL", "message": withMarker(nonEmpty(spec.Message, "unrelated Gateway failure"))})
	case "unrelated_missing_scope":
		return gatewayFailure(jsonOut, map[string]any{"type": "gateway_request_error", "code": "FORBIDDEN", "message": withMarker(nonEmpty(spec.Message, "missing scope: operator.pairing")),
			"details": map[string]any{"code": "MISSING_SCOPE", "missingScope": "operator.pairing", "requiredScopes": []string{"operator.pairing"}}})
	case "unknown_model":
		model, _ := params["model"].(string)
		return gatewayFailure(jsonOut, map[string]any{"type": "gateway_request_error", "code": "INVALID_REQUEST",
			"message": withMarker(nonEmpty(spec.Message, "model not allowed: "+model)), "retryable": false})
	default:
		fmt.Fprintf(os.Stderr, "fakeacp: unknown gateway fail kind %q\n", spec.Fail)
		return 2
	}
	var result any
	switch method {
	case "sessions.create":
		cwd, _ := params["cwd"].(string)
		if key == "" {
			return gatewayFailure(jsonOut, invalidRequest("key required"))
		}
		withState(true, func(st *stateFile) {
			r := row(st, key)
			r.Created = true
			if cwd != "" {
				r.SpawnedCwd = cwd
			}
		})
		result = map[string]any{"ok": true, "key": key, "sessionId": newUUID(), "entry": map[string]any{"spawnedCwd": cwd}}
	case "sessions.patch":
		model, _ := params["model"].(string)
		if key == "" {
			return gatewayFailure(jsonOut, invalidRequest("key required"))
		}
		withState(true, func(st *stateFile) {
			if model != "" {
				row(st, key).Model = model
			} else {
				row(st, key)
			}
		})
		result = map[string]any{"ok": true, "key": key, "entry": map[string]any{"model": model}}
	case "sessions.get":
		// The fixture returns {spawnedCwd}. Real 8.2 sessions.get returns only {messages}
		// (src/gateway/server-methods/sessions-read.ts:662-712); spawnedCwd is on sessions.list rows.
		var found bool
		var r SessionRow
		withState(false, func(st *stateFile) {
			if p := st.Sessions[key]; p != nil {
				found, r = true, *p
			}
		})
		out := map[string]any{"messages": []any{}}
		cwd := r.SpawnedCwd
		if v, ok := script.SpawnedCwd[key]; ok {
			cwd = v
		} else if v, ok := script.SpawnedCwd["*"]; ok && found {
			cwd = v
		}
		if cwd != "" {
			out["spawnedCwd"] = cwd
		}
		if r.Model != "" {
			out["model"] = r.Model
		}
		result = out
	case "sessions.list":
		// The drift check reads spawnedCwd from the sessions.list row
		// (session-utils-row.ts:424); `search` filters by key substring.
		rows := []map[string]any{}
		withState(false, func(st *stateFile) {
			keys := make([]string, 0, len(st.Sessions))
			for k := range st.Sessions {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			search, _ := params["search"].(string)
			for _, k := range keys {
				if search != "" && !strings.Contains(k, search) {
					continue
				}
				p := st.Sessions[k]
				m := map[string]any{"key": k}
				cwd := p.SpawnedCwd
				if v, ok := script.SpawnedCwd[k]; ok {
					cwd = v
				} else if v, ok := script.SpawnedCwd["*"]; ok {
					cwd = v
				}
				if cwd != "" {
					m["spawnedCwd"] = cwd
				}
				if p.Model != "" {
					m["model"] = p.Model
				}
				// 8.2's search is a substring match over several fields (session-utils-list.ts:191,
				// 284-306), so sessions derived from the lane key match too.
				decoy := func(n int) map[string]any {
					cwd := script.DecoyCwd
					if cwd == "=original" {
						cwd = p.SpawnedCwd
					}
					return map[string]any{"key": fmt.Sprintf("%s:thread:%d", k, n), "spawnedCwd": cwd}
				}
				if script.DecoyCwd != "" {
					rows = append(rows, decoy(1))
				}
				rows = append(rows, m)
				if script.DecoyCwd != "" {
					rows = append(rows, decoy(2))
				}
			}
		})
		result = map[string]any{"sessions": rows, "hasMore": false}
	case "exec.approvals.get":
		// The lane's admin guard probe. Like 8.2 for a read/write/approvals
		// device: the method-scope gate refuses before the handler runs. `admin` = a shared token
		// or an admin device: the handler answers with the approvals snapshot.
		if !script.Admin {
			return gatewayFailure(jsonOut, missingAdmin(spec.Message))
		}
		result = map[string]any{"path": filepath.Join(nonEmpty(stateDir, os.TempDir()), "exec-approvals.json"), "exists": false,
			"hash": "fake", "file": map[string]any{"version": 1}, "resolvedDefaults": map[string]any{"security": "allowlist", "ask": "on-miss"}}
	default:
		return gatewayFailure(jsonOut, invalidRequest("unknown method: "+method))
	}
	b, _ := json.MarshalIndent(result, "", "  ")
	if !jsonOut {
		fmt.Printf("Gateway call: %s\n", method)
	}
	fmt.Println(string(b))
	return 0
}

// urlOverrideMessage is GatewayExplicitAuthRequiredError's text for a --url override
// (src/gateway/client-bootstrap.ts:70-79).
const urlOverrideMessage = "gateway url override requires explicit credentials\nFor the default local or SSH-tunneled Gateway, remove --url to use the configured target."

// credentialsRequired is 8.2's credentials failure: type and message only (call.ts:348-364).
func credentialsRequired(msg string) map[string]any {
	return map[string]any{"type": "gateway_credentials_required", "message": withMarker(msg)}
}

// missingAdmin is the method-scope gate's refusal of an operator.admin method
// (packages/gateway-protocol/src/schema/error-codes.ts:133-139).
func missingAdmin(msg string) map[string]any {
	return map[string]any{"type": "gateway_request_error", "code": "FORBIDDEN",
		"message":   withMarker(nonEmpty(msg, "missing scope: operator.admin")),
		"details":   map[string]any{"code": "MISSING_SCOPE", "missingScope": "operator.admin", "requiredScopes": []string{"operator.admin"}},
		"retryable": false}
}

func invalidRequest(msg string) map[string]any {
	return map[string]any{"type": "gateway_request_error", "code": "INVALID_REQUEST", "message": withMarker(msg), "retryable": false}
}

// gatewayFailure prints the real CLI failure form: in --json mode the stdout envelope
// {ok:false, error:{…}}, otherwise `Gateway call failed: <message>` on stderr; exit 1.
func gatewayFailure(jsonOut bool, errObj map[string]any) int {
	if jsonOut {
		b, _ := json.MarshalIndent(map[string]any{"ok": false, "error": errObj}, "", "  ")
		fmt.Println(string(b))
	} else {
		fmt.Fprintf(os.Stderr, "Gateway call failed: %v\n", errObj["message"])
	}
	return 1
}

func nonEmpty(s, def string) string {
	if s != "" {
		return s
	}
	return def
}

// ---------------------------------------------------------------- ACP mode

type rpcMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

type session struct {
	id, key, cwd string
	cancel       context.CancelFunc // pending prompt, nil when idle
	promptSeq    int                // identifies the prompt that owns cancel
}

type acpServer struct {
	out          *bufio.Writer
	outMu        sync.Mutex
	mu           sync.Mutex
	sessions     map[string]*session
	nextOut      int
	waiting      map[string]chan rpcMsg // outbound request id -> reply
	prompts      int
	overlongDone bool
	wg           sync.WaitGroup
}

func runACP() int {
	logEvent("start", processInfo())
	s := &acpServer{out: bufio.NewWriterSize(os.Stdout, 1<<16), sessions: map[string]*session{}, waiting: map[string]chan rpcMsg{}}
	s.outMu.Lock()
	startupOutput(s.out)
	_ = s.out.Flush()
	s.outMu.Unlock()
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := in.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 && !exiting.Load() {
			s.handleLine(line)
		}
		if err != nil {
			break
		}
	}
	logEvent("stdin_closed", nil)
	s.mu.Lock()
	for _, ss := range s.sessions {
		if ss.cancel != nil {
			ss.cancel()
		}
	}
	s.mu.Unlock()
	s.wg.Wait()
	return 0
}

func (s *acpServer) write(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.writeRaw(b)
}

func (s *acpServer) writeRaw(b []byte) {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	_, _ = s.out.Write(b)
	_ = s.out.WriteByte('\n')
	_ = s.out.Flush()
}

func (s *acpServer) respond(id json.RawMessage, result any) {
	s.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// respondErr uses 8.2's wire form for a thrown handler error.
func (s *acpServer) respondErr(id json.RawMessage, details string) {
	s.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{
		"code": -32603, "message": "Internal error", "data": map[string]any{"details": withMarker(details)}}})
}

func (s *acpServer) notifyUpdate(sessionID string, update map[string]any) {
	s.write(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sessionID, "update": update}})
}

func (s *acpServer) handleLine(line []byte) {
	var m rpcMsg
	if err := json.Unmarshal(line, &m); err != nil {
		logEvent("recv_invalid", map[string]any{"bytes": len(line)})
		return
	}
	if m.Method == "" {
		// Reply to one of our requests (session/request_permission).
		logEvent("recv_reply", map[string]any{"id": m.ID, "result": m.Result, "error": m.Error})
		s.mu.Lock()
		ch := s.waiting[string(m.ID)]
		delete(s.waiting, string(m.ID))
		s.mu.Unlock()
		if ch != nil {
			ch <- m
		}
		return
	}
	logEvent("recv", map[string]any{"method": m.Method, "id": m.ID, "params": m.Params})
	if details, ok := script.Fail[m.Method]; ok && m.ID != nil {
		s.respondErr(m.ID, details)
		return
	}
	switch m.Method {
	case "initialize":
		s.respond(m.ID, map[string]any{
			"protocolVersion": 1,
			"agentCapabilities": map[string]any{
				"loadSession":         true,
				"promptCapabilities":  map[string]any{"image": true, "audio": false, "embeddedContext": true},
				"mcpCapabilities":     map[string]any{"http": false, "sse": false},
				"sessionCapabilities": map[string]any{"list": map[string]any{}, "resume": map[string]any{}, "close": map[string]any{}},
			},
			"agentInfo":   map[string]any{"name": "openclaw-acp", "title": "OpenClaw ACP Gateway", "version": "2026.8.2-fake"},
			"authMethods": []any{},
		})
	case "session/new":
		s.sessionNew(m)
	case "session/resume":
		s.sessionResume(m)
	case "session/prompt":
		// Admission is registered on the reader, so a session/cancel read right after the
		// prompt always finds it (8.2 keeps pendingPromptAdmissions for the same reason,
		// translator.prompt-stream.ts:182-230).
		if a := s.admitPrompt(m); a != nil {
			s.wg.Add(1)
			go func() { defer s.wg.Done(); s.sessionPrompt(m, a) }()
		}
	case "session/cancel":
		var p struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(m.Params, &p)
		s.mu.Lock()
		if ss := s.sessions[p.SessionID]; ss != nil && ss.cancel != nil {
			ss.cancel()
		}
		s.mu.Unlock()
	case "session/close":
		var p struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(m.Params, &p)
		s.mu.Lock()
		ss := s.sessions[p.SessionID]
		if ss != nil {
			if ss.cancel != nil {
				ss.cancel()
			}
			delete(s.sessions, p.SessionID)
		}
		s.mu.Unlock()
		if ss == nil {
			s.respondErr(m.ID, "Session "+p.SessionID+" not found")
			return
		}
		// Which lane voice files still exist when the child is told to close.
		logEvent("session_close", map[string]any{"sessionId": p.SessionID, "key": ss.key, "voice": voiceRegistration(ss.key)})
		if script.PermissionOnClose {
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if s.requestPermission(ctx, ss, PermissionSpec{Kind: "execute", Title: "exec: on close"}) == "cancelled" && ctx.Err() != nil {
					logEvent("permission_unanswered", map[string]any{"key": ss.key, "kind": "execute", "onClose": true})
				}
				s.respond(m.ID, map[string]any{})
			}()
			return
		}
		s.respond(m.ID, map[string]any{})
	default:
		if m.ID != nil {
			s.write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "Method not found", "data": map[string]any{"method": m.Method}}})
		}
	}
}

type sessionSetup struct {
	SessionID  string            `json:"sessionId"`
	Cwd        string            `json:"cwd"`
	McpServers []json.RawMessage `json:"mcpServers"`
	Meta       map[string]any    `json:"_meta"`
}

const mcpRefusal = "ACP bridge mode does not support per-session MCP servers. Configure MCP on the OpenClaw gateway or agent instead."

func (s *acpServer) sessionNew(m rpcMsg) {
	var p sessionSetup
	if err := json.Unmarshal(m.Params, &p); err != nil {
		s.respondErr(m.ID, "invalid params: "+err.Error())
		return
	}
	if len(p.McpServers) > 0 {
		s.respondErr(m.ID, mcpRefusal)
		return
	}
	key, _ := p.Meta["sessionKey"].(string)
	if key == "" {
		id := newUUID()
		s.respondErr(m.ID, "session key acp-bridge:"+id+" has no explicit owner. Use an agent-prefixed session key")
		return
	}
	ss := &session{id: newUUID(), key: key, cwd: p.Cwd}
	s.mu.Lock()
	s.sessions[ss.id] = ss
	s.mu.Unlock()
	logEvent("session_new", map[string]any{"sessionId": ss.id, "key": key, "cwd": p.Cwd})
	s.sessionAnnounce(ss)
	s.respond(m.ID, map[string]any{"sessionId": ss.id, "configOptions": []any{}, "modes": nil})
}

func (s *acpServer) sessionAnnounce(ss *session) {
	s.notifyUpdate(ss.id, map[string]any{"sessionUpdate": "session_info_update", "title": ss.key, "updatedAt": nil, "_meta": map[string]any{"sessionKey": ss.key, "kind": "unknown"}})
	s.notifyUpdate(ss.id, map[string]any{"sessionUpdate": "available_commands_update", "availableCommands": []any{
		map[string]any{"name": "help", "description": "Show help and common commands."},
		map[string]any{"name": "status", "description": "Show current status."},
		map[string]any{"name": "model", "description": "Show or set the model."},
	}})
}

func (s *acpServer) sessionResume(m rpcMsg) {
	var p sessionSetup
	if err := json.Unmarshal(m.Params, &p); err != nil {
		s.respondErr(m.ID, "invalid params: "+err.Error())
		return
	}
	if len(p.McpServers) > 0 {
		s.respondErr(m.ID, mcpRefusal)
		return
	}
	if !filepath.IsAbs(p.Cwd) {
		s.respondErr(m.ID, "session/resume requires an absolute cwd")
		return
	}
	key := p.SessionID
	if k, _ := p.Meta["sessionKey"].(string); k != "" {
		key = k
	}
	known := contains(script.KnownKeys, key)
	if !known {
		withState(false, func(st *stateFile) { known = st.Sessions[key] != nil })
	}
	if !known {
		s.respondErr(m.ID, "Session "+key+" not found")
		return
	}
	ss := &session{id: p.SessionID, key: key, cwd: p.Cwd}
	s.mu.Lock()
	if old := s.sessions[ss.id]; old != nil && old.cancel != nil {
		old.cancel()
	}
	s.sessions[ss.id] = ss
	s.mu.Unlock()
	logEvent("session_resume", map[string]any{"sessionId": ss.id, "key": key, "cwd": p.Cwd})
	s.sessionAnnounce(ss)
	s.respond(m.ID, map[string]any{"configOptions": []any{}, "modes": nil})
}

type promptParams struct {
	SessionID string            `json:"sessionId"`
	Prompt    []json.RawMessage `json:"prompt"`
	Meta      map[string]any    `json:"_meta"`
}

type admission struct {
	p             promptParams
	ctx           context.Context
	cancel        context.CancelFunc
	ss            *session
	n, seq        int
	firstOverlong bool
}

// admitPrompt parses a session/prompt and registers it as the session's pending prompt; on
// failure it answers the request and returns nil.
func (s *acpServer) admitPrompt(m rpcMsg) *admission {
	var p promptParams
	if err := json.Unmarshal(m.Params, &p); err != nil {
		s.respondErr(m.ID, "invalid params: "+err.Error())
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.sessions[p.SessionID]
	if ss == nil {
		cancel()
		s.respondErr(m.ID, "Session "+p.SessionID+" not found")
		return nil
	}
	if ss.cancel != nil {
		ss.cancel() // a new prompt supersedes the pending one
	}
	ss.cancel = cancel
	ss.promptSeq++
	s.prompts++
	a := &admission{p: p, ctx: ctx, cancel: cancel, ss: ss, n: s.prompts, seq: ss.promptSeq,
		firstOverlong: !s.overlongDone && script.OverlongLineBytes > 0}
	s.overlongDone = true
	return a
}

func (s *acpServer) sessionPrompt(m rpcMsg, a *admission) {
	p, ctx, ss, n, seq, firstOverlong := a.p, a.ctx, a.ss, a.n, a.seq, a.firstOverlong
	defer a.cancel()
	defer func() {
		s.mu.Lock()
		if ss.promptSeq == seq {
			ss.cancel = nil
		}
		s.mu.Unlock()
	}()

	text := promptText(p.Prompt)
	prefixCwd := true
	if v, ok := p.Meta["prefixCwd"].(bool); ok {
		prefixCwd = v
	}
	thinking, _ := p.Meta["thinking"].(string)
	if thinking == "" {
		thinking, _ = p.Meta["thinkingLevel"].(string)
	}
	message := text
	if prefixCwd {
		message = "[Working directory: " + ss.cwd + "]\n\n" + text
	}
	logEvent("prompt", map[string]any{"n": n, "sessionId": ss.id, "key": ss.key, "text": text, "meta": p.Meta,
		"prefixCwd": prefixCwd, "thinking": thinking, "blocks": len(p.Prompt), "voice": voiceRegistration(ss.key)})

	if LiveModelDirective(text) {
		logEvent("tripwire", map[string]any{"key": ss.key, "text": text})
		fmt.Fprintln(os.Stderr, "fakeacp: tripwire: live /model directive in prompt text")
		os.Exit(3)
	}
	if strings.TrimSpace(text) == "/tools compact" {
		// The wrapper's own voice readiness prompt gets a fixed tool-list reply. Scripted
		// updates, delays and stop reasons belong to caller turns only; scripted permissions are
		// raised here only with readinessPermissions (8.2 may ask while any prompt runs).
		if script.ReadinessPermissions {
			for _, spec := range script.Permissions {
				outcome := s.requestPermission(ctx, ss, spec)
				if ctx.Err() != nil {
					s.finishCancelled(m.ID, ss)
					return
				}
				s.chunk(ss.id, "PERMISSION "+spec.Kind+" -> "+outcome+"\n")
			}
		}
		s.chunk(ss.id, "Tools (compact): "+strings.Join(toolList(), ", "))
		s.outMu.Lock()
		for _, l := range script.Noise {
			fmt.Fprintln(s.out, l)
		}
		_ = s.out.Flush()
		s.outMu.Unlock()
		logEvent("prompt_done", map[string]any{"n": n, "key": ss.key, "stopReason": "end_turn", "readiness": true})
		s.respond(m.ID, map[string]any{"stopReason": "end_turn"})
		return
	}
	if hasWord(text, "CRASH_NOW") {
		logEvent("crash", map[string]any{"n": n, "silent": true})
		os.Exit(1)
	}
	if hasWord(text, "CRASH0") {
		s.chunk(ss.id, "partial answer before a clean exit")
		logEvent("crash", map[string]any{"n": n, "code": 0})
		os.Exit(0)
	}
	if script.CrashAfter > 0 && n == script.CrashAfter || hasWord(text, "CRASH") {
		s.chunk(ss.id, "partial answer before crash")
		logEvent("crash", map[string]any{"n": n})
		code := script.CrashExitCode
		if code == 0 {
			code = 1
		}
		os.Exit(code)
	}
	var r SessionRow
	withState(true, func(st *stateFile) {
		rr := row(st, ss.key)
		rr.Turns++
		r = *rr
	})
	overlong := 0
	if firstOverlong {
		overlong = script.OverlongLineBytes
	}
	for _, f := range strings.Fields(text) {
		if v, ok := strings.CutPrefix(f, "OVERLONG:"); ok {
			fmt.Sscan(v, &overlong)
		}
	}
	if overlong > 0 {
		pad := strings.Repeat("x", overlong)
		s.notifyUpdate(ss.id, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": pad}})
	}
	if script.ExtraUpdates {
		s.notifyUpdate(ss.id, map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "THOUGHT-TEXT"}})
		s.notifyUpdate(ss.id, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call_x", "title": "TOOL-TITLE", "kind": "read", "status": "pending"})
		s.notifyUpdate(ss.id, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call_x", "status": "completed",
			"content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "TOOL-OUTPUT"}}}})
		s.notifyUpdate("foreign-"+ss.id, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "FOREIGN-TEXT"}})
	}

	// Permission requests: scripted ones, then ASK: commands in the text.
	specs := append([]PermissionSpec{}, script.Permissions...)
	specs = append(specs, askCommands(text)...)
	for _, spec := range specs {
		outcome := s.requestPermission(ctx, ss, spec)
		if ctx.Err() != nil {
			s.finishCancelled(m.ID, ss)
			return
		}
		s.chunk(ss.id, "PERMISSION "+spec.Kind+" -> "+outcome+"\n")
	}

	var chunks []string
	switch {
	case strings.TrimSpace(text) == "/tools compact":
		chunks = []string{"Tools (compact): " + strings.Join(toolList(), ", ")}
	case thinking != "" && script.RejectThinking[thinking] != "":
		chunks = []string{fmt.Sprintf("Thinking level %q is not supported for %s. Use one of: off, minimal, low, medium, high.", thinking, script.RejectThinking[thinking])}
	case strings.Contains(text, "EXEC:pwd"):
		cwd := ss.cwd
		if r.SpawnedCwd != "" {
			cwd = r.SpawnedCwd
		}
		chunks = []string{cwd}
	case script.BigReplyBytes > 0:
		chunks = bigReply(script.BigReplyBytes, script.BigReplyEscapes, script.BigReplyUnit, script.BigChunkBytes)
	case len(script.Chunks) > 0:
		chunks = script.Chunks
	default:
		model := r.Model
		if model == "" {
			model = "default"
		}
		chunks = []string{fmt.Sprintf("ECHO[model=%s turn=%d]: %s", model, r.Turns, message)}
	}
	if script.NoChunks && strings.TrimSpace(text) != "/tools compact" {
		chunks = nil
	}
	slow := strings.Contains(text, "SLOW")
	for i, c := range chunks {
		if i > 0 && script.ChunkDelayMs > 0 && !sleepCtx(ctx, time.Duration(script.ChunkDelayMs)*time.Millisecond) {
			s.finishCancelled(m.ID, ss)
			return
		}
		s.chunk(ss.id, c)
		if slow && i == 0 {
			if !sleepCtx(ctx, 60*time.Second) {
				s.finishCancelled(m.ID, ss)
				return
			}
		}
	}
	if script.DelayMs > 0 && !sleepCtx(ctx, time.Duration(script.DelayMs)*time.Millisecond) {
		s.finishCancelled(m.ID, ss)
		return
	}
	if ctx.Err() != nil {
		s.finishCancelled(m.ID, ss)
		return
	}
	s.outMu.Lock()
	for _, l := range script.Noise {
		fmt.Fprintln(s.out, l)
	}
	if script.Marker != "" {
		fmt.Fprintf(s.out, "[openclaw] credential %s\n", script.Marker)
	}
	_ = s.out.Flush()
	s.outMu.Unlock()
	stop := nonEmpty(script.StopReason, "end_turn")
	logEvent("prompt_done", map[string]any{"n": n, "key": ss.key, "stopReason": stop})
	s.respond(m.ID, map[string]any{"stopReason": stop})
	if hasWord(text, "EXIT_AFTER") {
		// The child dies between turns, after a complete answer.
		if script.HoldOutputFile != "" {
			holder := exec.Command(os.Args[0], "hold-output", script.HoldOutputFile, strconv.Itoa(os.Getpid()), ss.key)
			holder.Stdout, holder.Stderr = os.Stdout, os.Stderr
			if err := holder.Start(); err != nil {
				logEvent("hold_output_error", map[string]any{"error": err.Error()})
				os.Exit(2)
			}
			exiting.Store(script.HoldExitMs > 0)
			_ = os.Stdin.Close()
			// Close above returns while the reader is still blocked in Read, so fd 0 stays open
			// until the process exits; holdExitMs widens that window (flake-deadchild-deliver).
			// The helper logs stdin_closed_for_exit after the exit.
			time.Sleep(time.Duration(script.HoldExitMs) * time.Millisecond)
			os.Exit(1)
		}
		logEvent("exit_after_reply", map[string]any{"key": ss.key})
		time.Sleep(50 * time.Millisecond)
		os.Exit(1)
	}
}

func (s *acpServer) finishCancelled(id json.RawMessage, ss *session) {
	logEvent("prompt_done", map[string]any{"key": ss.key, "stopReason": "cancelled"})
	s.respond(id, map[string]any{"stopReason": "cancelled"})
}

func (s *acpServer) chunk(sessionID, text string) {
	s.notifyUpdate(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text}})
}

// requestPermission sends one session/request_permission and waits for the client's answer,
// the prompt's cancellation, or PermissionTimeoutMs. It returns the selected optionId,
// "cancelled", "unanswered" or "error".
func (s *acpServer) requestPermission(ctx context.Context, ss *session, spec PermissionSpec) string {
	title := nonEmpty(spec.Title, spec.Kind+": fake")
	options := []any{
		map[string]any{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
		map[string]any{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
	}
	if spec.Options != nil {
		options = options[:0]
		for _, o := range spec.Options {
			options = append(options, o)
		}
	}
	approvalID := newUUID()
	s.mu.Lock()
	id := s.nextOut
	s.nextOut++
	ch := make(chan rpcMsg, 1)
	idRaw := json.RawMessage(fmt.Sprint(id))
	s.waiting[string(idRaw)] = ch
	s.mu.Unlock()
	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": "session/request_permission", "params": map[string]any{
		"sessionId": ss.id,
		"toolCall": map[string]any{
			"toolCallId": "call_" + approvalID[:8], "title": title, "kind": spec.Kind, "status": "pending",
			"rawInput": map[string]any{"name": spec.Kind, "approvalId": approvalID},
			"_meta":    map[string]any{"toolName": spec.Kind, "approvalId": approvalID},
		},
		"options": options,
	}}
	start := time.Now()
	logEvent("permission_request", map[string]any{"id": id, "key": ss.key, "kind": spec.Kind, "title": title})
	s.write(req)
	var timeout <-chan time.Time
	if script.PermissionTimeoutMs > 0 {
		timeout = time.After(time.Duration(script.PermissionTimeoutMs) * time.Millisecond)
	}
	// After cancellation the answer may still arrive; it is recorded by a background waiter.
	record := func(reply rpcMsg) string {
		outcome := "error"
		optionID := ""
		if reply.Result != nil {
			var r struct {
				Outcome struct {
					Outcome  string `json:"outcome"`
					OptionID string `json:"optionId"`
				} `json:"outcome"`
			}
			if json.Unmarshal(reply.Result, &r) == nil {
				switch r.Outcome.Outcome {
				case "selected":
					outcome, optionID = r.Outcome.OptionID, r.Outcome.OptionID
				case "cancelled":
					outcome = "cancelled"
				}
			}
		}
		logEvent("permission_answer", map[string]any{"id": id, "key": ss.key, "kind": spec.Kind, "outcome": outcome,
			"optionId": optionID, "latencyMs": time.Since(start).Milliseconds(), "result": reply.Result, "error": reply.Error})
		return outcome
	}
	select {
	case reply := <-ch:
		return record(reply)
	case <-ctx.Done():
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			select {
			case reply := <-ch:
				record(reply)
			case <-time.After(10 * time.Second):
			}
		}()
		return "cancelled"
	case <-timeout:
		logEvent("permission_unanswered", map[string]any{"id": id, "key": ss.key, "kind": spec.Kind, "waitedMs": time.Since(start).Milliseconds()})
		return "unanswered"
	}
}

func hasWord(text, word string) bool {
	for _, f := range strings.Fields(text) {
		if f == word {
			return true
		}
	}
	return false
}

func askCommands(text string) []PermissionSpec {
	var out []PermissionSpec
	for _, f := range strings.Fields(text) {
		rest, ok := strings.CutPrefix(f, "ASK:")
		if !ok || rest == "" {
			continue
		}
		kind, title, _ := strings.Cut(rest, ":")
		out = append(out, PermissionSpec{Kind: kind, Title: title})
	}
	return out
}

// voiceRegistration reports which of the lane's voice files (<dir>/<first 32 hex of
// sha256(key)>.json and .sock) exist while this prompt is handled, so the readiness prompt can be
// shown to come after the registration. nil when FAKEACP_VOICE_DIR is not in the env.
func voiceRegistration(key string) map[string]any {
	dir := os.Getenv("FAKEACP_VOICE_DIR")
	if dir == "" || key == "" {
		return nil
	}
	sum := sha256.Sum256([]byte(key))
	base := filepath.Join(dir, hex.EncodeToString(sum[:])[:32])
	out := map[string]any{}
	for _, ext := range []string{"json", "sock"} {
		_, err := os.Stat(base + "." + ext)
		out[ext] = err == nil
	}
	return out
}

func toolList() []string {
	tools := script.Tools
	if len(tools) == 0 {
		tools = []string{"exec", "read", "write", "sessionbus"}
	}
	out := []string{}
	for _, t := range tools {
		if script.NoSessionbus && t == "sessionbus" {
			continue
		}
		out = append(out, t)
	}
	return out
}

// bigReply splits exactly total bytes of reply text into chunks. With escapes, the text is
// made of characters that JSON encoders expand (quote, backslash, newline, tab, control, <, >, &).
func bigReply(total int, escapes bool, custom string, chunkBytes int) []string {
	if chunkBytes <= 0 {
		chunkBytes = 64 << 10
	}
	unit := "abcdefghijklmnopqrstuvwxyz0123456789\n"
	if escapes {
		unit = "\"\\\n\t\x01<>&"
	}
	if custom != "" {
		unit = custom
	}
	var b strings.Builder
	for b.Len() < total {
		b.WriteString(unit)
	}
	all := b.String()[:total]
	var out []string
	for len(all) > 0 {
		n := chunkBytes
		if n > len(all) {
			n = len(all)
		}
		out = append(out, all[:n])
		all = all[n:]
	}
	return out
}

func promptText(blocks []json.RawMessage) string {
	var parts []string
	for _, raw := range blocks {
		var b struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &b) == nil && b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// ---------------------------------------------------------------- tripwire

// isJSWhitespace reports whether r matches JavaScript's \s (ECMA-262 WhiteSpace and
// LineTerminator). U+200B is not in it, which is what the wrapper's neutralisation relies on.
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// LiveModelDirective reports whether text holds a live `/model` directive: `/model` at the text
// start or right after a JS whitespace character, followed by the end, JS whitespace or `:`,
// case-insensitive (directives.ts:29-66). `\u200b/model`, `/models` and `a/model` are not live.
func LiveModelDirective(text string) bool {
	const word = "/model"
	for i := 0; i+len(word) <= len(text); {
		if !strings.EqualFold(text[i:i+len(word)], word) {
			_, size := utf8.DecodeRuneInString(text[i:])
			i += size
			continue
		}
		startOK := i == 0
		if !startOK {
			prev, _ := utf8.DecodeLastRuneInString(text[:i])
			startOK = isJSWhitespace(prev)
		}
		endOK := i+len(word) == len(text)
		if !endOK {
			next, _ := utf8.DecodeRuneInString(text[i+len(word):])
			endOK = next == ':' || isJSWhitespace(next)
		}
		if startOK && endOK {
			return true
		}
		i += len(word)
	}
	return false
}
