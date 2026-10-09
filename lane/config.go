package lane

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

type Agent struct {
	ID          string       `json:"id"`
	Workspace   string       `json:"workspace"`
	Description string       `json:"description,omitempty"`
	Models      *AgentModels `json:"models,omitempty"`
}
type AgentModels struct {
	// A nil Allow means no policy information; an explicit empty array means any model.
	Allow   []string `json:"allow"`
	Default string   `json:"default,omitempty"`
}

type Config struct {
	Agents                  []Agent
	AuditLog, CredentialDir string
	SettingsErr             error
}

var agentIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func envValues(env []string) map[string]string {
	v := make(map[string]string, len(env))
	for _, entry := range env {
		if k, value, ok := strings.Cut(entry, "="); ok {
			v[k] = value
		}
	}
	return v
}

// LoadConfig reads the lane settings from the plugin over the bridge. An unreachable bridge or
// invalid settings come back as Config.SettingsErr (the worker still starts; Open refuses with
// the hint); the returned *Bridge is nil in that case.
func LoadConfig(env []string) (Config, *Bridge, error) {
	v := envValues(env)
	var legacy []string
	for name := range v {
		if strings.HasPrefix(name, "OPENCLAW_LANE_") {
			legacy = append(legacy, name)
		}
	}
	if len(legacy) > 0 {
		sort.Strings(legacy)
		return Config{}, nil, fmt.Errorf("%s no longer used: lane settings live in openclaw.json under plugins.entries.sessionbus.config.lanes and reach the worker over the bridge (see lane/README.md); remove them from the sessionbus service environment", strings.Join(legacy, ", "))
	}
	endpoint := ResolveEndpoint(env)
	ctx, cancel := context.WithTimeout(context.Background(), bridgeDialTimeout+bridgeRPCDeadline)
	defer cancel()
	bridge, err := Dial(ctx, endpoint)
	if err != nil {
		return Config{SettingsErr: fmt.Errorf("bridge %s: %v; start the Gateway with the sessionbus plugin installed, or set %s to the same path on both sides", endpoint, err, bridgeEnvVar)}, nil, nil
	}
	s, err := bridge.Settings(ctx)
	if err == nil {
		err = validateSettings(&s)
	}
	if err != nil {
		bridge.Close()
		return Config{SettingsErr: fmt.Errorf("lane settings from %s: %w; fix plugins.entries.sessionbus.config.lanes in openclaw.json and start a new lane after Gateway reload", endpoint, err)}, nil, nil
	}
	return Config{Agents: s.Agents, CredentialDir: filepath.Clean(s.CredentialDir), AuditLog: s.AuditLog}, bridge, nil
}
func validateSettings(s *Settings) error {
	if len(s.Agents) == 0 {
		return fmt.Errorf("lanes.agents: non-empty array required")
	}
	seen := map[string]bool{}
	for i, a := range s.Agents {
		if !agentIDPattern.MatchString(a.ID) {
			return fmt.Errorf("lanes.agents[%d].id: invalid agent id %q", i, a.ID)
		}
		if seen[a.ID] {
			return fmt.Errorf("lanes.agents[%d].id: duplicate agent id %q", i, a.ID)
		}
		seen[a.ID] = true
		if !filepath.IsAbs(a.Workspace) {
			return fmt.Errorf("lanes.agents[%d].workspace: absolute path required", i)
		}
		// The 120-character limit is the plugin's: it counts grapheme clusters
		// like OpenClaw's schema (src/lanes.js). Counting runes here refused
		// descriptions the plugin had accepted.
		if strings.ContainsAny(a.Description, "\r\n") {
			return fmt.Errorf("lanes.agents[%d].description: single line required", i)
		}
		if a.Models != nil {
			for _, entry := range a.Models.Allow {
				if strings.IndexFunc(entry, unicode.IsControl) >= 0 {
					return fmt.Errorf("lanes.agents[%d].models.allow: control characters forbidden", i)
				}
			}
			if strings.IndexFunc(a.Models.Default, unicode.IsControl) >= 0 {
				return fmt.Errorf("lanes.agents[%d].models.default: control characters forbidden", i)
			}
		}
	}
	if !filepath.IsAbs(s.CredentialDir) {
		return fmt.Errorf("lanes.credentialDir: absolute path required")
	}
	if s.AuditLog != "" && !filepath.IsAbs(s.AuditLog) {
		return fmt.Errorf("lanes.auditLog: absolute path required")
	}
	return nil
}
func (c Config) ChildEnv(base []string) []string {
	out := make([]string, 0, len(base)+2)
	for _, entry := range base {
		name, _, _ := strings.Cut(entry, "=")
		if name != "OPENCLAW_STATE_DIR" && name != "OPENCLAW_CONFIG_PATH" {
			out = append(out, entry)
		}
	}
	return append(out, "OPENCLAW_STATE_DIR="+c.CredentialDir, "OPENCLAW_CONFIG_PATH="+filepath.Join(c.CredentialDir, "openclaw.json"))
}
func (Config) ValidateMode(mode string) error {
	switch mode {
	case "", "default", "bypassPermissions", "plan":
		return nil
	default:
		return fmt.Errorf("unsupported value permission_mode=%s", mode)
	}
}
