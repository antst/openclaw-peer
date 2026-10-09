package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type failingWriter struct{ err error }

func (w failingWriter) Write([]byte) (int, error) { return 0, w.err }

func TestDeadChildWriteClassifiesExitAndNotSent(t *testing.T) {
	for _, writeErr := range []error{syscall.EPIPE, io.ErrClosedPipe, os.ErrClosed} {
		outputR, outputW := io.Pipe()
		client := newClient(outputR, failingWriter{err: writeErr})
		err := client.Call(context.Background(), "session/prompt", nil, nil)
		if !errors.Is(err, ErrNotSent) || !errors.Is(err, ErrChildExited) {
			t.Errorf("write error %v: Call = %v, want both sentinels", writeErr, err)
		}
		_ = outputW.Close()
		<-client.readerDone
	}
}

func TestLiveChildWriteFailureDoesNotClassifyExit(t *testing.T) {
	outputR, outputW := io.Pipe()
	client := newClient(outputR, failingWriter{err: syscall.EIO})
	err := client.Call(context.Background(), "session/prompt", nil, nil)
	if !errors.Is(err, ErrNotSent) || errors.Is(err, ErrChildExited) {
		t.Fatalf("live-child write failure = %v, want only ErrNotSent", err)
	}
	_ = outputW.Close()
	<-client.readerDone
}

