package lane_test

import (
	"encoding/json"
	"strings"
	"testing"

	kit "github.com/antst/sessionbus/bus/sdk/go"
)

// Every session/request_permission is answered, per the caller's permission_mode.
// The fake raises the requests (ASK:<kind> in the prompt, or scripted) and records each answer.

func TestPermissionPolicyTable(t *testing.T) {
	for _, tc := range []struct {
		mode          string
		read, execute string // optionId the fake must receive
	}{
		{"", "allow-once", "deny"},
		{"default", "allow-once", "deny"},
		{"bypassPermissions", "allow-once", "allow-once"},
		{"plan", "deny", "deny"},
	} {
		t.Run("mode="+tc.mode, func(t *testing.T) {
			e := newEnv(t)
			h := e.start()
			h.mustOpen(kit.OpenOptions{PermissionMode: tc.mode})
			text := completed(t, h.Execute("tools ASK:read:read-notes ASK:execute:exec-id"))
			mustContain(t, "reply", text, "PERMISSION read -> "+tc.read+"\n", "PERMISSION execute -> "+tc.execute+"\n")
			var got []string
			for _, a := range e.events("permission_answer") {
				if a["kind"] == "read" || a["kind"] == "execute" {
					got = append(got, str(a["kind"])+"="+str(a["optionId"]))
				}
			}
			want := []string{"read=" + tc.read, "execute=" + tc.execute}
			if strings.Join(got, ",") != strings.Join(want, ",") {
				t.Fatalf("answers %v, want %v", got, want)
			}
		})
	}
}

// The caller's mode is in force from acp.Start on: Open (fresh and resume) raises no permission
// request of its own, and the first caller prompt's request is answered by the mode's policy —
// never as the empty/default mode.
func TestPermissionDuringFirstPromptFollowsMode(t *testing.T) {
	for _, tc := range []struct{ mode, kind, want string }{
		{"plan", "read", "deny"},
		{"bypassPermissions", "execute", "allow-once"},
	} {
		t.Run(tc.mode+"+"+tc.kind, func(t *testing.T) {
			e := newEnv(t)
			e.script = `{"permissions":[{"kind":"` + tc.kind + `","title":"first prompt"}]}`
			h := e.start()
			key := h.mustOpen(kit.OpenOptions{PermissionMode: tc.mode})
			if ps := e.callerPrompts(); len(ps) != 0 {
				t.Fatalf("prompts during Open: %v", ps)
			}
			if as := e.events("permission_answer"); len(as) != 0 {
				t.Fatalf("Open raised answers %v, want none", answerIDs(as))
			}
			completed(t, h.Execute("one caller turn"))
			if as := e.events("permission_answer"); len(as) != 1 || as[0]["optionId"] != tc.want {
				t.Fatalf("first-prompt answers %v, want exactly one %s", answerIDs(as), tc.want)
			}
			h.Close()
			before := len(e.events("permission_answer"))
			h2 := e.start()
			h2.mustResume(key, kit.OpenOptions{PermissionMode: tc.mode})
			if as := e.events("permission_answer"); len(as) != before {
				t.Fatalf("resume raised %d answer(s), want 0", len(as)-before)
			}
			completed(t, h2.Execute("resumed caller turn"))
			as := e.events("permission_answer")
			if len(as) != before+1 || as[len(as)-1]["optionId"] != tc.want {
				t.Fatalf("resume first-prompt answers %v, want one more %s", answerIDs(as), tc.want)
			}
		})
	}
}

func answerIDs(as []logRec) []string {
	var out []string
	for _, a := range as {
		out = append(out, str(a["kind"])+"="+str(a["optionId"]))
	}
	return out
}

func TestPermissionUnknownModeRejected(t *testing.T) {
	for _, mode := range []string{"acceptEdits", "dontAsk", "BYPASS"} {
		e := newEnv(t)
		_, err := e.start().Open(kit.OpenOptions{PermissionMode: mode})
		mustContain(t, "open error", rpcText(err), "unsupported value permission_mode="+mode)
		e.noNativeWork(t)
	}
}

