package lane

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPermissionAuditFileAppendAndFailure(t *testing.T) {
	root := t.TempDir()
	audit := filepath.Join(root, "permission.log")
	config := func(path string) Config {
		t.Helper()
		cfg, err := loadConfig(t, bridgeEnv(t, map[string]any{"agents": []Agent{{ID: "lane", Workspace: root}}, "credentialDir": "/tmp/cli", "auditLog": path}))
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}
	request := []byte(`{"toolCall":{"kind":"execute","title":"exec\nid"},"options":[{"optionId":"deny","kind":"reject_once"}]}`)
	w := New(config(audit), nil)
	w.permissionMode = "default"
	for i := 0; i < 2; i++ {
		if _, err := w.answerPermission(context.Background(), "session/request_permission", request); err != nil {
			t.Fatalf("decision %d failed: %v", i, err)
		}
	}
	data, err := os.ReadFile(audit)
	if err != nil {
		t.Fatalf("audit file missing: %v", err)
	}
	if got, want := string(data), "permission default execid -> deny\npermission default execid -> deny\n"; got != want {
		t.Fatalf("audit lines = %q, want %q", got, want)
	}
	info, err := os.Stat(audit)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("audit file mode = %04o, want 0600", info.Mode().Perm())
	}
	bad, err := loadConfig(t, bridgeEnv(t, map[string]any{"agents": []Agent{{ID: "lane", Workspace: root}}, "credentialDir": "/tmp/cli", "auditLog": "relative.log"}))
	if err != nil || bad.SettingsErr == nil || !strings.Contains(bad.SettingsErr.Error(), "lanes.auditLog") {
		t.Fatalf("relative audit path error = %v, want named field", bad.SettingsErr)
	}

	blocked := New(config(filepath.Join(root, "missing", "permission.log")), nil)
	blocked.permissionMode = "default"
	response, err := blocked.answerPermission(context.Background(), "session/request_permission", request)
	if err != nil {
		t.Fatalf("audit write failure changed the permission answer: %v", err)
	}
	outer, ok := response.(map[string]any)
	if !ok {
		t.Fatalf("unexpected permission response: %v", response)
	}
	outcome, ok := outer["outcome"].(map[string]string)
	if !ok || outcome["outcome"] != "selected" || outcome["optionId"] != "deny" {
		t.Fatalf("audit write failure changed the permission answer: response=%v err=%v", response, err)
	}
}
