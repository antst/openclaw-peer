package lane

import "testing"

// An explicit empty --agent value must not be treated the same as "no --agent given" —
// otherwise it silently falls back to the single-agent default instead of naming a real agent.
func TestSelectAgentRejectsEmptyValue(t *testing.T) {
	cfg := Config{Agents: []Agent{{ID: "lane", Description: "Lane role", Workspace: "/tmp/lane"}}}
	for _, arguments := range [][]string{{"--agent", ""}, {"--agent="}} {
		if _, err := SelectAgent(cfg, arguments, ""); err == nil {
			t.Errorf("SelectAgent(%v) admitted an empty --agent value", arguments)
		}
	}
}
