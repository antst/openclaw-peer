package lane

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/sessionbus/peer-common/host"
)

// resumeKeyPattern matches exactly what mintKey mints: agent:<id>:sb-<uuid4>. A full match, not
// a prefix: a malformed tail like "sb-not-a-uuid" must never be admitted. The
// one admission rule for a resume key lives here, not duplicated in wrapper.go.
var resumeKeyPattern = regexp.MustCompile(`^agent:([a-z0-9][a-z0-9_-]{0,63}):sb-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// SelectAgent chooses an operator-listed role. Argument validation is kept here so no
// caller-supplied flag is ever forwarded to a child process. resumeKey is "" for a fresh Open; for
// a resume it is the key being resumed, and this also performs the admission check.
func SelectAgent(cfg Config, arguments []string, resumeKey string) (Agent, error) {
	built, err := host.BuildArguments(arguments, []host.ArgumentRule{{Name: "--agent", TakesValue: true}})
	ids, extractErr := agentArguments(built)
	if err != nil || extractErr != nil || len(ids) > 1 {
		return Agent{}, fmt.Errorf("unsupported value arguments=%s", strings.Join(arguments, " "))
	}
	// hasAgent, not just selected != "", distinguishes "no --agent given" from "--agent given an
	// explicit empty value" (["--agent",""] or ["--agent="] must not silently fall back
	// to the single-agent default).
	selected := ""
	hasAgent := len(ids) == 1
	if hasAgent {
		selected = ids[0]
	}

	if resumeKey != "" {
		m := resumeKeyPattern.FindStringSubmatch(resumeKey)
		if m == nil {
			return Agent{}, errors.New("resume key not admitted")
		}
		agentID := m[1]
		for _, agent := range cfg.Agents {
			if agent.ID != agentID {
				continue
			}
			if hasAgent && selected != agent.ID {
				return Agent{}, fmt.Errorf("unsupported value arguments=%s (resume agent is %s)", strings.Join(arguments, " "), agent.ID)
			}
			return agent, nil
		}
		return Agent{}, errors.New("resume key not admitted")
	}

	roles := make([]string, 0, len(cfg.Agents))
	ids2 := make([]string, 0, len(cfg.Agents))
	for _, agent := range cfg.Agents {
		roles = append(roles, agent.ID+" — "+agent.Description)
		ids2 = append(ids2, agent.ID)
		if hasAgent && agent.ID == selected {
			return agent, nil
		}
	}
	if !hasAgent {
		if len(cfg.Agents) == 1 {
			return cfg.Agents[0], nil
		}
		return Agent{}, fmt.Errorf(`agent required: pass arguments ["--agent","<id>"]; allowed: %s`, strings.Join(roles, "; "))
	}
	return Agent{}, fmt.Errorf("unsupported value arguments=--agent %s (allowed: %s)", selected, strings.Join(ids2, ", "))
}

// agentArguments reads the --agent value(s) out of arguments already passed through
// host.BuildArguments (so every element is a recognized "--agent" or "--agent=<id>" form).
func agentArguments(built []string) ([]string, error) {
	var ids []string
	for i := 0; i < len(built); i++ {
		if built[i] == "--agent" {
			if i+1 >= len(built) {
				return nil, errors.New("missing --agent value")
			}
			ids = append(ids, built[i+1])
			i++
			continue
		}
		if v, ok := strings.CutPrefix(built[i], "--agent="); ok {
			ids = append(ids, v)
		}
	}
	return ids, nil
}
