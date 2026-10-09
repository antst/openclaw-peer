package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/sessionbus/peer-common/host"
)

var scrubbedEnv = map[string]bool{
	host.SocketEnv: true, host.LocalKeyEnv: true, host.TokenEnv: true,
	host.SessionIDEnv: true, host.NameEnv: true, host.GroupsEnv: true,
	"OPENCLAW_GATEWAY_TOKEN": true, "OPENCLAW_GATEWAY_PASSWORD": true,
	"OPENCLAW_GATEWAY_URL": true,
}

func childEnv(env []string) []string {
	result := make([]string, 0, len(env)+2)
	for _, entry := range env {
		name, _, ok := strings.Cut(entry, "=")
		if ok && !scrubbedEnv[name] && name != "OPENCLAW_HIDE_BANNER" && name != "OPENCLAW_SUPPRESS_NOTES" {
			result = append(result, entry)
		}
	}
	return append(result, "OPENCLAW_HIDE_BANNER=1", "OPENCLAW_SUPPRESS_NOTES=1")
}

type Process struct {
	*Client
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	done       chan struct{}
	waitErr    error
	stderrByte int64
	mu         sync.Mutex
	closeOnce  sync.Once
}

func Start(ctx context.Context, argv, env []string) (*Process, error) {
	if len(argv) == 0 || argv[0] == "" {
		return nil, errors.New("acp child command is empty")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Open's request context ends when Open returns; the ACP child must live
	// until the lane is closed, independently of that request context.
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = childEnv(env)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("acp stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("acp stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("acp stderr: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("acp child start: %w", err)
	}
	p := &Process{cmd: cmd, stdin: stdin, done: make(chan struct{})}
	p.Client = newClient(stdout, stdin)
	stderrDone := make(chan struct{})
	go func() {
		n, _ := io.Copy(io.Discard, stderr)
		p.mu.Lock()
		p.stderrByte = n
		p.mu.Unlock()
		close(stderrDone)
	}()
	go func() {
		<-stderrDone
		<-p.Client.readerDone
		p.waitErr = cmd.Wait()
		p.Client.fail(p.exitError())
		close(p.done)
	}()
	return p, nil
}

// ErrChildExited marks any process exit, including a clean exit 0 mid-turn: the lane can't
// serve another turn either way, and the wrapper must not have to pattern-match error text to
// tell an exit apart from any other transport failure.
var ErrChildExited = errors.New("acp child exited")

func (p *Process) exitError() error {
	p.mu.Lock()
	n := p.stderrByte
	p.mu.Unlock()
	if p.waitErr == nil {
		return fmt.Errorf("%w: code=0 signal=- stderr_bytes=%d", ErrChildExited, n)
	}
	var exit *exec.ExitError
	if errors.As(p.waitErr, &exit) {
		code, signal := exit.ExitCode(), "-"
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			signal = status.Signal().String()
		}
		return fmt.Errorf("%w: code=%d signal=%s stderr_bytes=%d", ErrChildExited, code, signal, n)
	}
	return fmt.Errorf("%w: transport failure", ErrChildExited)
}

func (p *Process) Close(ctx context.Context) error {
	p.closeOnce.Do(func() { p.Client.closePending(); _ = p.stdin.Close() })
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		_ = p.cmd.Process.Kill()
		<-p.done
		return ctx.Err()
	}
}

type GatewayError struct {
	Type         string
	Code         string
	Message      string
	MissingScope string
}

func (e *GatewayError) Error() string { return e.Code + ": " + e.Message }

// A keyword followed only by whitespace and a word (no ':'/'=') is not
// a key=value secret shape — real assignments use "token=..." or "Authorization:...". "bearer"/
// "basic" are the one legitimate space-only shape (the HTTP Authorization header's own value),
// kept as a separate alternative. Without this split, "device token scope mismatch" and "password
// reset instructions" matched the same way "token=..." does, redacting an ordinary word after the
// keyword instead of an actual secret.
var secretKeyPattern = regexp.MustCompile(`(?i)(?:(?:token|secret|password|authorization)\S*\s*[:=]\s*(?:(?:bearer|basic)\s+)?\S+|(?:bearer|basic)\s+\S{8,})`)
var tokenPattern = regexp.MustCompile(`[A-Za-z0-9._~+/=-]{20,}`)

// SanitizeGatewayText exposes sanitizeGatewayText to callers outside this package that need
// the same secret-redaction and length cap over untrusted-child text — e.g. the voice readiness
// probe's raw `/tools compact` reply, which never goes through RunGateway.
func SanitizeGatewayText(s string) string { return sanitizeGatewayText(s) }

// SanitizeGatewayTextFull redacts before callers select bounded diagnostic excerpts.
func SanitizeGatewayTextFull(s string) string { return redactGatewayText(s) }

func sanitizeGatewayText(s string) string {
	s = redactGatewayText(s)
	if len(s) > 200 {
		s = s[:200]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

func redactGatewayText(s string) string {
	s = secretKeyPattern.ReplaceAllStringFunc(s, func(match string) string {
		word := strings.FieldsFunc(match, func(r rune) bool { return r == ':' || r == '=' || r == ' ' || r == '\t' })
		if len(word) == 0 {
			return "[redacted]"
		}
		return word[0] + " [redacted]"
	})
	s = tokenPattern.ReplaceAllString(s, "[redacted]")
	return s
}

func RunGateway(ctx context.Context, argv []string, method string, params any, env []string) (json.RawMessage, *GatewayError, error) {
	if len(argv) == 0 || argv[0] == "" {
		return nil, nil, errors.New("gateway child command is empty")
	}
	rawParams, err := json.Marshal(params)
	if err != nil {
		return nil, nil, fmt.Errorf("gateway params: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := append(append([]string(nil), argv[1:]...), method, "--json", "--params", string(rawParams))
	cmd := exec.CommandContext(ctx, argv[0], args...)
	cmd.Env = childEnv(env)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = io.Discard
	runErr := cmd.Run()
	if ctx.Err() != nil {
		return nil, nil, fmt.Errorf("gateway call %s failed: timeout or cancellation", method)
	}
	if runErr != nil {
		var envelope struct {
			OK    bool `json:"ok"`
			Error struct {
				Type    string `json:"type"`
				Code    string `json:"code"`
				Message string `json:"message"`
				Details struct {
					MissingScope string `json:"missingScope"`
				} `json:"details"`
			} `json:"error"`
		}
		if json.Unmarshal(stdout.Bytes(), &envelope) == nil && !envelope.OK && envelope.Error.Type == "gateway_request_error" {
			g := &GatewayError{Type: envelope.Error.Type, Code: envelope.Error.Code, Message: sanitizeGatewayText(envelope.Error.Message), MissingScope: envelope.Error.Details.MissingScope}
			fmt.Fprintf(os.Stderr, "gateway call %s failed: code=%s missing_scope=%s\n", sanitizeGatewayText(method), sanitizeGatewayText(g.Code), sanitizeGatewayText(scopeLabel(g.MissingScope)))
			return nil, g, nil
		}
		kind := envelope.Error.Type
		if kind == "" {
			kind = "transport"
		}
		return nil, nil, fmt.Errorf("gateway call %s failed: type=%s", method, sanitizeGatewayText(kind))
	}
	raw := bytes.TrimSpace(stdout.Bytes())
	if !json.Valid(raw) {
		return nil, nil, fmt.Errorf("gateway call %s failed: non-JSON stdout", method)
	}
	return append(json.RawMessage(nil), raw...), nil, nil
}

func scopeLabel(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