func TestPermissionAlwaysAnswered(t *testing.T) {
	for _, script := range []string{
		`{"permissions":[{"kind":"execute","title":"exec: id"}]}`,
		`{"permissions":[{"kind":"read","title":"read: a"},{"kind":"fetch","title":"fetch: b"},{"kind":"search"}]}`,
		// no allow/reject option → cancelled; a malformed option list is still answered
		`{"permissions":[{"kind":"read","options":[{"optionId":"x","name":"X","kind":"other"}]}]}`,
		`{"permissions":[{"kind":"execute","options":["malformed",7]}]}`,
	} {
		e := newEnv(t)
		e.script = script
		h := e.start()
		h.mustOpen(kit.OpenOptions{})
		completed(t, h.Execute("go"))
		reqs, answers := e.events("permission_request"), e.events("permission_answer")
		if len(reqs) == 0 || len(answers) != len(reqs) {
			t.Fatalf("script %s: %d requests, %d answers", script, len(reqs), len(answers))
		}
		for _, a := range answers {
			if ms, _ := a["latencyMs"].(float64); ms > 1000 {
				t.Fatalf("script %s: answer after %v ms", script, ms)
			}
			if a["outcome"] == "error" {
				t.Fatalf("script %s: answered with a JSON-RPC error: %v", script, a)
			}
		}
		if strings.Contains(script, `"other"`) && answers[len(answers)-1]["outcome"] != "cancelled" {
			t.Fatalf("no allow/reject option: outcome %v, want cancelled", answers[len(answers)-1]["outcome"])
		}
		if len(e.events("permission_unanswered")) != 0 {
			t.Fatalf("script %s: a request went unanswered", script)
		}
	}
}

// A request that arrives while the lane closes (the fake raises it on session/close) is answered,
// never left pending, and never allowed.
func TestPermissionDeniedOnClose(t *testing.T) {
	e := newEnv(t)
	e.script = `{"permissionOnClose":true}`
	h := e.start()
	h.mustOpen(kit.OpenOptions{})
	completed(t, h.Execute("hi"))
	h.Close()
	eventually(t, "the on-close request to settle", func() bool {
		return len(e.events("permission_answer"))+len(e.events("permission_unanswered")) > 0
	})
	if u := e.events("permission_unanswered"); len(u) != 0 {
		t.Fatalf("permission request left unanswered at close: %v", u)
	}
	for _, a := range e.events("permission_answer") {
		if strings.HasPrefix(str(a["optionId"]), "allow") {
			t.Fatalf("permission allowed during close: %v", a)
		}
	}
}

// A request raised while the lane closes is answered per the lane's mode, so
// Close keeps the mode until session/close is done: bypassPermissions → allow-once.
func TestPermissionOnCloseFollowsMode(t *testing.T) {
	e := newEnv(t)
	e.script = `{"permissionOnClose":true}`
	h := e.start()
	h.mustOpen(kit.OpenOptions{PermissionMode: "bypassPermissions"})
	completed(t, h.Execute("hi"))
	h.Close()
	eventually(t, "the on-close request to settle", func() bool {
		return len(e.events("permission_answer"))+len(e.events("permission_unanswered")) > 0
	})
	a := e.events("permission_answer")
	if len(a) != 1 || a[0]["optionId"] != "allow-once" {
		t.Fatalf("on-close answer %v (unanswered %v), want allow-once under bypassPermissions", a, e.events("permission_unanswered"))
	}
}

