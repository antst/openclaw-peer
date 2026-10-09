package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The test binary doubles as the fake: with FAKEACP_SELFTEST_MAIN=1 it runs main() on the argv
// that follows, so both modes are driven as real child processes over pipes.
func TestMain(m *testing.M) {
	if os.Getenv("FAKEACP_SELFTEST_MAIN") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type fixture struct {
	t     *testing.T
	log   string
	state string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	return &fixture{t: t, log: filepath.Join(dir, "fake.log"), state: filepath.Join(dir, "state")}
}

func (f *fixture) env(script string, extra ...string) []string {
	env := append(os.Environ(), "FAKEACP_SELFTEST_MAIN=1", "FAKEACP_LOG="+f.log, "FAKEACP_STATE="+f.state, "FAKEACP_SCRIPT="+script)
	return append(env, extra...)
}

type logRec map[string]any

func (f *fixture) events(name string) []logRec {
	f.t.Helper()
	b, err := os.ReadFile(f.log)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		f.t.Fatal(err)
	}
	var out []logRec
	for _, line := range bytes.Split(b, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var r logRec
		if err := json.Unmarshal(line, &r); err != nil {
			f.t.Fatalf("log line not JSON: %q", line)
		}
		if name == "" || r["event"] == name {
			out = append(out, r)
		}
	}
	return out
}

// ---------------------------------------------------------------- ACP client

type acpClient struct {
	t       *testing.T
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stderr  *bytes.Buffer
	mu      sync.Mutex
	nextID  int
	pending map[string]chan rpcMsg
	msgs    []rpcMsg // every JSON line received
	noise   []string // non-JSON stdout lines
	maxLine int
	onPerm  func(rpcMsg) any // result for session/request_permission; nil result = no answer
	done    chan struct{}
	exitErr error
}

func (f *fixture) startACP(script string, extraEnv ...string) *acpClient {
	f.t.Helper()
	cmd := exec.Command(os.Args[0], "acp")
	cmd.Env = f.env(script, extraEnv...)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	c := &acpClient{t: f.t, cmd: cmd, stdin: stdin, stderr: &bytes.Buffer{}, pending: map[string]chan rpcMsg{}, done: make(chan struct{}), nextID: 1}
	cmd.Stderr = &lockedWriter{w: c.stderr, mu: &c.mu}
	if err := cmd.Start(); err != nil {
		f.t.Fatal(err)
	}
	go c.read(stdout)
	f.t.Cleanup(func() {
		_ = stdin.Close()
		select {
		case <-c.done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-c.done
		}
	})
	return c
}

type lockedWriter struct {
	w  io.Writer
	mu *sync.Mutex
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func (c *acpClient) read(stdout io.Reader) {
	r := bufio.NewReaderSize(stdout, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			c.mu.Lock()
			if len(line) > c.maxLine {
				c.maxLine = len(line)
			}
			var m rpcMsg
			if json.Unmarshal(trimmed, &m) != nil {
				c.noise = append(c.noise, string(trimmed))
				c.mu.Unlock()
			} else {
				c.msgs = append(c.msgs, m)
				ch := c.pending[string(m.ID)]
				isReply := m.Method == "" && ch != nil
				if isReply {
					delete(c.pending, string(m.ID))
				}
				onPerm := c.onPerm
				c.mu.Unlock()
				if isReply {
					ch <- m
				} else if m.Method == "session/request_permission" && onPerm != nil {
					if res := onPerm(m); res != nil {
						c.send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": res})
					}
				}
			}
		}
		if err != nil {
			break
		}
	}
	c.exitErr = c.cmd.Wait()
	c.mu.Lock()
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	close(c.done)
}

func (c *acpClient) send(v any) {
	b, _ := json.Marshal(v)
	_, _ = c.stdin.Write(append(b, '\n'))
}

func (c *acpClient) start(method string, params any) chan rpcMsg {
	c.mu.Lock()
	id := c.nextID
	c.nextID++
	ch := make(chan rpcMsg, 1)
	c.pending[fmt.Sprint(id)] = ch
	c.mu.Unlock()
	c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	return ch
}

func (c *acpClient) wait(ch chan rpcMsg, d time.Duration) (rpcMsg, bool) {
	c.t.Helper()
	select {
	case m, ok := <-ch:
		return m, ok
	case <-time.After(d):
		c.t.Fatalf("no reply within %s", d)
		return rpcMsg{}, false
	}
}

// call returns the raw result, or the JSON-RPC error object as a string.
func (c *acpClient) call(method string, params any) (json.RawMessage, string) {
	c.t.Helper()
	m, ok := c.wait(c.start(method, params), 10*time.Second)
	if !ok {
		return nil, "process exited"
	}
	if m.Error != nil {
		return nil, string(m.Error)
	}
	return m.Result, ""
}

func (c *acpClient) mustCall(method string, params any) json.RawMessage {
	c.t.Helper()
	r, e := c.call(method, params)
	if e != "" {
		c.t.Fatalf("%s: error %s", method, e)
	}
	return r
}

func (c *acpClient) notify(method string, params any) {
	c.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *acpClient) snapshot() (msgs []rpcMsg, noise []string, maxLine int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]rpcMsg(nil), c.msgs...), append([]string(nil), c.noise...), c.maxLine
}

func (c *acpClient) stderrText() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stderr.String()
}

type update struct {
	SessionID string `json:"sessionId"`
	Update    struct {
		SessionUpdate string `json:"sessionUpdate"`
		Content       struct {
			Text string `json:"text"`
		} `json:"content"`
	} `json:"update"`
}

// updates returns session/update notifications received after message index from.
func (c *acpClient) updates(from int) []update {
	msgs, _, _ := c.snapshot()
	var out []update
	for _, m := range msgs[from:] {
		if m.Method != "session/update" {
			continue
		}
		var u update
		_ = json.Unmarshal(m.Params, &u)
		out = append(out, u)
	}
	return out
}

func (c *acpClient) mark() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.msgs)
}

func agentText(us []update, sessionID string) string {
	var b strings.Builder
	for _, u := range us {
		if u.SessionID == sessionID && u.Update.SessionUpdate == "agent_message_chunk" {
			b.WriteString(u.Update.Content.Text)
		}
	}
	return b.String()
}

func (c *acpClient) initialize() {
	c.t.Helper()
	r := c.mustCall("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": false}})
	var init struct {
		ProtocolVersion int                   `json:"protocolVersion"`
		AgentInfo       struct{ Name string } `json:"agentInfo"`
	}
	_ = json.Unmarshal(r, &init)
	if init.ProtocolVersion != 1 || init.AgentInfo.Name != "openclaw-acp" {
		c.t.Fatalf("initialize result %s", r)
	}
}

