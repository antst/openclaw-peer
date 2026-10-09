package lane

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ResolveCwd checks a caller-supplied cwd against agent's declared workspace root.
// Used for a fresh Open's cwd, and a resumed lane's replayed cwd against the
// current declared root. Returns the realpath.
func ResolveCwd(agent Agent, cwd string) (string, error) {
	if !filepath.IsAbs(cwd) || strings.IndexByte(cwd, 0) >= 0 {
		return "", fmt.Errorf("unsupported value cwd=%s (must be absolute)", cwd)
	}
	real, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return "", fmt.Errorf("unsupported value cwd=%s (does not exist)", cwd)
	}
	// exec later fails on a non-directory cwd anyway; refuse it here, before any lock
	// or gateway call, with a reason that says so rather than a misleading "outside the workspace".
	if info, err := os.Stat(real); err != nil || !info.IsDir() {
		return "", fmt.Errorf("unsupported value cwd=%s (not a directory)", cwd)
	}
	root, err := filepath.EvalSymlinks(agent.Workspace)
	if err != nil {
		return "", fmt.Errorf("unsupported value cwd=%s (outside the workspace of agent %s)", cwd, agent.ID)
	}
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("unsupported value cwd=%s (outside the workspace of agent %s)", cwd, agent.ID)
	}
	return real, nil
}
