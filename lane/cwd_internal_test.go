package lane

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A regular file inside the agent's workspace is not an acceptable cwd (exec would fail
// on it later); ResolveCwd should refuse it directly, before any lock or gateway call.
func TestResolveCwdRejectsRegularFile(t *testing.T) {
	root := t.TempDir()
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	agent := Agent{ID: "lane", Workspace: root}
	file := filepath.Join(root, "not-a-dir")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = ResolveCwd(agent, file)
	if err == nil {
		t.Fatal("a regular file was accepted as a cwd")
	}
	if got := err.Error(); got != "unsupported value cwd="+file+" (not a directory)" {
		t.Fatalf("error = %q, want unsupported value cwd=%s (not a directory)", got, file)
	}
}

// OpenClaw 8.2's CLI auto-retries a missing-operator.admin sessions.create
// refusal using the same non-admin device token, which fails as "device token scope mismatch
// (re-pair or approve scope upgrade)" instead of naming operator.admin. Repeated refusals established that
// retry never creates a pending pairing/scope-upgrade request and never widens the device's
// scopes, so the wrapper must not let that wording read as an actionable suggestion.
func TestFormatCwdGatewayRefusalNamesNonAdminByDesign(t *testing.T) {
	got := formatCwdGatewayRefusal("/tmp/x", "unauthorized: device token scope mismatch (re-pair or approve scope upgrade)")
	want := "unsupported value cwd=/tmp/x (refused by OpenClaw: outside the agent workspace; the lane credential is non-admin by design — do not approve a scope upgrade: unauthorized: device token scope mismatch (re-pair or approve scope upgrade))"
	if got != want {
		t.Fatalf("formatCwdGatewayRefusal =\n%q\nwant\n%q", got, want)
	}
	if !strings.Contains(got, "device token scope mismatch (re-pair or approve scope upgrade)") {
		t.Fatalf("formatCwdGatewayRefusal dropped the raw Gateway text: %q", got)
	}
}

// Any other Gateway refusal (for example the clean, non-escalated missing-operator.admin
// message) must keep its plain text unmodified — the special wording is only for the
// scope-mismatch retry failure.
func TestFormatCwdGatewayRefusalLeavesOtherMessagesUnmodified(t *testing.T) {
	got := formatCwdGatewayRefusal("/tmp/x", "missing scope: operator.admin")
	want := "unsupported value cwd=/tmp/x (refused by OpenClaw: missing scope: operator.admin)"
	if got != want {
		t.Fatalf("formatCwdGatewayRefusal =\n%q\nwant\n%q", got, want)
	}
}