func (c *acpClient) newSession(key, cwd string) string {
	c.t.Helper()
	r := c.mustCall("session/new", map[string]any{"cwd": cwd, "mcpServers": []any{}, "_meta": map[string]any{"sessionKey": key}})
	var res struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(r, &res)
	if res.SessionID == "" {
		c.t.Fatalf("session/new result %s", r)
	}
	return res.SessionID
}

type turn struct {
	stop string
	text string
	err  string
}

func (c *acpClient) prompt(sid, text string, meta map[string]any) turn {
	c.t.Helper()
	from := c.mark()
	params := map[string]any{"sessionId": sid, "prompt": []any{map[string]any{"type": "text", "text": text}}}
	if meta != nil {
		params["_meta"] = meta
	}
	r, e := c.call("session/prompt", params)
	var res struct {
		StopReason string `json:"stopReason"`
	}
	_ = json.Unmarshal(r, &res)
	return turn{stop: res.StopReason, text: agentText(c.updates(from), sid), err: e}
}

func (c *acpClient) waitExit(t *testing.T) int {
	t.Helper()
	select {
	case <-c.done:
	case <-time.After(10 * time.Second):
		t.Fatal("fake did not exit")
	}
	var ee *exec.ExitError
	if errors.As(c.exitErr, &ee) {
		return ee.ExitCode()
	}
	if c.exitErr != nil {
		t.Fatal(c.exitErr)
	}
	return 0
}

const key1 = "agent:lane:sb-11111111-1111-4111-8111-111111111111"

// ---------------------------------------------------------------- ACP tests

func TestACPLifecycle(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	from := c.mark()
	sid := c.newSession(key1, "/ws/lane")
	if sid == key1 || len(sid) != 36 {
		t.Fatalf("session/new sessionId = %q, want a fresh uuid (8.2 translator.session-lifecycle.ts:72)", sid)
	}
	kinds := map[string]bool{}
	for _, u := range c.updates(from) {
		kinds[u.Update.SessionUpdate] = true
	}
	if !kinds["available_commands_update"] || !kinds["session_info_update"] {
		t.Fatalf("session/new announcements = %v", kinds)
	}
	tr := c.prompt(sid, "hello one", nil)
	if tr.err != "" || tr.stop != "end_turn" {
		t.Fatalf("prompt: %+v", tr)
	}
	if want := "ECHO[model=default turn=1]: [Working directory: /ws/lane]\n\nhello one"; tr.text != want {
		t.Fatalf("reply = %q, want %q", tr.text, want)
	}
	// 8.2 looks sessions up by ACP sessionId only; the Gateway key is not an alias.
	if tr := c.prompt(key1, "by key", nil); !strings.Contains(tr.err, "Session "+key1+" not found") {
		t.Fatalf("prompt by key before resume: %+v", tr)
	}
	if r := c.mustCall("session/close", map[string]any{"sessionId": sid}); string(r) != "{}" {
		t.Fatalf("close result %s", r)
	}
	if tr := c.prompt(sid, "after close", nil); !strings.Contains(tr.err, "not found") || !strings.Contains(tr.err, "-32603") {
		t.Fatalf("prompt after close: %+v", tr)
	}
	if _, e := c.call("session/close", map[string]any{"sessionId": sid}); !strings.Contains(e, "not found") {
		t.Fatalf("second close: %q", e)
	}
	if _, e := c.call("session/set_model", map[string]any{"sessionId": sid, "modelId": "x/y"}); !strings.Contains(e, "-32601") {
		t.Fatalf("unknown method: %q", e)
	}
	news := f.events("session_new")
	if len(news) != 1 || news[0]["cwd"] != "/ws/lane" || news[0]["key"] != key1 || news[0]["sessionId"] != sid {
		t.Fatalf("session_new log %v", news)
	}
}

func TestACPSessionNewValidation(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	_, e := c.call("session/new", map[string]any{"cwd": "/ws", "mcpServers": []any{map[string]any{"name": "x"}}, "_meta": map[string]any{"sessionKey": key1}})
	if !strings.Contains(e, "does not support per-session MCP servers") {
		t.Fatalf("mcpServers: %q", e)
	}
	_, e = c.call("session/new", map[string]any{"cwd": "/ws", "mcpServers": []any{}})
	if !strings.Contains(e, "Use an agent-prefixed session key") {
		t.Fatalf("missing sessionKey: %q", e)
	}
}

func TestACPResume(t *testing.T) {
	f := newFixture(t)
	resume := func(c *acpClient, key, cwd string) string {
		_, e := c.call("session/resume", map[string]any{"sessionId": key, "cwd": cwd, "mcpServers": []any{}})
		return e
	}
	c := f.startACP("")
	c.initialize()
	if e := resume(c, key1, "/ws/lane"); !strings.Contains(e, "Session "+key1+" not found") {
		t.Fatalf("unknown key: %q", e)
	}
	// A prompted session becomes a Gateway row (lazy creation) and is resumable
	// from a fresh process, with its history.
	sid := c.newSession(key1, "/ws/lane")
	if tr := c.prompt(sid, "remember", nil); tr.stop != "end_turn" {
		t.Fatalf("%+v", tr)
	}
	c.mustCall("session/close", map[string]any{"sessionId": sid})
	_ = c.stdin.Close()
	c.waitExit(t)

	c2 := f.startACP("")
	c2.initialize()
	if e := resume(c2, key1, "rel/dir"); !strings.Contains(e, "absolute cwd") {
		t.Fatalf("relative cwd: %q", e)
	}
	if e := resume(c2, key1, "/ws/lane/sub"); e != "" {
		t.Fatal(e)
	}
	tr := c2.prompt(key1, "again", nil)
	if tr.stop != "end_turn" || !strings.Contains(tr.text, "turn=2") || !strings.Contains(tr.text, "[Working directory: /ws/lane/sub]") {
		t.Fatalf("after resume: %+v", tr)
	}
	rs := f.events("session_resume")
	if len(rs) != 1 || rs[0]["cwd"] != "/ws/lane/sub" || rs[0]["key"] != key1 {
		t.Fatalf("session_resume log %v", rs)
	}
	// Script-known keys.
	other := "agent:b:sb-22222222-2222-4222-8222-222222222222"
	c3 := f.startACP(`{"knownKeys":["` + other + `"]}`)
	c3.initialize()
	if e := resume(c3, other, "/ws/b"); e != "" {
		t.Fatal(e)
	}
}

