// Command permprobe is a minimal ACP JSON-RPC child, built and used only by
// lane/wrapper_permission_readiness_test.go to pin the readiness race: it raises a
// session/request_permission request while the wrapper's own readiness prompt
// ("/tools compact") is in flight, before replying to it — the exact window that request found
// unguarded. It is a developer-owned probe, independent of lane/internal/fakeacp (test-writer's).
package main

import (
	"bufio"
	"encoding/json"
	"os"
)

type inMsg struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func write(out *bufio.Writer, v any) {
	b, _ := json.Marshal(v)
	_, _ = out.Write(b)
	_, _ = out.WriteString("\n")
	_ = out.Flush()
}

func main() {
	// The readiness tests need the launcher shape: [permprobe,"acp"] and
	// [permprobe,"gateway","call"]. Only the harmless admin-scope probe is served.
	if len(os.Args) >= 4 && os.Args[1] == "gateway" && os.Args[2] == "call" {
		if os.Args[3] == "exec.approvals.get" {
			b, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]any{
				"type": "gateway_request_error", "code": "FORBIDDEN", "message": "missing scope: operator.admin",
				"details": map[string]any{"missingScope": "operator.admin"},
			}})
			_, _ = os.Stdout.Write(append(b, '\n'))
			os.Exit(1)
		}
		os.Exit(2)
	}
	if len(os.Args) != 2 || os.Args[1] != "acp" {
		os.Exit(2)
	}
	runACP()
}

func runACP() {
	kind := os.Getenv("PERMPROBE_KIND")
	logPath := os.Getenv("PERMPROBE_LOG")

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64<<10), 8<<20)
	out := bufio.NewWriter(os.Stdout)
	const sessionID = "permprobe-session"

	for in.Scan() {
		var m inMsg
		if json.Unmarshal(in.Bytes(), &m) != nil {
			continue
		}
		switch m.Method {
		case "initialize":
			write(out, map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(m.ID), "result": map[string]any{}})
		case "session/new":
			write(out, map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(m.ID), "result": map[string]any{"sessionId": sessionID}})
		case "session/resume":
			write(out, map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(m.ID), "result": map[string]any{}})
		case "session/prompt":
			// Echo back whatever sessionId this prompt named (fresh Open's minted probe id, or
			// the resume key itself): onUpdate only accepts an update whose
			// sessionId matches process.SetUpdateSessionID's argument, which differs between the
			// two paths.
			var p struct {
				SessionID string `json:"sessionId"`
			}
			_ = json.Unmarshal(m.Params, &p)
			write(out, map[string]any{
				"jsonrpc": "2.0", "id": "perm-1", "method": "session/request_permission",
				"params": map[string]any{
					"toolCall": map[string]any{"kind": kind, "title": "permprobe"},
					"options": []map[string]any{
						{"optionId": "allow", "kind": "allow_once"},
						{"optionId": "deny", "kind": "reject_once"},
					},
				},
			})
			for in.Scan() {
				var ans struct {
					ID     json.RawMessage `json:"id"`
					Result struct {
						Outcome struct {
							Outcome  string `json:"outcome"`
							OptionID string `json:"optionId"`
						} `json:"outcome"`
					} `json:"result"`
				}
				if json.Unmarshal(in.Bytes(), &ans) == nil && string(ans.ID) == `"perm-1"` {
					if logPath != "" {
						line, _ := json.Marshal(map[string]string{"outcome": ans.Result.Outcome.Outcome, "optionId": ans.Result.Outcome.OptionID})
						f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
						if err == nil {
							_, _ = f.Write(append(line, '\n'))
							_ = f.Close()
						}
					}
					break
				}
			}
			write(out, map[string]any{
				"jsonrpc": "2.0", "method": "session/update",
				"params": map[string]any{"sessionId": p.SessionID, "update": map[string]any{
					"sessionUpdate": "agent_message_chunk",
					"content":       map[string]any{"type": "text", "text": "Tools (compact): sessionbus"},
				}},
			})
			write(out, map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(m.ID), "result": map[string]any{"stopReason": "end_turn"}})
		default:
			write(out, map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(m.ID), "result": map[string]any{}})
		}
	}
}
