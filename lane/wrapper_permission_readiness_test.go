package lane_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/imortkz/openclaw-peer/lane"
)

// This file pins that the caller's permission_mode is in force from acp.Start on, so a
// session/request_permission raised on the first prompt is decided under Open.PermissionMode,
// not "". permprobe (lane/internal/permprobe) is a minimal standalone ACP child that raises one
// on any prompt.

// buildPermprobe builds a fresh copy into t.TempDir() per call (the earlier package-level
// sync.Once + os.MkdirTemp("",...) was never removed — a leaked temp dir with a binary in it per
// go test run, 16 of them accumulated on one dev machine over this engagement). t.TempDir() ties
// removal to the calling test, at the cost of one extra `go build` for the second caller — a
// package this small builds in well under a second.
func buildPermprobe(t *testing.T) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "permprobe")
	cmd := exec.Command("go", "build", "-mod=vendor", "-o", out, "./internal/permprobe")
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("build permprobe: %v", err)
	}
	return out
}

// The same permprobe executable backs both commands required by the launcher invariant.
// The Gateway path must fail the admin probe with the exact non-admin scope refusal, so Open
// can proceed to the first ACP permission request.
func TestPermprobeGatewayRefusesAdminScope(t *testing.T) {
	probe := buildPermprobe(t)
	setPermprobeCommands(t, probe)
	if _, _, err := lane.LoadConfig(os.Environ()); err != nil {
		t.Fatalf("permprobe commands violate worker config: %v", err)
	}
	cmd := exec.Command(probe, "gateway", "call", "exec.approvals.get", "--json", "--params", "{}")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("admin probe unexpectedly succeeded: %s", out)
	}
	var reply struct {
		OK    bool `json:"ok"`
		Error struct {
			Type    string `json:"type"`
			Code    string `json:"code"`
			Details struct {
				MissingScope string `json:"missingScope"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(out, &reply) != nil || reply.OK || reply.Error.Type != "gateway_request_error" || reply.Error.Code != "FORBIDDEN" || reply.Error.Details.MissingScope != "operator.admin" {
		t.Fatalf("admin probe refusal = %q, want FORBIDDEN missingScope=operator.admin", out)
	}
}

func setPermprobeCommands(t *testing.T, probe string) {
	t.Helper()
	bin := t.TempDir()
	if err := os.Symlink(probe, filepath.Join(bin, "openclaw")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// permprobeDecision reads the single permission decision permprobe recorded (see
// internal/permprobe/main.go): the optionId answerPermission actually selected.
func permprobeDecision(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read permprobe log: %v", err)
	}
	var lines [][]byte
	for _, l := range bytes.Split(b, []byte("\n")) {
		if len(l) > 0 {
			lines = append(lines, l)
		}
	}
	if len(lines) != 1 {
		t.Fatalf("permprobe log: want exactly one decision, got %d: %q", len(lines), b)
	}
	var rec struct {
		OptionID string `json:"optionId"`
	}
	if err := json.Unmarshal(lines[0], &rec); err != nil {
		t.Fatalf("permprobe log line: %v", err)
	}
	return rec.OptionID
}

// TestPermissionModeAppliesDuringFreshFirstPrompt drives a fresh Open whose ACP child (permprobe)
// raises a session/request_permission on the first prompt, while Open's own
// fields (including permissionMode) are published. Before the fix, answerPermission
// saw permission_mode "" instead of the caller's mode in both directions:
//   - "plan" (deny everything) + a "read" request was wrongly approved (mode "" approves reads);
//   - "bypassPermissions" (approve everything) + an "execute" request was wrongly denied (mode ""
//     only approves reads).
func TestPermissionModeAppliesDuringFreshFirstPrompt(t *testing.T) {
	probe := buildPermprobe(t)
	cases := []struct {
		name         string
		mode         string
		kind         string
		wantOptionID string
	}{
		{"plan denies a read request", "plan", "read", "deny"},
		{"bypassPermissions allows an execute request", "bypassPermissions", "execute", "allow"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			logPath := filepath.Join(e.dir, "permprobe.log")
			setPermprobeCommands(t, probe)
			t.Setenv("PERMPROBE_KIND", tc.kind)
			t.Setenv("PERMPROBE_LOG", logPath)
			h := e.start()
			h.mustOpen(kit.OpenOptions{PermissionMode: tc.mode})
			h.Execute("first prompt")
			got := permprobeDecision(t, logPath)
			if got != tc.wantOptionID {
				t.Fatalf("permission_mode=%s kind=%s: first-prompt request answered optionId=%q, want %q (the caller's mode must be in force before the first session/request_permission, not \"\")",
					tc.mode, tc.kind, got, tc.wantOptionID)
			}
			h.Close()
		})
	}
}

// TestPermissionModeAppliesDuringResumeFirstPrompt is the resume-path twin (same attach).
func TestPermissionModeAppliesDuringResumeFirstPrompt(t *testing.T) {
	probe := buildPermprobe(t)
	e := newEnv(t)
	setPermprobeCommands(t, probe)
	t.Setenv("PERMPROBE_KIND", "read")
	t.Setenv("PERMPROBE_LOG", filepath.Join(e.dir, "permprobe-open.log"))
	h := e.start()
	key := h.mustOpen(kit.OpenOptions{PermissionMode: "bypassPermissions"})
	h.Close()

	logPath := filepath.Join(e.dir, "permprobe-resume.log")
	t.Setenv("PERMPROBE_LOG", logPath)
	h2 := e.start()
	h2.mustResume(key, kit.OpenOptions{PermissionMode: "plan"})
	h2.Execute("first prompt")
	if got := permprobeDecision(t, logPath); got != "deny" {
		t.Fatalf("resume first prompt: permission_mode=plan kind=read: answered optionId=%q, want \"deny\" (the caller's mode must be in force before resume's first session/request_permission, not \"\")", got)
	}
	h2.Close()
}