func TestACPPromptMetaLogged(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	sid := c.newSession(key1, "/ws/lane")
	tr := c.prompt(sid, "plain", map[string]any{"prefixCwd": false, "thinking": "high", "extra": "x"})
	if tr.text != "ECHO[model=default turn=1]: plain" {
		t.Fatalf("prefixCwd:false reply %q", tr.text)
	}
	ps := f.events("prompt")
	if len(ps) != 1 {
		t.Fatalf("prompt events %v", ps)
	}
	meta, _ := ps[0]["meta"].(map[string]any)
	if ps[0]["prefixCwd"] != false || ps[0]["thinking"] != "high" || meta["extra"] != "x" || meta["thinking"] != "high" || ps[0]["text"] != "plain" {
		t.Fatalf("prompt log %v", ps[0])
	}
	recv := f.events("recv")
	var sawPrompt bool
	for _, r := range recv {
		if r["method"] == "session/prompt" {
			sawPrompt = strings.Contains(fmt.Sprint(r["params"]), "prefixCwd:false")
		}
	}
	if !sawPrompt {
		t.Fatalf("full session/prompt frame not logged: %v", recv)
	}
}

func TestLiveModelDirective(t *testing.T) {
	cases := map[string]bool{
		"/model":                 true,
		"/model x":               true,
		"/MODEL x":               true,
		"hello /model x":         true,
		"x\n/model:foo":          true,
		"x\u00a0/model":          true,
		"x\ufeff/model":          true,
		"hello \u200b/model x":   false, // neutralized by the wrapper
		"\u200b/model":           false,
		"/models are fun":        false,
		"a/model":                false,
		"see /modelx":            false,
		"/path/like/this /model": true,
		"":                       false,
	}
	for text, want := range cases {
		if got := LiveModelDirective(text); got != want {
			t.Errorf("LiveModelDirective(%q) = %v, want %v", text, got, want)
		}
	}
}

func TestACPTripwire(t *testing.T) {
	for _, tc := range []struct {
		name, text string
		trips      bool
	}{
		{"live", "hello /model x", true},
		{"neutralized", "hello \u200b/model x", false},
		{"non-directive", "/models are fun and a/model", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			c := f.startACP("")
			c.initialize()
			sid := c.newSession(key1, "/ws")
			tr := c.prompt(sid, tc.text, nil)
			if !tc.trips {
				if tr.stop != "end_turn" || !strings.HasSuffix(tr.text, tc.text) {
					t.Fatalf("%+v", tr)
				}
				if len(f.events("tripwire")) != 0 {
					t.Fatal("tripwire logged")
				}
				return
			}
			if code := c.waitExit(t); code != 3 {
				t.Fatalf("exit code %d, want 3", code)
			}
			if len(f.events("tripwire")) != 1 || !strings.Contains(c.stderrText(), "tripwire") {
				t.Fatalf("tripwire not recorded; stderr %q", c.stderrText())
			}
		})
	}
}

func TestACPCancel(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	sid := c.newSession(key1, "/ws")
	from := c.mark()
	ch := c.start("session/prompt", map[string]any{"sessionId": sid, "prompt": []any{map[string]any{"type": "text", "text": "please SLOW down"}}})
	deadline := time.Now().Add(5 * time.Second)
	for agentText(c.updates(from), sid) == "" {
		if time.Now().After(deadline) {
			t.Fatal("no first chunk from SLOW prompt")
		}
		time.Sleep(10 * time.Millisecond)
	}
	t0 := time.Now()
	c.notify("session/cancel", map[string]any{"sessionId": sid})
	m, _ := c.wait(ch, 5*time.Second)
	if !strings.Contains(string(m.Result), `"cancelled"`) || time.Since(t0) > 2*time.Second {
		t.Fatalf("cancel: %s after %s", m.Result, time.Since(t0))
	}
	if tr := c.prompt(sid, "next", nil); tr.stop != "end_turn" || !strings.Contains(tr.text, "turn=2") {
		t.Fatalf("after cancel: %+v", tr)
	}
	// session/close also resolves a pending prompt cancelled.
	ch = c.start("session/prompt", map[string]any{"sessionId": sid, "prompt": []any{map[string]any{"type": "text", "text": "SLOW"}}})
	time.Sleep(100 * time.Millisecond)
	c.mustCall("session/close", map[string]any{"sessionId": sid})
	if m, _ := c.wait(ch, 5*time.Second); !strings.Contains(string(m.Result), `"cancelled"`) {
		t.Fatalf("close during prompt: %s %s", m.Result, m.Error)
	}
}

func TestACPExecPwd(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	sid := c.newSession(key1, "/ws/lane")
	if tr := c.prompt(sid, "EXEC:pwd", nil); tr.text != "/ws/lane" {
		t.Fatalf("pwd without sessions.create = %q", tr.text)
	}
	key2 := "agent:lane:sb-33333333-3333-4333-8333-333333333333"
	if g := f.gateway(t, "", "sessions.create", map[string]any{"key": key2, "cwd": "/ws/lane/sub"}); g.code != 0 {
		t.Fatalf("create: %+v", g)
	}
	sid2 := c.newSession(key2, "/ws/lane")
	if tr := c.prompt(sid2, "EXEC:pwd", nil); tr.text != "/ws/lane/sub" {
		t.Fatalf("pwd after sessions.create = %q", tr.text)
	}
}

func TestACPToolsCompact(t *testing.T) {
	for _, tc := range []struct {
		script string
		want   bool
	}{{"", true}, {`{"noSessionbus":true}`, false}} {
		f := newFixture(t)
		c := f.startACP(tc.script)
		c.initialize()
		sid := c.newSession(key1, "/ws")
		tr := c.prompt(sid, "/tools compact", map[string]any{"prefixCwd": false})
		if !strings.HasPrefix(tr.text, "Tools (compact): exec") || strings.Contains(tr.text, "sessionbus") != tc.want {
			t.Fatalf("script %q: %q", tc.script, tr.text)
		}
	}
}