// Since any group member can request exec, write one worker stderr line per
// decision, `permission <mode> <tool title ≤80> -> allow|deny`; the child-supplied title
// cannot forge or split a line.
func TestPermissionDecisionLogged(t *testing.T) {
	for _, tc := range []struct{ mode, read, execute string }{
		{"default", "allow", "deny"},
		{"plan", "deny", "deny"},
		{"bypassPermissions", "allow", "allow"},
	} {
		e := newEnv(t)
		forged := "exec: x\npermission " + tc.mode + " forged -> allow\r" + strings.Repeat("y", 120)
		b, _ := json.Marshal(map[string]any{"permissions": []any{map[string]any{"kind": "execute", "title": forged}}})
		e.script = string(b)
		h := e.startBinary()
		h.mustOpen(kit.OpenOptions{PermissionMode: tc.mode})
		completed(t, h.Execute("tools ASK:read:read-notes ASK:execute:exec-id"))
		h.Close()
		var lines []string
		for _, l := range strings.Split(h.workerStderr(), "\n") {
			if strings.HasPrefix(l, "permission ") {
				lines = append(lines, l)
			}
		}
		decisions := len(e.events("permission_answer"))
		if len(lines) != decisions || decisions < 3 {
			t.Fatalf("mode %s: %d permission lines for %d decisions (want ≥3, one line each): %q", tc.mode, len(lines), decisions, lines)
		}
		want := map[string]bool{
			"permission " + tc.mode + " read-notes -> " + tc.read: false,
			"permission " + tc.mode + " exec-id -> " + tc.execute: false,
		}
		for _, l := range lines {
			if _, ok := want[l]; ok {
				want[l] = true
			}
			if strings.Contains(l, "forged") && !strings.HasPrefix(l, "permission "+tc.mode+" exec: x") {
				t.Fatalf("mode %s: forged line %q", tc.mode, l)
			}
			if strings.ContainsAny(l, "\r\x00") {
				t.Fatalf("mode %s: control character in %q", tc.mode, l)
			}
			title := strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(l, "permission "+tc.mode+" "), " -> allow"), " -> deny")
			if len([]rune(title)) > 80 {
				t.Fatalf("mode %s: title of %d runes in %q", tc.mode, len([]rune(title)), l)
			}
		}
		for l, seen := range want {
			if !seen {
				t.Fatalf("mode %s: missing stderr line %q in %q", tc.mode, l, lines)
			}
		}
	}
}

// An *_always option persists the decision for the agent beyond this lane and caller
// (the caller's mode decides), so it is never selected; *_once is preferred whatever
// the option order. Option ids/kinds follow 8.2 permission-relay.ts:48-73.
func TestPermissionNeverAlways(t *testing.T) {
	opt := func(id, kind string) map[string]any { return map[string]any{"optionId": id, "name": id, "kind": kind} }
	allowAlways, allowOnce := opt("allow-always", "allow_always"), opt("allow-once", "allow_once")
	rejectAlways, rejectOnce := opt("reject-always", "reject_always"), opt("deny", "reject_once")
	for _, tc := range []struct {
		name, mode, kind string
		options          []any
		want             string // exact optionId, or "" = anything but an *_always id (cancelled allowed)
	}{
		{"bypass prefers allow_once over an earlier allow_always", "bypassPermissions", "execute", []any{allowAlways, allowOnce, rejectOnce}, "allow-once"},
		{"default read prefers allow_once", "default", "read", []any{allowAlways, allowOnce, rejectOnce}, "allow-once"},
		{"plan prefers reject_once over an earlier reject_always", "plan", "execute", []any{allowOnce, rejectAlways, rejectOnce}, "deny"},
		{"default exec prefers reject_once", "default", "execute", []any{rejectAlways, allowAlways, rejectOnce}, "deny"},
		{"bypass with only allow_always", "bypassPermissions", "execute", []any{allowAlways, rejectOnce}, ""},
		{"plan with only reject_always", "plan", "execute", []any{allowOnce, rejectAlways}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			b, _ := json.Marshal(map[string]any{"permissions": []any{map[string]any{"kind": tc.kind, "title": "cr406", "options": tc.options}}})
			e.script = string(b)
			h := e.start()
			h.mustOpen(kit.OpenOptions{PermissionMode: tc.mode})
			completed(t, h.Execute("go"))
			got := e.events("permission_answer")
			if len(got) == 0 {
				t.Fatal("request not answered")
			}
			for _, a := range got {
				id := str(a["optionId"])
				if strings.HasSuffix(id, "-always") {
					t.Fatalf("selected %s", id)
				}
				if tc.want != "" && id != tc.want {
					t.Fatalf("selected %q (outcome %v), want %s", id, a["outcome"], tc.want)
				}
				if a["outcome"] == "error" {
					t.Fatalf("answered with an error: %v", a)
				}
			}
		})
	}
}