func TestCorruptCorrelatedResponseFailsPendingCall(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"missing result and error", ""},
		{"both result and error", `,"result":{},"error":{"code":1,"message":"bad"}`},
		{"invalid error object", `,"error":"text"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			outputR, outputW := io.Pipe()
			inputR, inputW := io.Pipe()
			c := newClient(outputR, inputW)
			defer outputW.Close()
			defer inputR.Close()
			defer inputW.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- c.Call(ctx, "session/prompt", map[string]any{}, nil) }()
			var request struct {
				ID int64 `json:"id"`
			}
			if err := json.NewDecoder(inputR).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if _, err := fmt.Fprintf(outputW, `{"jsonrpc":"2.0","id":%d%s}`+"\n", request.ID, tc.body); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				if err == nil || errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "acp corrupt correlated response") {
					t.Fatalf("Call error = %v", err)
				}
			case <-ctx.Done():
				t.Fatal("corrupt reply stranded Call")
			}
			later := make(chan error, 1)
			go func() { later <- c.Call(context.Background(), "session/prompt", nil, nil) }()
			select {
			case err := <-later:
				if err == nil || !strings.Contains(err.Error(), "acp corrupt correlated response") {
					t.Fatalf("later Call error = %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("later Call hung")
			}
		})
	}
}

// flake-acp-later-call: a Call made after the pending Call got its corrupt reply must see a
// closed client (ErrNotSent), not be written to the child. The test holds c.mu while it takes
// the reply, so the reader cannot close the client after delivering it.
func TestCorruptReplyClosesClientBeforeDelivery(t *testing.T) {
	outputR, outputW := io.Pipe()
	inputR, inputW := io.Pipe()
	c := newClient(outputR, inputW)
	defer outputW.Close()
	defer inputR.Close()
	defer inputW.Close()
	go func() { _ = c.Call(context.Background(), "session/prompt", map[string]any{}, nil) }()
	var request struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(inputR).Decode(&request); err != nil {
		t.Fatal(err)
	}
	// An unbuffered stand-in for the pending Call's channel: delivery waits for this test.
	gate := make(chan response)
	c.mu.Lock()
	c.pending[request.ID] = gate
	c.mu.Unlock()
	if _, err := fmt.Fprintf(outputW, `{"jsonrpc":"2.0","id":%d}`+"\n", request.ID); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		c.mu.Lock()
		taken := c.closed || c.pending[request.ID] == nil
		c.mu.Unlock()
		if taken {
			break
		}
	}
	var reply response
	c.mu.Lock()
	select {
	case reply = <-gate:
		closed := c.closed
		c.mu.Unlock()
		if !closed {
			t.Fatal("corrupt reply delivered before the client was closed: a Call made now is written to the child (later Call hung)")
		}
	case <-time.After(time.Second): // delivery needs c.mu
		c.mu.Unlock()
		select {
		case reply = <-gate:
		case <-time.After(time.Second):
			t.Fatal("corrupt reply never delivered")
		}
	}
	if reply.err == nil || !strings.Contains(reply.err.Error(), "acp corrupt correlated response") {
		t.Fatalf("pending Call reply = %v", reply.err)
	}
	later := make(chan error, 1)
	go func() { later <- c.Call(context.Background(), "session/prompt", nil, nil) }()
	select {
	case err := <-later:
		if !errors.Is(err, ErrNotSent) || !strings.Contains(err.Error(), "acp corrupt correlated response") {
			t.Fatalf("later Call error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("later Call hung")
	}
}

// CR-F-01: the matched pending entry must not leave `pending` while the client is still open.
// The reader's `taken` seam runs right after it has taken the entry and released c.mu; there the
// client must already be closed, and a Call must get ErrNotSent without registering or writing
// (nobody reads the child's stdin here, so a write would hang the Call).
func TestCorruptReplyTakesEntryOnlyWhenClosed(t *testing.T) {
	outputR, outputW := io.Pipe()
	inputR, inputW := io.Pipe()
	c := newClient(outputR, inputW)
	defer outputW.Close()
	defer inputR.Close()
	defer inputW.Close()
	type boundary struct {
		closed  bool
		pending int
		call    error
	}
	seen := make(chan boundary, 1)
	c.mu.Lock()
	c.taken = func() {
		c.mu.Lock()
		b := boundary{closed: c.closed}
		c.mu.Unlock()
		done := make(chan error, 1)
		go func() { done <- c.Call(context.Background(), "session/prompt", nil, nil) }()
		select {
		case b.call = <-done:
		case <-time.After(time.Second):
			b.call = errors.New("Call registered and blocked writing to the child")
		}
		c.mu.Lock()
		b.pending = len(c.pending)
		c.mu.Unlock()
		seen <- b
	}
	c.mu.Unlock()
	first := make(chan error, 1)
	go func() { first <- c.Call(context.Background(), "session/prompt", map[string]any{}, nil) }()
	var request struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(inputR).Decode(&request); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintf(outputW, `{"jsonrpc":"2.0","id":%d}`+"\n", request.ID); err != nil {
		t.Fatal(err)
	}
	var b boundary
	select {
	case b = <-seen:
	case <-time.After(3 * time.Second):
		t.Fatal("the reader never took the pending entry")
	}
	if !b.closed {
		t.Error("matched entry left pending while the client was still open")
	}
	if !errors.Is(b.call, ErrNotSent) || !strings.Contains(b.call.Error(), "acp corrupt correlated response") {
		t.Errorf("Call at the boundary = %v, want ErrNotSent with the corrupt-response failure", b.call)
	}
	if b.pending != 0 {
		t.Errorf("pending at the boundary = %d, want 0", b.pending)
	}
	select {
	case err := <-first:
		if err == nil || !strings.Contains(err.Error(), "acp corrupt correlated response") {
			t.Fatalf("pending Call = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("pending Call never answered")
	}
}

func fake(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fakeacp")
	cmd := exec.Command("go", "build", "-mod=vendor", "-o", path, "./internal/fakeacp")
	cmd.Dir = filepath.Join("..", "..")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake: %v: %s", err, out)
	}
	return path
}

func TestGatewayEnvelopeAndScrub(t *testing.T) {
	bin := fake(t)
	log := filepath.Join(t.TempDir(), "log")
	env := append(os.Environ(),
		`FAKEACP_SCRIPT={"gateway":{"sessions.create":{"fail":"missing_admin"}}}`,
		"FAKEACP_LOG="+log, "SESSIONBUS_LAUNCH_TOKEN=secret", "OPENCLAW_GATEWAY_TOKEN=secret", "OPENCLAW_GATEWAY_URL=https://bad")
	_, gatewayErr, err := RunGateway(context.Background(), []string{bin, "gateway", "call"}, "sessions.create", map[string]string{"key": "x"}, env)
	if err != nil || gatewayErr == nil || gatewayErr.Code != "FORBIDDEN" || gatewayErr.MissingScope != "operator.admin" {
		t.Fatalf("gateway classification: %#v, %v", gatewayErr, err)
	}
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(data[:len(data)-1], &event); err != nil {
		t.Fatal(err)
	}
	argv, _ := event["argv"].([]any)
	for _, a := range argv {
		if a == "--url" || a == "--token" {
			t.Fatalf("secret-bearing flag on child argv: %v", argv)
		}
	}
	for _, n := range event["envNames"].([]any) {
		if n == "SESSIONBUS_LAUNCH_TOKEN" || n == "OPENCLAW_GATEWAY_TOKEN" || n == "OPENCLAW_GATEWAY_URL" {
			t.Fatalf("secret or URL env reached child: %s", n)
		}
	}
}

func TestClientCorrelatesAndFiltersUpdates(t *testing.T) {
	bin := fake(t)
	log := filepath.Join(t.TempDir(), "log")
	env := append(os.Environ(), "FAKEACP_LOG="+log, "SESSIONBUS_LAUNCH_TOKEN=secret", "OPENCLAW_GATEWAY_PASSWORD=secret", "OPENCLAW_GATEWAY_URL=https://bad")
	openCtx, cancelOpen := context.WithCancel(context.Background())
	p, err := Start(openCtx, []string{bin, "acp"}, env)
	if err != nil {
		t.Fatal(err)
	}
	cancelOpen() // The child belongs to the lane, not the completed Open RPC.
	defer p.Close(context.Background())
	var init json.RawMessage
	if err := p.Call(context.Background(), "initialize", map[string]any{"protocolVersion": 1}, &init); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(init), "agentCapabilities") {
		t.Fatalf("wrong initialize result: %s", init)
	}
	var session struct {
		SessionID string `json:"sessionId"`
	}
	if err := p.Call(context.Background(), "session/new", map[string]any{"cwd": "/tmp", "mcpServers": []any{}, "_meta": map[string]any{"sessionKey": "agent:a:sb-test"}}, &session); err != nil {
		t.Fatal(err)
	}
	if session.SessionID == "" || session.SessionID == "agent:a:sb-test" {
		t.Fatalf("fresh ACP id must differ from lane key: %q", session.SessionID)
	}
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var start map[string]any
	if err := json.Unmarshal([]byte(strings.SplitN(string(data), "\n", 2)[0]), &start); err != nil {
		t.Fatal(err)
	}
	for _, n := range start["envNames"].([]any) {
		if n == "SESSIONBUS_LAUNCH_TOKEN" || n == "OPENCLAW_GATEWAY_PASSWORD" || n == "OPENCLAW_GATEWAY_URL" {
			t.Fatalf("ACP env not scrubbed: %s", n)
		}
	}
	for _, a := range start["argv"].([]any) {
		if a == "--url" || a == "--token" {
			t.Fatalf("ACP argv includes credential flag: %v", start["argv"])
		}
	}
}

func TestGatewayTransportFailure(t *testing.T) {
	bin := fake(t)
	for _, failure := range []string{"transport", "auth"} {
		t.Run(failure, func(t *testing.T) {
			env := append(os.Environ(), `FAKEACP_SCRIPT={"gateway":{"sessions.create":{"fail":"`+failure+`"}}}`)
			_, gerr, err := RunGateway(context.Background(), []string{bin, "gateway", "call"}, "sessions.create", map[string]string{"key": "x"}, env)
			if err == nil || gerr != nil {
				t.Fatalf("expected transport error, got %v %#v", err, gerr)
			}
		})
	}
}

// A Call that never reaches the child (the client is already closed from a prior
// failure) is ErrNotSent, distinct from a request that was sent but never answered.
func TestCallOnClosedClientIsNotSent(t *testing.T) {
	p, err := Start(context.Background(), []string{"sh", "-c", "exit 1"}, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = p.Close(ctx)
	if callErr := p.Call(context.Background(), "session/prompt", map[string]any{}, nil); !errors.Is(callErr, ErrNotSent) {
		t.Fatalf("Call on a closed client = %v, want errors.Is(err, ErrNotSent)", callErr)
	}
}

// A child that exits cleanly (code 0) mid-turn must still be classified as a child-exit
// event, not a bare io.EOF the wrapper can't distinguish from any other transport loss. This applies
// to any exit, not only a crash.
func TestChildExitedSentinelOnCleanExit(t *testing.T) {
	p, err := Start(context.Background(), []string{"sh", "-c", "sleep 0.2; exit 0"}, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = p.Close(ctx)
	}()
	callErr := p.Call(context.Background(), "session/prompt", map[string]any{}, nil)
	if !errors.Is(callErr, ErrChildExited) {
		t.Fatalf("Call after a clean exit = %v, want errors.Is(err, ErrChildExited)", callErr)
	}
}

// A child can die between turns. The next request was never sent, but the wrapper
// still needs the child-exit sentinel to retire the dead lane.
func TestCallAfterIdleChildExitKeepsBothSentinels(t *testing.T) {
	p, err := Start(context.Background(), []string{"sh", "-c", "exit 0"}, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	<-p.done // The child is gone before this turn begins.
	callErr := p.Call(context.Background(), "session/prompt", map[string]any{}, nil)
	if !errors.Is(callErr, ErrNotSent) || !errors.Is(callErr, ErrChildExited) {
		t.Fatalf("Call after idle child exit = %v, want ErrNotSent and ErrChildExited", callErr)
	}
}

func TestSanitizeGatewayText(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{strings.Repeat("a", 40), "[redacted]"},
		{"Bearer abcdefghijklmnop", "Bearer [redacted]"},
		{"missing scope: operator.admin", "missing scope: operator.admin"},
		{"apitoken=sekrit123", "apitoken [redacted]"},
		{"Authorization: Bearer abc123", "Authorization [redacted]"},
		{"Authorization: Basic aHVudGVyMg==", "Authorization [redacted]"},
		{"basic auth failed", "basic auth failed"},
		// "token" followed by a space and any word (no ':'/'=') is not a
		// key=value secret shape — only the bearer/basic HTTP-header shape is. Before the fix,
		// "token scope" matched the same way "token=..." does, mangling this exact 8.2 error
		// text (auth-messages.ts:78-79) into "device token [redacted] mismatch (...)".
		{"unauthorized: device token scope mismatch (re-pair or approve scope upgrade)", "unauthorized: device token scope mismatch (re-pair or approve scope upgrade)"},
		{"password reset instructions", "password reset instructions"},
	} {
		if got := sanitizeGatewayText(tc.in); got != tc.want {
			t.Errorf("sanitize %q: got %q, want %q", tc.in, got, tc.want)
		}
	}
}