func TestACPRejectThinking(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"rejectThinking":{"xhigh":"mock/mock"}}`)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	tr := c.prompt(sid, "hi", map[string]any{"thinking": "xhigh"})
	if tr.stop != "end_turn" || !strings.HasPrefix(tr.text, `Thinking level "xhigh" is not supported for mock/mock. Use one of: `) {
		t.Fatalf("%+v", tr)
	}
	if tr := c.prompt(sid, "hi", map[string]any{"thinking": "low"}); !strings.HasPrefix(tr.text, "ECHO") {
		t.Fatalf("supported level: %+v", tr)
	}
}

func TestACPPermissions(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"permissions":[{"kind":"execute","title":"exec: id"}]}`)
	var mu sync.Mutex
	var seen []rpcMsg
	c.onPerm = func(m rpcMsg) any {
		mu.Lock()
		seen = append(seen, m)
		mu.Unlock()
		var p struct {
			ToolCall struct{ Kind string } `json:"toolCall"`
		}
		_ = json.Unmarshal(m.Params, &p)
		if p.ToolCall.Kind == "read" {
			return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": "allow-once"}}
		}
		return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": "deny"}}
	}
	c.initialize()
	sid := c.newSession(key1, "/ws")
	tr := c.prompt(sid, "go ASK:read:read-file", nil)
	if tr.stop != "end_turn" || !strings.Contains(tr.text, "PERMISSION execute -> deny\n") || !strings.Contains(tr.text, "PERMISSION read -> allow-once\n") {
		t.Fatalf("%+v", tr)
	}
	mu.Lock()
	if len(seen) != 2 {
		t.Fatalf("requests %d", len(seen))
	}
	var p struct {
		SessionID string `json:"sessionId"`
		ToolCall  struct {
			Title, Kind, Status string
		} `json:"toolCall"`
		Options []struct{ OptionID, Kind string } `json:"options"`
	}
	_ = json.Unmarshal(seen[0].Params, &p)
	mu.Unlock()
	if p.SessionID != sid || p.ToolCall.Kind != "execute" || p.ToolCall.Title != "exec: id" || p.ToolCall.Status != "pending" ||
		len(p.Options) != 2 || p.Options[0].OptionID != "allow-once" || p.Options[0].Kind != "allow_once" || p.Options[1].Kind != "reject_once" {
		t.Fatalf("request payload %s", seen[0].Params)
	}
	ans := f.events("permission_answer")
	if len(ans) != 2 || ans[0]["outcome"] != "deny" || ans[1]["outcome"] != "allow-once" || ans[1]["kind"] != "read" {
		t.Fatalf("answers %v", ans)
	}
	if _, ok := ans[0]["latencyMs"].(float64); !ok {
		t.Fatalf("latency not recorded: %v", ans[0])
	}
}

func TestACPPermissionUnansweredAndLate(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"permissionTimeoutMs":200}`)
	c.onPerm = func(rpcMsg) any { return nil } // never answer
	c.initialize()
	sid := c.newSession(key1, "/ws")
	tr := c.prompt(sid, "ASK:execute", nil)
	if !strings.Contains(tr.text, "PERMISSION execute -> unanswered") || len(f.events("permission_unanswered")) != 1 {
		t.Fatalf("%+v", tr)
	}
	// Without a timeout the request waits; a cancel resolves the prompt and a late answer is still recorded.
	f2 := newFixture(t)
	c2 := f2.startACP("")
	reqs := make(chan rpcMsg, 1)
	c2.onPerm = func(m rpcMsg) any { reqs <- m; return nil }
	c2.initialize()
	sid2 := c2.newSession(key1, "/ws")
	ch := c2.start("session/prompt", map[string]any{"sessionId": sid2, "prompt": []any{map[string]any{"type": "text", "text": "ASK:execute"}}})
	var req rpcMsg
	select {
	case req = <-reqs:
	case <-time.After(5 * time.Second):
		t.Fatal("no permission request")
	}
	c2.notify("session/cancel", map[string]any{"sessionId": sid2})
	if m, _ := c2.wait(ch, 5*time.Second); !strings.Contains(string(m.Result), "cancelled") {
		t.Fatalf("prompt after cancel: %s", m.Result)
	}
	c2.send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}})
	deadline := time.Now().Add(5 * time.Second)
	for len(f2.events("permission_answer")) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("late answer not recorded")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if a := f2.events("permission_answer")[0]; a["outcome"] != "cancelled" {
		t.Fatalf("late answer %v", a)
	}
}

func TestACPPermissionOptionsOverride(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"permissions":[{"kind":"execute","options":[{"optionId":"x","kind":"weird"},"malformed"]}]}`)
	got := make(chan rpcMsg, 1)
	c.onPerm = func(m rpcMsg) any { got <- m; return map[string]any{"outcome": map[string]any{"outcome": "cancelled"}} }
	c.initialize()
	sid := c.newSession(key1, "/ws")
	tr := c.prompt(sid, "x", nil)
	m := <-got
	if !strings.Contains(string(m.Params), `"options":[{"optionId":"x","kind":"weird"},"malformed"]`) || !strings.Contains(tr.text, "-> cancelled") {
		t.Fatalf("params %s reply %q", m.Params, tr.text)
	}
}

func TestACPCrashAfter(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"crashAfter":2,"crashExitCode":7}`)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	if tr := c.prompt(sid, "one", nil); tr.stop != "end_turn" {
		t.Fatalf("%+v", tr)
	}
	from := c.mark()
	tr := c.prompt(sid, "two", nil)
	if tr.err != "process exited" {
		t.Fatalf("crash turn: %+v", tr)
	}
	if code := c.waitExit(t); code != 7 {
		t.Fatalf("exit %d", code)
	}
	if got := agentText(c.updates(from), sid); got != "partial answer before crash" {
		t.Fatalf("partial chunk %q", got)
	}
}

func TestACPNoiseStderrMarkerFail(t *testing.T) {
	marker := "OCPSECRET-0123456789abcdef0123456789abcdef01234567"
	f := newFixture(t)
	c := f.startACP(`{"noise":["banner line","{not json"],"stderr":["warn: something"],"marker":"` + marker + `","fail":{"session/resume":"resume exploded"}}`)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	if tr := c.prompt(sid, "hi", nil); tr.stop != "end_turn" {
		t.Fatalf("%+v", tr)
	}
	_, e := c.call("session/resume", map[string]any{"sessionId": key1, "cwd": "/ws", "mcpServers": []any{}})
	if !strings.Contains(e, "resume exploded") || !strings.Contains(e, marker) {
		t.Fatalf("fail error %q", e)
	}
	_, noise, _ := c.snapshot()
	count := map[string]int{}
	for _, n := range noise {
		count[n]++
	}
	if count["banner line"] != 2 || count["{not json"] != 2 || count["[openclaw] credential "+marker] != 2 {
		t.Fatalf("noise %q", noise)
	}
	if se := c.stderrText(); !strings.Contains(se, "warn: something") || !strings.Contains(se, marker) {
		t.Fatalf("stderr %q", se)
	}
}

func TestACPOverlongLine(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"overlongLineBytes":9437184}`)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	c.prompt(sid, "hi", nil)
	if _, _, maxLine := c.snapshot(); maxLine < 9437184 {
		t.Fatalf("longest line %d", maxLine)
	}
}

