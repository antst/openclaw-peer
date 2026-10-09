package lane

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestW1ConfigAndHello(t *testing.T) {
	env := bridgeEnv(t, map[string]any{"agents": []Agent{{ID: "writer", Workspace: "/tmp/writer", Description: "Writes copy"}, {ID: "reviewer", Workspace: "/tmp/reviewer", Description: "Reviews copy"}}, "credentialDir": "/tmp/cli"})
	cfg, err := loadConfig(t, env)
	if err != nil || cfg.SettingsErr != nil {
		t.Fatalf("load: %+v %v", cfg, err)
	}
	hello, err := New(cfg, nil).Hello(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(hello.ExtraArguments[0].Description, "writer — Writes copy; reviewer — Reviews copy") {
		t.Fatalf("hello: %+v", hello)
	}
}

// The plugin publishes descriptions of up to 120 grapheme clusters
// (src/lanes.js, OpenClaw's TypeBox maxLength); the worker must accept
// every description the plugin publishes.
func TestConfigAcceptsPublishedCombiningMarkDescription(t *testing.T) {
	desc := strings.Repeat("é", 120)
	cfg, err := loadConfig(t, bridgeEnv(t, map[string]any{"agents": []Agent{{ID: "a", Workspace: "/tmp/a", Description: desc}}, "credentialDir": "/tmp/cli"}))
	if err != nil || cfg.SettingsErr != nil {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
	if cfg.Agents[0].Description != desc {
		t.Fatalf("description = %q", cfg.Agents[0].Description)
	}
}

func TestW1ConfigRejectsInvalidValues(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
		field  string
	}{
		{"missing agents", func(m map[string]any) { delete(m, "agents") }, "lanes.agents"},
		{"duplicate ids", func(m map[string]any) {
			m["agents"] = []Agent{{ID: "a", Workspace: "/tmp/a"}, {ID: "a", Workspace: "/tmp/b"}}
		}, "lanes.agents"},
		{"relative workspace", func(m map[string]any) { m["agents"] = []Agent{{ID: "a", Workspace: "relative"}} }, "workspace"},
		{"multiline description", func(m map[string]any) { m["agents"] = []Agent{{ID: "a", Workspace: "/tmp/a", Description: "x\ny"}} }, "description"},
		{"relative credential", func(m map[string]any) { m["credentialDir"] = "relative" }, "credentialDir"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]any{"agents": []Agent{{ID: "a", Workspace: "/tmp/a"}}, "credentialDir": "/tmp/cli"}
			tc.mutate(m)
			cfg, err := loadConfig(t, bridgeEnv(t, m))
			if err != nil || cfg.SettingsErr == nil || !strings.Contains(cfg.SettingsErr.Error(), tc.field) {
				t.Fatalf("cfg=%+v err=%v", cfg, err)
			}
		})
	}
}

func TestW1ConfigAgentModels(t *testing.T) {
	models := map[string]any{"allow": []string{"openrouter/*", "glm"}, "default": "zai/glm-5.3"}
	load := func(models map[string]any) Config {
		cfg, err := loadConfig(t, bridgeEnv(t, map[string]any{"agents": []map[string]any{{"id": "a", "workspace": "/tmp/a", "models": models}}, "credentialDir": "/tmp/cli"}))
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}
	cfg := load(models)
	if cfg.SettingsErr != nil {
		t.Fatal(cfg.SettingsErr)
	}
	raw, err := json.Marshal(cfg.Agents[0])
	if err != nil {
		t.Fatal(err)
	}
	var agent map[string]any
	if err := json.Unmarshal(raw, &agent); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"allow": []any{"openrouter/*", "glm"}, "default": "zai/glm-5.3"}
	if !reflect.DeepEqual(agent["models"], want) {
		t.Fatalf("round-trip models = %v, want %v", agent["models"], want)
	}
	for _, control := range []string{"\n", "\r", "\t", "\x00", "\x1b", "\x7f", "\u0085"} {
		for _, field := range []string{"allow", "default"} {
			t.Run(fmt.Sprintf("%s/%x", field, control), func(t *testing.T) {
				bad := map[string]any{"allow": []string{"mock/a"}, "default": "mock/a"}
				if field == "allow" {
					bad[field] = []string{"mock/" + control + "a"}
				} else {
					bad[field] = "mock/" + control + "a"
				}
				cfg := load(bad)
				if cfg.SettingsErr == nil || !strings.Contains(cfg.SettingsErr.Error(), "lanes.agents[0].models") {
					t.Fatalf("error = %v", cfg.SettingsErr)
				}
			})
		}
	}
	cfg = load(map[string]any{"allow": []string{}, "unknown": true})
	if cfg.SettingsErr == nil || !strings.Contains(cfg.SettingsErr.Error(), `unknown field "unknown"`) {
		t.Fatalf("unknown models field accepted: %v", cfg.SettingsErr)
	}
}
