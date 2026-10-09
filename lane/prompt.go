package lane

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// modelPattern admits provider-qualified refs, aliases and bare ids. OpenClaw
// sessions.patch resolves aliases and bare ids in the selected agent's scope.
var modelPattern = regexp.MustCompile(`^[A-Za-z0-9._:@-]+(/[A-Za-z0-9._:@-]+)*$`)

// ValidateModel rejects anything outside the model-ref grammar; "" (absent) is not
// validated here, since an absent model is simply not patched.
func ValidateModel(model string) error {
	if !modelPattern.MatchString(model) {
		return fmt.Errorf("unsupported value model=%s", model)
	}
	return nil
}

// reasoningEfforts are the valid open.reasoning_effort values (types.agent-defaults.ts:34-43).
var reasoningEfforts = map[string]bool{
	"off": true, "minimal": true, "low": true, "medium": true, "high": true,
	"xhigh": true, "adaptive": true, "max": true, "ultra": true,
}

// ValidateReasoningEffort rejects anything outside the set; "" (absent) is not validated
// here, since an absent value carries no _meta.thinking at all.
func ValidateReasoningEffort(level string) error {
	if !reasoningEfforts[level] {
		return fmt.Errorf("unsupported value reasoning_effort=%s", level)
	}
	return nil
}

// thinkingUnsupportedPrefix returns the exact OpenClaw text produced when a model does not
// support the reasoning_effort level the wrapper sent (get-reply-run-admission.ts:227-273).
func thinkingUnsupportedPrefix(level string) string {
	return fmt.Sprintf("Thinking level %q is not supported for ", level)
}

// isJSWhitespace matches the JS \s class used by OpenClaw's own directive parser
// (directives.ts:29-66), so the lane's refusal/neutralization boundaries agree with it exactly.
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// refusesSlash reports whether text, after stripping leading JS whitespace and U+200B, starts
// with '/' (the slash-refusal rule): a Text run like this is refused outright, never reaching the agent.
// Delivery is never refused this way; its inline directives are neutralized.
func refusesSlash(text string) bool {
	i := 0
	for i < len(text) {
		r, size := utf8.DecodeRuneInString(text[i:])
		if r == '​' || isJSWhitespace(r) {
			i += size
			continue
		}
		break
	}
	return i < len(text) && text[i] == '/'
}

// directiveNames are OpenClaw's own in-session slash directives (directives.ts:29-66,
// reply-inline.ts:14-15); any of these appearing live in caller text would run with the lane's
// own authority, so inline directive neutralization handles them wherever they occur, not just at text start.
var directiveNames = []string{
	"model", "think", "thinking", "t", "verbose", "v", "trace", "fast", "elevated", "elev",
	"reasoning", "reason", "exec", "queue", "status", "help", "commands", "whoami", "id",
}

// neutralizeDirectives inserts U+200B before every '/' that starts a live directive: at text
// start or right after JS whitespace, spelling one of directiveNames case-insensitively, followed
// by the text end, JS whitespace, or ':'. Everything else — including a leading '/' that isn't a
// known directive name, and a '/' not at a word boundary — is byte-identical.
func neutralizeDirectives(text string) string {
	var b strings.Builder
	i := 0
	for i < len(text) {
		r, size := utf8.DecodeRuneInString(text[i:])
		if r == '/' {
			startOK := i == 0
			if !startOK {
				prev, _ := utf8.DecodeLastRuneInString(text[:i])
				startOK = isJSWhitespace(prev)
			}
			if startOK && matchesDirective(text[i+1:]) {
				b.WriteRune('​')
			}
		}
		b.WriteString(text[i : i+size])
		i += size
	}
	return b.String()
}

func matchesDirective(after string) bool {
	for _, name := range directiveNames {
		if len(after) < len(name) || !strings.EqualFold(after[:len(name)], name) {
			continue
		}
		if len(after) == len(name) {
			return true
		}
		next, _ := utf8.DecodeRuneInString(after[len(name):])
		if next == ':' || isJSWhitespace(next) {
			return true
		}
	}
	return false
}