func TestACPBigReply(t *testing.T) {
	for _, esc := range []bool{false, true} {
		f := newFixture(t)
		c := f.startACP(fmt.Sprintf(`{"bigReplyBytes":1572864,"bigReplyEscapes":%v}`, esc))
		c.initialize()
		sid := c.newSession(key1, "/ws")
		tr := c.prompt(sid, "hi", nil)
		if len(tr.text) != 1572864 || tr.stop != "end_turn" {
			t.Fatalf("escapes=%v: %d bytes, %q", esc, len(tr.text), tr.stop)
		}
		enc, _ := json.Marshal(tr.text)
		if esc && len(enc) < 3*len(tr.text) {
			t.Fatalf("escape-heavy reply expands only to %d bytes", len(enc))
		}
		if !esc && strings.ContainsAny(tr.text, "\"\\<>&") {
			t.Fatal("plain reply has escapes")
		}
	}
}

func TestACPChunksDelayStopExtraUpdates(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"chunks":["a","b","c"],"chunkDelayMs":30,"delayMs":50,"stopReason":"max_tokens","extraUpdates":true}`)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	from := c.mark()
	t0 := time.Now()
	tr := c.prompt(sid, "hi", nil)
	if tr.text != "abc" || tr.stop != "max_tokens" || time.Since(t0) < 100*time.Millisecond {
		t.Fatalf("%+v after %s", tr, time.Since(t0))
	}
	kinds := map[string]bool{}
	foreign := false
	for _, u := range c.updates(from) {
		kinds[u.Update.SessionUpdate] = true
		foreign = foreign || u.SessionID == "foreign-"+sid
	}
	if !kinds["agent_thought_chunk"] || !kinds["tool_call"] || !kinds["tool_call_update"] || !foreign {
		t.Fatalf("extra updates %v foreign=%v", kinds, foreign)
	}
}

func TestACPStartLogsEnv(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("", "OPENCLAW_GATEWAY_TOKEN=tok", "OPENCLAW_HIDE_BANNER=1")
	c.initialize()
	st := f.events("start")
	if len(st) != 1 || st[0]["hasGatewayToken"] != true || st[0]["hasGatewayPassword"] != false || st[0]["hideBanner"] != "1" {
		t.Fatalf("start %v", st)
	}
	if !strings.Contains(fmt.Sprint(st[0]["envNames"]), "OPENCLAW_GATEWAY_TOKEN") || strings.Contains(fmt.Sprint(st[0]), "=tok") {
		t.Fatalf("env names/values %v", st[0])
	}
	if argv := fmt.Sprint(st[0]["argv"]); !strings.HasSuffix(argv, " acp]") {
		t.Fatalf("argv %s", argv)
	}
}

func TestBadScriptRejected(t *testing.T) {
	f := newFixture(t)
	cmd := exec.Command(os.Args[0], "acp")
	cmd.Env = f.env(`{"chunkz":["typo"]}`)
	out, err := cmd.CombinedOutput()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 2 || !strings.Contains(string(out), "chunkz") {
		t.Fatalf("err %v out %q", err, out)
	}
	// A script file path works too.
	p := filepath.Join(t.TempDir(), "s.json")
	_ = os.WriteFile(p, []byte(`{"chunks":["from file"]}`), 0o600)
	c := f.startACP(p)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	if tr := c.prompt(sid, "x", nil); tr.text != "from file" {
		t.Fatalf("%+v", tr)
	}
}

// ---------------------------------------------------------------- Gateway tests

type gwResult struct {
	code           int
	stdout, stderr string
	env            map[string]any // parsed stdout envelope/result when JSON
}

func (f *fixture) gatewayArgs(t *testing.T, script string, extraEnv []string, args ...string) gwResult {
	t.Helper()
	cmd := exec.Command(os.Args[0], append([]string{"gateway", "call"}, args...)...)
	cmd.Env = f.env(script, extraEnv...)
	var so, se bytes.Buffer
	cmd.Stdout, cmd.Stderr = &so, &se
	err := cmd.Run()
	r := gwResult{stdout: so.String(), stderr: se.String()}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		r.code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(so.Bytes(), &r.env)
	return r
}

func (f *fixture) gateway(t *testing.T, script, method string, params any, extraEnv ...string) gwResult {
	t.Helper()
	b, _ := json.Marshal(params)
	return f.gatewayArgs(t, script, extraEnv, method, "--json", "--params", string(b))
}

func TestGatewaySessionsCreateGetPatchList(t *testing.T) {
	f := newFixture(t)
	g := f.gateway(t, "", "sessions.create", map[string]any{"key": key1, "cwd": "/ws/lane/sub"}, "OPENCLAW_GATEWAY_PASSWORD=pw")
	if g.code != 0 || g.env["ok"] != true || g.env["key"] != key1 {
		t.Fatalf("create %+v", g)
	}
	calls := f.events("gateway_call")
	if len(calls) != 1 || calls[0]["method"] != "sessions.create" || calls[0]["json"] != true || calls[0]["hasGatewayPassword"] != true || calls[0]["hasGatewayToken"] != false {
		t.Fatalf("gateway_call log %v", calls)
	}
	if p, _ := calls[0]["params"].(map[string]any); p["cwd"] != "/ws/lane/sub" || p["key"] != key1 {
		t.Fatalf("params %v", calls[0]["params"])
	}
	if argv := fmt.Sprint(calls[0]["argv"]); !strings.Contains(argv, "gateway call sessions.create --json --params") {
		t.Fatalf("argv %s", argv)
	}
	g = f.gateway(t, "", "sessions.get", map[string]any{"key": key1})
	if g.code != 0 || g.env["spawnedCwd"] != "/ws/lane/sub" {
		t.Fatalf("get %+v", g)
	}
	key2 := "agent:lane:sb-44444444-4444-4444-8444-444444444444"
	if g = f.gateway(t, "", "sessions.patch", map[string]any{"key": key2, "model": "mock/mock-b"}); g.code != 0 || g.env["ok"] != true {
		t.Fatalf("patch %+v", g)
	}
	g = f.gateway(t, "", "sessions.get", map[string]any{"key": key2})
	if _, has := g.env["spawnedCwd"]; has || g.env["model"] != "mock/mock-b" {
		t.Fatalf("patched row %+v", g)
	}
	if g = f.gateway(t, "", "sessions.get", map[string]any{"key": "agent:lane:none"}); g.code != 0 || g.env["spawnedCwd"] != nil {
		t.Fatalf("unknown row %+v", g)
	}
	g = f.gateway(t, "", "sessions.list", map[string]any{})
	if !strings.Contains(g.stdout, key1) || !strings.Contains(g.stdout, key2) {
		t.Fatalf("list %+v", g)
	}
	// A patched (auto-vivified) key is resumable over ACP.
	c := f.startACP("")
	c.initialize()
	if _, e := c.call("session/resume", map[string]any{"sessionId": key2, "cwd": "/ws", "mcpServers": []any{}}); e != "" {
		t.Fatal(e)
	}
	if tr := c.prompt(key2, "hi", nil); !strings.Contains(tr.text, "model=mock/mock-b") {
		t.Fatalf("%+v", tr)
	}
}

func TestGatewaySpawnedCwdDrift(t *testing.T) {
	f := newFixture(t)
	f.gateway(t, "", "sessions.create", map[string]any{"key": key1, "cwd": "/ws/lane/sub"})
	if g := f.gateway(t, `{"spawnedCwd":{"*":"/elsewhere"}}`, "sessions.get", map[string]any{"key": key1}); g.env["spawnedCwd"] != "/elsewhere" {
		t.Fatalf("wildcard drift %+v", g)
	}
	if g := f.gateway(t, `{"spawnedCwd":{"`+key1+`":"/k"}}`, "sessions.get", map[string]any{"key": key1}); g.env["spawnedCwd"] != "/k" {
		t.Fatalf("keyed drift %+v", g)
	}
}

func TestGatewayFailures(t *testing.T) {
	marker := "OCPSECRET-fedcba9876543210fedcba9876543210fedcba98"
	for _, tc := range []struct {
		name, fail, method string
		check              func(t *testing.T, g gwResult)
	}{
		{"missing_admin", "missing_admin", "sessions.create", func(t *testing.T, g gwResult) {
			e, _ := g.env["error"].(map[string]any)
			d, _ := e["details"].(map[string]any)
			if g.env["ok"] != false || e["type"] != "gateway_request_error" || e["code"] != "FORBIDDEN" ||
				!strings.HasPrefix(fmt.Sprint(e["message"]), "missing scope: operator.admin") || d["missingScope"] != "operator.admin" || e["retryable"] != false {
				t.Fatalf("%+v", g)
			}
		}},
		{"unknown_model", "unknown_model", "sessions.patch", func(t *testing.T, g gwResult) {
			e, _ := g.env["error"].(map[string]any)
			if e["type"] != "gateway_request_error" || e["code"] != "INVALID_REQUEST" || !strings.HasPrefix(fmt.Sprint(e["message"]), "model not allowed: bad/model") {
				t.Fatalf("%+v", g)
			}
			if _, has := e["details"]; has {
				t.Fatalf("unknown model has details: %+v", g)
			}
		}},
		{"transport", "transport", "sessions.get", func(t *testing.T, g gwResult) {
			if g.env != nil || !strings.Contains(g.stdout, "gateway closed") {
				t.Fatalf("transport output must be non-JSON: %+v", g)
			}
		}},
		// formatGatewayAuthErrorJson (call.ts:348-364) sets only type and message.
		{"credentials_required", "credentials_required", "sessions.create", func(t *testing.T, g gwResult) {
			e, _ := g.env["error"].(map[string]any)
			if g.env["ok"] != false || e["type"] != "gateway_credentials_required" || len(e) != 2 || str(e["message"]) == "" {
				t.Fatalf("%+v", g)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			script := fmt.Sprintf(`{"marker":%q,"gateway":{%q:{"fail":%q}}}`, marker, tc.method, tc.fail)
			g := f.gateway(t, script, tc.method, map[string]any{"key": key1, "cwd": "/x", "model": "bad/model"})
			if g.code != 1 {
				t.Fatalf("exit %d: %+v", g.code, g)
			}
			tc.check(t, g)
			if !strings.Contains(g.stdout, marker) || !strings.Contains(g.stderr, marker) {
				t.Fatalf("marker must ride the error message and stderr: %+v", g)
			}
			// A failed call records nothing in the state.
			if b, err := os.ReadFile(filepath.Join(f.state, "sessions.json")); err == nil && strings.Contains(string(b), key1) {
				t.Fatalf("state written on failure: %s", b)
			}
		})
	}
}

// For a narrow credential: exec.approvals.get (the lane's admin guard probe) is refused for the default,
// non-admin credential with the same missing-scope shape as missing_admin; `admin` makes it
// answer; a scripted fail still wins.
func TestGatewayExecApprovalsGet(t *testing.T) {
	f := newFixture(t)
	g := f.gateway(t, "", "exec.approvals.get", map[string]any{})
	e, _ := g.env["error"].(map[string]any)
	d, _ := e["details"].(map[string]any)
	if g.code != 1 || g.env["ok"] != false || e["type"] != "gateway_request_error" || e["code"] != "FORBIDDEN" ||
		e["message"] != "missing scope: operator.admin" || d["missingScope"] != "operator.admin" {
		t.Fatalf("default (non-admin) %+v", g)
	}
	g = f.gateway(t, `{"admin":true}`, "exec.approvals.get", map[string]any{})
	if g.code != 0 || g.env["ok"] != nil || g.env["file"] == nil || g.env["hash"] == nil {
		t.Fatalf("admin %+v", g)
	}
	g = f.gateway(t, `{"admin":true,"gateway":{"exec.approvals.get":{"fail":"transport"}}}`, "exec.approvals.get", map[string]any{})
	if g.code != 1 || g.env != nil || !strings.Contains(g.stdout, "gateway closed") {
		t.Fatalf("scripted transport %+v", g)
	}
	if n := len(f.events("gateway_call")); n != 3 {
		t.Fatalf("gateway_call events %d, want 3", n)
	}
}

func TestGatewayExecApprovalsUnrelatedFailures(t *testing.T) {
	f := newFixture(t)
	for _, tc := range []struct{ fail, code, scope string }{
		{"unrelated_internal", "INTERNAL", ""},
		{"unrelated_missing_scope", "FORBIDDEN", "operator.pairing"},
	} {
		g := f.gateway(t, fmt.Sprintf(`{"gateway":{"exec.approvals.get":{"fail":%q}}}`, tc.fail), "exec.approvals.get", map[string]any{})
		e, _ := g.env["error"].(map[string]any)
		d, _ := e["details"].(map[string]any)
		if g.code != 1 || e["type"] != "gateway_request_error" || e["code"] != tc.code || d["missingScope"] != tc.scope && !(tc.scope == "" && d == nil) {
			t.Fatalf("%s: %+v", tc.fail, g)
		}
	}
}

func TestGatewayMarkerOnSuccessStaysOffStdout(t *testing.T) {
	marker := "OCPSECRET-00112233445566778899aabbccddeeff00112233"
	f := newFixture(t)
	g := f.gateway(t, `{"marker":"`+marker+`","stderr":["note"]}`, "sessions.create", map[string]any{"key": key1, "cwd": "/w"})
	if g.code != 0 || strings.Contains(g.stdout, marker) || !strings.Contains(g.stderr, marker) || !strings.Contains(g.stderr, "note") {
		t.Fatalf("%+v", g)
	}
}

func TestGatewayArgvForms(t *testing.T) {
	f := newFixture(t)
	// Under --json the URL-override refusal is the credentials envelope on stdout
	// (client-bootstrap.ts:37-79 → register.ts:94-118 → call.ts:348-364); without --json, stderr.
	g := f.gatewayArgs(t, "", nil, "sessions.get", "--json", "--url", "ws://x", "--params", `{"key":"k"}`)
	if e, _ := g.env["error"].(map[string]any); g.code != 1 || g.env["ok"] != false || e["type"] != "gateway_credentials_required" ||
		!strings.HasPrefix(str(e["message"]), "gateway url override requires explicit credentials") {
		t.Fatalf("--json --url %+v", g)
	}
	if g := f.gatewayArgs(t, "", nil, "sessions.get", "--url=ws://x", "--params", `{"key":"k"}`); g.code != 1 || g.stdout != "" || !strings.Contains(g.stderr, "requires explicit credentials") {
		t.Fatalf("--url without --json %+v", g)
	}
	if flags := fmt.Sprint(f.events("gateway_call")[0]["flags"]); !strings.Contains(flags, "--url") {
		t.Fatalf("flags not logged: %s", flags)
	}
	if g := f.gatewayArgs(t, "", nil, "sessions.get", "--params", `{"key":"k"}`); g.code != 0 || !strings.HasPrefix(g.stdout, "Gateway call: sessions.get\n") {
		t.Fatalf("no --json %+v", g)
	}
	if g := f.gatewayArgs(t, "", nil, "sessions.get", "--json", "--params", `{bad`); g.code != 1 || !strings.Contains(g.stderr, "--params must be valid JSON") {
		t.Fatalf("bad params %+v", g)
	}
	if g := f.gatewayArgs(t, `{"gatewayNoise":["banner"]}`, nil, "sessions.get", "--json", "--params="+`{"key":"k"}`); g.code != 0 || !strings.HasPrefix(g.stdout, "banner\n{") {
		t.Fatalf("gatewayNoise %+v", g)
	}
	if g := f.gateway(t, `{"gateway":{"sessions.get":{"delayMs":150}}}`, "sessions.get", map[string]any{"key": "k"}); g.code != 0 {
		t.Fatalf("delay %+v", g)
	}
	if g := f.gateway(t, "", "sessions.delete", map[string]any{"key": "k"}); g.code != 1 || !strings.Contains(g.stdout, "unknown method") {
		t.Fatalf("unknown method %+v", g)
	}
}

func TestGatewaySessionsListDriftAndSearch(t *testing.T) {
	f := newFixture(t)
	other := "agent:b:sb-55555555-5555-4555-8555-555555555555"
	f.gateway(t, "", "sessions.create", map[string]any{"key": key1, "cwd": "/ws/lane/sub"})
	f.gateway(t, "", "sessions.create", map[string]any{"key": other, "cwd": "/ws/b"})
	rows := func(g gwResult) []any { r, _ := g.env["sessions"].([]any); return r }
	g := f.gateway(t, "", "sessions.list", map[string]any{"search": key1})
	if rs := rows(g); len(rs) != 1 || rs[0].(map[string]any)["spawnedCwd"] != "/ws/lane/sub" {
		t.Fatalf("search %+v", g)
	}
	g = f.gateway(t, `{"spawnedCwd":{"*":"/elsewhere"}}`, "sessions.list", map[string]any{"search": key1})
	if rs := rows(g); len(rs) != 1 || rs[0].(map[string]any)["spawnedCwd"] != "/elsewhere" {
		t.Fatalf("drift %+v", g)
	}
	if g = f.gateway(t, "", "sessions.list", map[string]any{"search": "agent:none"}); len(rows(g)) != 0 || g.code != 0 {
		t.Fatalf("no match %+v", g)
	}
}

func TestACPPermissionOnClose(t *testing.T) {
	for _, answer := range []bool{true, false} {
		f := newFixture(t)
		c := f.startACP(`{"permissionOnClose":true}`)
		c.onPerm = func(rpcMsg) any {
			if !answer {
				return nil
			}
			return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": "deny"}}
		}
		c.initialize()
		sid := c.newSession(key1, "/ws")
		t0 := time.Now()
		c.mustCall("session/close", map[string]any{"sessionId": sid})
		if answer {
			if a := f.events("permission_answer"); len(a) != 1 || a[0]["outcome"] != "deny" || time.Since(t0) > 2*time.Second {
				t.Fatalf("answered close: %v", a)
			}
		} else if u := f.events("permission_unanswered"); len(u) != 1 || time.Since(t0) < 3*time.Second {
			t.Fatalf("unanswered close: %v after %s", u, time.Since(t0))
		}
	}
}

func TestACPTextCrashAndOverlong(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"chunks":["scripted"],"rejectThinking":{"high":"m/m"}}`)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	// /tools compact wins over scripted replies and thinking refusals.
	if tr := c.prompt(sid, "/tools compact", map[string]any{"thinking": "high"}); !strings.Contains(tr.text, "sessionbus") {
		t.Fatalf("%+v", tr)
	}
	c.prompt(sid, "x OVERLONG:9437184", nil)
	if _, _, maxLine := c.snapshot(); maxLine < 9437184 {
		t.Fatalf("longest line %d", maxLine)
	}
	if tr := c.prompt(sid, "please CRASH", nil); tr.err != "process exited" {
		t.Fatalf("%+v", tr)
	}
	if code := c.waitExit(t); code != 1 {
		t.Fatalf("exit %d", code)
	}
}

