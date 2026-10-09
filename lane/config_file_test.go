package lane

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/imortkz/openclaw-peer/lane/internal/fakebridge"
)

// bridgeEnv serves settings from a fakebridge and returns an environment pointing at it.
func bridgeEnv(t *testing.T, settings any) []string {
	t.Helper()
	srv := fakebridge.Start(t, fakebridge.Options{Settings: settings})
	return []string{"SESSIONBUS_OPENCLAW_BRIDGE=" + srv.Endpoint, "HOME=" + t.TempDir()}
}

// loadConfig is LoadConfig with the bridge closed at test end.
func loadConfig(t *testing.T, env []string) (Config, error) {
	t.Helper()
	cfg, bridge, err := LoadConfig(env)
	t.Cleanup(bridge.Close)
	return cfg, err
}

func TestLoadConfigFromBridge(t *testing.T) {
	env := bridgeEnv(t, map[string]any{"agents": []Agent{{ID: "lane", Workspace: "/tmp/lane", Description: "Lane role"}}, "credentialDir": "/tmp/lane-cli", "auditLog": "/tmp/audit"})
	cfg, bridge, err := LoadConfig(env)
	defer bridge.Close()
	if err != nil || cfg.SettingsErr != nil || bridge == nil {
		t.Fatalf("load: cfg=%+v bridge=%v err=%v", cfg, bridge, err)
	}
	if len(cfg.Agents) != 1 || cfg.Agents[0].ID != "lane" || cfg.CredentialDir != "/tmp/lane-cli" || cfg.AuditLog != "/tmp/audit" {
		t.Fatalf("wrong settings: %+v", cfg)
	}
}

func TestLegacyVariablesRefused(t *testing.T) {
	_, _, err := LoadConfig([]string{"OPENCLAW_LANE_VOICE_DIR=/old", "OPENCLAW_LANE_AGENTS=[]"})
	if err == nil || !strings.Contains(err.Error(), "OPENCLAW_LANE_AGENTS, OPENCLAW_LANE_VOICE_DIR") || !strings.Contains(err.Error(), "bridge") {
		t.Fatalf("legacy refusal: %v", err)
	}
}

func TestChildEnvUsesCredentialDir(t *testing.T) {
	cfg := Config{CredentialDir: "/lane-cli"}
	env := cfg.ChildEnv([]string{"HOME=/tmp", "OPENCLAW_STATE_DIR=/admin", "OPENCLAW_CONFIG_PATH=/admin/openclaw.json"})
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "/admin") || !strings.Contains(joined, "OPENCLAW_STATE_DIR=/lane-cli") || !strings.Contains(joined, "OPENCLAW_CONFIG_PATH=/lane-cli/openclaw.json") {
		t.Fatalf("wrong child env: %q", joined)
	}
}

func TestLoadConfigWithoutBridge(t *testing.T) {
	endpoint := filepath.Join(t.TempDir(), "none.sock")
	cfg, bridge, err := LoadConfig([]string{"SESSIONBUS_OPENCLAW_BRIDGE=" + endpoint})
	if err != nil || cfg.SettingsErr == nil || bridge != nil {
		t.Fatalf("load: %+v %v %v", cfg, bridge, err)
	}
	if !strings.Contains(cfg.SettingsErr.Error(), endpoint) || !strings.Contains(cfg.SettingsErr.Error(), "SESSIONBUS_OPENCLAW_BRIDGE") {
		t.Fatalf("hint: %v", cfg.SettingsErr)
	}
	hello, err := New(cfg, nil).Hello(context.Background())
	if err != nil || !strings.Contains(hello.ExtraArguments[0].Description, "lane settings unavailable: bridge "+endpoint) {
		t.Fatalf("hello: %+v %v", hello, err)
	}
}

func TestOpenWithoutBridgeRefuses(t *testing.T) {
	cfg, _, err := LoadConfig([]string{"SESSIONBUS_OPENCLAW_BRIDGE=" + filepath.Join(t.TempDir(), "none.sock")})
	if err != nil || cfg.SettingsErr == nil {
		t.Fatalf("load: %+v %v", cfg, err)
	}
	w := New(cfg, nil)
	for _, request := range []kit.OpenRequest{{}, {ResumeSessionID: "agent:lane:sb-12345678-1234-4123-8123-123456789abc"}} {
		_, err := w.Open(context.Background(), request)
		if err == nil || !strings.Contains(err.Error(), "sessionbus plugin installed") || !strings.Contains(err.Error(), "SESSIONBUS_OPENCLAW_BRIDGE") || strings.Contains(err.Error(), "channels.sessionbus.enabled") {
			t.Fatalf("Open: %v", err)
		}
	}
}

func TestOpenWithInvalidSettings(t *testing.T) {
	env := bridgeEnv(t, map[string]any{"agents": []Agent{{ID: "lane", Workspace: "relative"}}, "credentialDir": "/tmp/cli"})
	cfg, err := loadConfig(t, env)
	if err != nil || cfg.SettingsErr == nil {
		t.Fatalf("load: %+v %v", cfg, err)
	}
	_, err = New(cfg, nil).Open(context.Background(), kit.OpenRequest{})
	if err == nil || !strings.Contains(err.Error(), "lanes.agents[0].workspace") || !strings.Contains(err.Error(), "fix plugins.entries.sessionbus.config.lanes") {
		t.Fatalf("Open: %v", err)
	}
}
