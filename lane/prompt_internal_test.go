package lane

import (
	"strings"
	"testing"
)

// OpenClaw accepts nested model refs and profile suffixes; the local grammar must
// admit them, aliases and bare ids while keeping metacharacters out of Gateway argv.
func TestValidateModelRefs(t *testing.T) {
	for _, model := range []string{
		"no-provider",
		"glm",
		"mock-a",
		"llama3:8b",
		"claude-x@work",
		"openrouter/z-ai/glm-5.3",
		"anthropic/claude-x@work",
		"openrouter/anthropic/claude-x@work",
	} {
		if err := ValidateModel(model); err != nil {
			t.Errorf("valid model %q refused: %v", model, err)
		}
	}
	for _, model := range []string{
		"",
		"/x",
		"a//b",
		"a;b",
		"/model",
		"provider/",
		"provider//model",
		"provider/model?x",
		"provider/model;id",
		"provider/model\nnext",
	} {
		if err := ValidateModel(model); err == nil || !strings.Contains(err.Error(), "unsupported value model="+model) {
			t.Errorf("invalid model %q accepted or wrong error: %v", model, err)
		}
	}
}