func str(v any) string { s, _ := v.(string); return s }

func TestACPBigReplyUnit(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"bigReplyBytes":300000,"bigReplyUnit":"\u0001<\""}`)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	tr := c.prompt(sid, "hi", nil)
	if len(tr.text) != 300000 || tr.text != strings.Repeat("\x01<\"", 100000) {
		t.Fatalf("custom unit reply: %d bytes, prefix %q", len(tr.text), tr.text[:min(9, len(tr.text))])
	}
}

// A cancel written right behind its prompt must cancel it (8.2 pendingPromptAdmissions).
func TestACPCancelRightAfterPrompt(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	sid := c.newSession(key1, "/ws")
	for i := 0; i < 50; i++ {
		ch := c.start("session/prompt", map[string]any{"sessionId": sid, "prompt": []any{map[string]any{"type": "text", "text": "SLOW"}}})
		c.notify("session/cancel", map[string]any{"sessionId": sid})
		if m, _ := c.wait(ch, 5*time.Second); !strings.Contains(string(m.Result), `"cancelled"`) {
			t.Fatalf("iteration %d: %s %s", i, m.Result, m.Error)
		}
	}
}

// The wrapper's readiness prompt gets a fixed reply: no scripted permissions, updates, delay or
// stop reason (those belong to caller turns), and the prompt event names the voice files present.
func TestACPReadinessIsFixed(t *testing.T) {
	f := newFixture(t)
	voice := t.TempDir()
	sum := sha256.Sum256([]byte(key1))
	if err := os.WriteFile(filepath.Join(voice, hex.EncodeToString(sum[:])[:32]+".json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := f.startACP(`{"permissions":[{"kind":"execute"}],"stopReason":"max_tokens","extraUpdates":true,"delayMs":2500,"permissionTimeoutMs":200}`, "FAKEACP_VOICE_DIR="+voice)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	start := time.Now()
	tr := c.prompt(sid, "/tools compact", map[string]any{"prefixCwd": false})
	if tr.stop != "end_turn" || tr.text != "Tools (compact): exec, read, write, sessionbus" || time.Since(start) > 2*time.Second {
		t.Fatalf("readiness reply %+v after %s", tr, time.Since(start))
	}
	if n := len(f.events("permission_request")); n != 0 {
		t.Fatalf("readiness raised %d permission request(s)", n)
	}
	ps := f.events("prompt")
	if v, _ := ps[len(ps)-1]["voice"].(map[string]any); v["json"] != true || v["sock"] != false {
		t.Fatalf("voice field %v", ps[len(ps)-1]["voice"])
	}
	if tr := c.prompt(sid, "caller turn", nil); tr.stop != "max_tokens" {
		t.Fatalf("caller turn lost the script: %+v", tr)
	}
}

// readinessPermissions (opt-in) makes the readiness prompt raise the scripted permissions too;
// session/close records which voice files exist at that moment.
func TestACPReadinessPermissionsAndCloseVoice(t *testing.T) {
	f := newFixture(t)
	voice := t.TempDir()
	sum := sha256.Sum256([]byte(key1))
	reg := filepath.Join(voice, hex.EncodeToString(sum[:])[:32]+".json")
	if err := os.WriteFile(reg, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := f.startACP(`{"permissions":[{"kind":"read"}],"readinessPermissions":true}`, "FAKEACP_VOICE_DIR="+voice)
	c.onPerm = func(rpcMsg) any {
		return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": "deny"}}
	}
	c.initialize()
	sid := c.newSession(key1, "/ws")
	tr := c.prompt(sid, "/tools compact", map[string]any{"prefixCwd": false})
	if tr.stop != "end_turn" || tr.text != "PERMISSION read -> deny\nTools (compact): exec, read, write, sessionbus" {
		t.Fatalf("readiness reply %+v", tr)
	}
	if as := f.events("permission_answer"); len(as) != 1 || as[0]["optionId"] != "deny" {
		t.Fatalf("answers %v", as)
	}
	c.mustCall("session/close", map[string]any{"sessionId": sid})
	cl := f.events("session_close")
	if v, _ := cl[len(cl)-1]["voice"].(map[string]any); len(cl) != 1 || cl[0]["key"] != key1 || v["json"] != true || v["sock"] != false {
		t.Fatalf("session_close %v", cl)
	}
}

func TestACPNoChunks(t *testing.T) {
	f := newFixture(t)
	c := f.startACP(`{"noChunks":true}`)
	c.initialize()
	sid := c.newSession(key1, "/ws")
	if tr := c.prompt(sid, "hi", nil); tr.text != "" || tr.stop != "end_turn" {
		t.Fatalf("%+v", tr)
	}
	if tr := c.prompt(sid, "/tools compact", nil); !strings.Contains(tr.text, "sessionbus") {
		t.Fatalf("readiness reply suppressed: %+v", tr)
	}
}

func TestACPExitAfterReply(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	sid := c.newSession(key1, "/ws")
	if tr := c.prompt(sid, "bye EXIT_AFTER", nil); tr.stop != "end_turn" {
		t.Fatalf("%+v", tr)
	}
	if code := c.waitExit(t); code != 1 || len(f.events("exit_after_reply")) != 1 {
		t.Fatalf("exit %d", code)
	}
}

func TestACPCrashNow(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	sid := c.newSession(key1, "/ws")
	from := c.mark()
	if tr := c.prompt(sid, "go CRASH_NOW", nil); tr.err != "process exited" {
		t.Fatalf("%+v", tr)
	}
	if code := c.waitExit(t); code != 1 || len(c.updates(from)) != 0 {
		t.Fatalf("exit %d, updates %v", code, c.updates(from))
	}
}

func TestACPCrashCleanExit(t *testing.T) {
	f := newFixture(t)
	c := f.startACP("")
	c.initialize()
	sid := c.newSession(key1, "/ws")
	from := c.mark()
	if tr := c.prompt(sid, "go CRASH0", nil); tr.err != "process exited" {
		t.Fatalf("%+v", tr)
	}
	if code := c.waitExit(t); code != 0 || len(c.updates(from)) != 1 || len(f.events("crash")) != 1 {
		t.Fatalf("exit %d, updates %v", code, c.updates(from))
	}
}

func TestGatewaySessionsListDecoys(t *testing.T) {
	f := newFixture(t)
	f.gateway(t, "", "sessions.create", map[string]any{"key": key1, "cwd": "/ws/lane/sub"})
	g := f.gateway(t, `{"decoyCwd":"=original","spawnedCwd":{"`+key1+`":"/moved"}}`, "sessions.list", map[string]any{"search": key1})
	rs, _ := g.env["sessions"].([]any)
	if len(rs) != 3 {
		t.Fatalf("rows %+v", g)
	}
	want := [][2]string{{key1 + ":thread:1", "/ws/lane/sub"}, {key1, "/moved"}, {key1 + ":thread:2", "/ws/lane/sub"}}
	for i, w := range want {
		r := rs[i].(map[string]any)
		if r["key"] != w[0] || r["spawnedCwd"] != w[1] {
			t.Fatalf("row %d = %v, want %v", i, r, w)
		}
	}
}
