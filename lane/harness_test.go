package lane_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/antst/sessionbus/bus/sdk/go/protocol"
	"github.com/imortkz/openclaw-peer/lane/internal/fakebridge"
	"github.com/sessionbus/peer-common/host"
	"github.com/sessionbus/peer-common/testsocket"

	lane "github.com/imortkz/openclaw-peer/lane"
)

// The harness: the real kit.NewWorker(lane.New(cfg)) (or the built openclaw-peer binary) talks to
// a daemon side played here over a unix socket with protocol.RequestBytes/ResultBytes/DecodeFrame
// (claude-peer wake_worker_test.go:47-164). The native side is the hermetic fake (internal/fakeacp);
// everything is observed on the wire or in the fake's log. No wrapper internals are touched.

const waitFor = 20 * time.Second

var uuid4 = `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`

func mintedKey(agent string) *regexp.Regexp {
	return regexp.MustCompile(`^agent:` + regexp.QuoteMeta(agent) + `:sb-` + uuid4 + `$`)
}

// ---------------------------------------------------------------- environment

type testEnv struct {
	t        *testing.T
	dir      string
	log      string
	state    string
	stateDir string
	script   string
	agents   []lane.Agent
	bridge   *fakebridge.Server // lazily started by vars()
	// steer, steerSeq and settings configure that fakebridge (see fakebridge.Options); settings
	// defaults to this env's agents.
	steer    string
	steerSeq []string
	settings any
}

// newEnv makes fresh agent workspaces (realpaths), a fake log and a fake state dir.
// agents are given as "id=description"; the default is one agent "lane".
func newEnv(t *testing.T, agents ...string) *testEnv {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := &testEnv{t: t, dir: dir, log: filepath.Join(dir, "fake.log"), state: filepath.Join(dir, "state"), stateDir: filepath.Join(dir, "oc-state")}
	if len(agents) == 0 {
		agents = []string{"lane=Lane role"}
	}
	for _, spec := range agents {
		id, desc, _ := strings.Cut(spec, "=")
		root := filepath.Join(dir, "ws", id)
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
		e.agents = append(e.agents, lane.Agent{ID: id, Workspace: root, Description: desc})
	}
	return e
}

func (e *testEnv) root(id string) string {
	for _, a := range e.agents {
		if a.ID == id {
			return a.Workspace
		}
	}
	e.t.Fatalf("no agent %q", id)
	return ""
}

func (e *testEnv) mkdir(parts ...string) string {
	p := filepath.Join(parts...)
	if err := os.MkdirAll(p, 0o700); err != nil {
		e.t.Fatal(err)
	}
	return p
}

// vars returns the lane and fake variables of this environment (they override TestMain's).
func (e *testEnv) vars() map[string]string {
	e.t.Helper()
	if e.bridge == nil {
		settings := e.settings
		if settings == nil {
			settings = map[string]any{"agents": e.agents, "credentialDir": filepath.Join(e.dir, "cli")}
		}
		e.bridge = fakebridge.Start(e.t, fakebridge.Options{Settings: settings, Steer: e.steer, SteerSeq: e.steerSeq})
	}
	vars := map[string]string{
		"SESSIONBUS_OPENCLAW_BRIDGE": e.bridge.Endpoint,
		"OPENCLAW_STATE_DIR":         e.stateDir,
		"FAKEACP_LOG":                e.log,
		"FAKEACP_STATE":              e.state,
		"FAKEACP_SCRIPT":             e.script,
	}
	return vars
}

func (e *testEnv) environ(extra ...string) []string {
	env := os.Environ()
	for k, v := range e.vars() {
		env = append(env, k+"="+v)
	}
	return append(env, extra...)
}

// ---------------------------------------------------------------- fake log

type logRec map[string]any

func (e *testEnv) events(name string) []logRec {
	e.t.Helper()
	b, err := os.ReadFile(e.log)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		e.t.Fatal(err)
	}
	var out []logRec
	for _, line := range bytes.Split(b, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var r logRec
		if json.Unmarshal(line, &r) != nil {
			e.t.Fatalf("fake log line is not JSON: %.200q", line)
		}
		if name == "" || r["event"] == name {
			out = append(out, r)
		}
	}
	return out
}

// acpStarts counts ACP child processes; gatewayCalls lists Gateway invocations of method ("" = all).
func (e *testEnv) acpStarts() int { return len(e.events("start")) }

func (e *testEnv) gatewayCalls(method string) []logRec {
	var out []logRec
	for _, r := range e.events("gateway_call") {
		if method == "" || r["method"] == method {
			out = append(out, r)
		}
	}
	return out
}

// recv lists inbound ACP frames of method as the fake received them.
func (e *testEnv) recv(method string) []map[string]any {
	var out []map[string]any
	for _, r := range e.events("recv") {
		if r["method"] == method {
			p, _ := r["params"].(map[string]any)
			out = append(out, p)
		}
	}
	return out
}

// callerPrompts are the prompt events (the wrapper sends none of its own).
func (e *testEnv) callerPrompts() []logRec { return e.events("prompt") }

// index returns the position of the first event matching pred in the whole log, or -1.
func (e *testEnv) index(pred func(logRec) bool) int {
	for i, r := range e.events("") {
		if pred(r) {
			return i
		}
	}
	return -1
}

// logTail renders the last n fake events (without bulky params) for failure messages.
func (e *testEnv) logTail(n int) string {
	all := e.events("")
	if len(all) > n {
		all = all[len(all)-n:]
	}
	var b strings.Builder
	for _, r := range all {
		fmt.Fprintf(&b, "  t=%v %v %v %v %v\n", r["t"], r["event"], r["method"], r["text"], r["stopReason"])
	}
	return b.String()
}

func (e *testEnv) noNativeWork(t *testing.T) {
	t.Helper()
	if n := e.acpStarts(); n != 0 {
		t.Errorf("ACP child started %d time(s), want none", n)
	}
	if g := e.gatewayCalls(""); len(g) != 0 {
		t.Errorf("gateway calls %v, want none", g)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ---------------------------------------------------------------- daemon side

type harness struct {
	t       *testing.T
	e       *testEnv
	wrapper *lane.Wrapper
	sock    string
	conn    net.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan protocol.Frame
	ready   chan protocol.TurnReady
	calls   chan protocol.Frame
	hello   protocol.HelloDescription
	eof     chan struct{}
	gone    chan struct{} // worker Serve returned / process exited
	stderr  *bytes.Buffer // binary mode only
	laneID  string
	seq     int
	lastRun string
}

type startMode int

const (
	inProcess startMode = iota
	binary
)

// start runs the real worker in process: kit.NewWorker(lane.New(cfg)).
func (e *testEnv) start() *harness { return e.startMode(inProcess) }

// startBinary runs the built openclaw-peer binary with extra env (for stderr and child-env truths).
func (e *testEnv) startBinary(extra ...string) *harness { return e.startMode(binary, extra...) }

func (e *testEnv) startMode(mode startMode, extra ...string) *harness {
	t := e.t
	t.Helper()
	h := &harness{t: t, e: e, pending: map[int64]chan protocol.Frame{}, ready: make(chan protocol.TurnReady, 16),
		calls: make(chan protocol.Frame, 16), eof: make(chan struct{}), gone: make(chan struct{})}
	h.sock = filepath.Join(testsocket.Directory(t), "bus.sock")
	listener, err := net.Listen("unix", h.sock)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	switch mode {
	case inProcess:
		for k, v := range e.vars() {
			t.Setenv(k, v)
		}
		t.Setenv(host.SocketEnv, h.sock)
		t.Setenv(host.TokenEnv, "lane-test-token")
		t.Setenv(host.LocalKeyEnv, "")
		cfg, bridge, err := lane.LoadConfig(os.Environ())
		if err != nil {
			t.Fatalf("LoadConfig: %v", err)
		}
		t.Cleanup(bridge.Close)
		w := lane.New(cfg, bridge)
		h.wrapper = w
		worker := kit.NewWorker(w)
		w.SetCaller(worker.Caller())
		w.SetShutdown(worker.Shutdown)
		go func() { _ = worker.Serve(context.Background()); close(h.gone) }()
		t.Cleanup(worker.Shutdown)
	case binary:
		cmd := exec.Command(workerBin)
		cmd.Env = e.environ(append([]string{host.SocketEnv + "=" + h.sock, host.TokenEnv + "=lane-test-token"}, extra...)...)
		h.stderr = &bytes.Buffer{}
		cmd.Stderr = &lockedBuffer{b: h.stderr, mu: &h.mu}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		go func() { _ = cmd.Wait(); close(h.gone) }()
		t.Cleanup(func() {
			select {
			case <-h.gone:
			case <-time.After(5 * time.Second):
				_ = cmd.Process.Kill()
			}
		})
	}
	_ = listener.(*net.UnixListener).SetDeadline(time.Now().Add(waitFor))
	h.conn, err = listener.Accept()
	if err != nil {
		t.Fatalf("worker did not connect: %v", err)
	}
	t.Cleanup(func() {
		_ = h.conn.Close()
		select {
		case <-h.gone:
		case <-time.After(10 * time.Second):
			t.Errorf("worker did not stop after the connection closed")
		}
	})
	helloCh := make(chan struct{})
	go h.read(helloCh)
	select {
	case <-helloCh:
	case <-time.After(waitFor):
		t.Fatal("no session.hello")
	}
	return h
}

type lockedBuffer struct {
	b  *bytes.Buffer
	mu *sync.Mutex
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (h *harness) workerStderr() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stderr == nil {
		return ""
	}
	return h.stderr.String()
}

func (h *harness) write(b []byte, err error) {
	if err != nil {
		h.t.Errorf("encode frame: %v", err)
		return
	}
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	_, _ = h.conn.Write(b)
}

func (h *harness) read(helloCh chan struct{}) {
	defer close(h.eof)
	r := bufio.NewReaderSize(h.conn, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			h.mu.Lock()
			for id, ch := range h.pending {
				close(ch)
				delete(h.pending, id)
			}
			h.mu.Unlock()
			return
		}
		frame, err := protocol.DecodeFrame(line[:len(line)-1])
		if err != nil {
			h.t.Errorf("worker sent an invalid frame: %v (%.300q)", err, line)
			return
		}
		if frame.Request {
			switch frame.Method {
			case "session.hello":
				var hello protocol.WorkerHello
				if err := json.Unmarshal(frame.Params, &hello); err != nil {
					h.t.Errorf("hello params: %v", err)
				}
				h.hello = hello.HelloDescription
				h.write(protocol.ResultBytes(frame.ID, "session.hello", struct{}{}))
				close(helloCh)
			case "turn.ready":
				var ready protocol.TurnReady
				_ = json.Unmarshal(frame.Params, &ready)
				h.write(protocol.ResultBytes(frame.ID, "turn.ready", struct{}{}))
				h.ready <- ready
			default:
				h.calls <- frame
			}
			continue
		}
		h.mu.Lock()
		ch := h.pending[frame.ID]
		delete(h.pending, frame.ID)
		h.mu.Unlock()
		if ch != nil {
			ch <- frame
		}
	}
}

// request sends one daemon→worker request and waits for its reply.
func (h *harness) request(method string, params any) (protocol.Frame, bool) {
	h.t.Helper()
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	ch := make(chan protocol.Frame, 1)
	h.pending[id] = ch
	h.mu.Unlock()
	h.write(protocol.RequestBytes(id, method, params))
	select {
	case f, ok := <-ch:
		return f, ok
	case <-time.After(waitFor):
		h.t.Fatalf("%s: no reply within %s", method, waitFor)
		return protocol.Frame{}, false
	}
}

// rpcText renders a worker error for assertions: code, message and data (spawn_failed carries
// the Open error in data.stderr_tail).
func rpcText(e *protocol.RPCError) string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%d %s %s", e.Code, e.Message, e.Data)
}

// Open sends session.open; it returns the lane ID or the worker's error.
func (h *harness) Open(o kit.OpenOptions) (string, *protocol.RPCError) {
	return h.open(kit.OpenRequest{Open: o})
}

func (h *harness) Resume(key string, o kit.OpenOptions) (string, *protocol.RPCError) {
	return h.open(kit.OpenRequest{ResumeSessionID: key, Open: o})
}

func (h *harness) open(req kit.OpenRequest) (string, *protocol.RPCError) {
	h.t.Helper()
	req.Name = "parent/lane@local"
	req.Groups = []string{"g"}
	req.Policy = &kit.LanePolicy{}
	f, ok := h.request("session.open", req)
	if !ok {
		return "", &protocol.RPCError{Code: 0, Message: "connection closed"}
	}
	if f.Error != nil {
		return "", f.Error
	}
	var res kit.OpenResult
	if err := protocol.UnmarshalResult("session.open", f.Result, &res); err != nil {
		h.t.Fatalf("open result: %v", err)
	}
	h.laneID = res.SessionID + "@local"
	return res.SessionID, nil
}

func (h *harness) mustOpen(o kit.OpenOptions) string {
	h.t.Helper()
	key, err := h.Open(o)
	if err != nil {
		h.t.Fatalf("open %+v: %s", o, rpcText(err))
	}
	return key
}

func (h *harness) mustResume(key string, o kit.OpenOptions) {
	h.t.Helper()
	got, err := h.Resume(key, o)
	if err != nil {
		h.t.Fatalf("resume %s: %s", key, rpcText(err))
	}
	if got != key {
		h.t.Fatalf("resume returned %q, want exactly %q", got, key)
	}
}

func (h *harness) nextRun() string {
	h.seq++
	h.lastRun = fmt.Sprintf("g/%d", h.seq)
	return h.lastRun
}

// Start sends turn.execute and returns once the worker accepted the run.
func (h *harness) Start(text string) string {
	h.t.Helper()
	run := h.nextRun()
	f, ok := h.request("turn.execute", protocol.ExecuteRequest{SessionID: h.laneID, RunID: run, Input: text})
	if !ok || f.Error != nil {
		h.t.Fatalf("turn.execute: %s", rpcText(f.Error))
	}
	return run
}

// Wait waits for turn.ready of run, reads turn.status and acknowledges it.
func (h *harness) Wait(run string) protocol.RunStatus {
	h.t.Helper()
	var ready protocol.TurnReady
	for ready.RunID != run {
		select {
		case ready = <-h.ready:
		case <-h.eof:
			h.t.Fatalf("connection closed before turn.ready of %s", run)
		case <-time.After(waitFor):
			h.t.Fatalf("no turn.ready for %s; fake log tail:\n%s", run, h.e.logTail(10))
		}
	}
	f, ok := h.request("turn.status", protocol.ReadRequest{SessionID: h.laneID, RunID: run})
	if !ok || f.Error != nil {
		h.t.Fatalf("turn.status: %s", rpcText(f.Error))
	}
	var st protocol.RunStatus
	if err := protocol.UnmarshalResult("turn.status", f.Result, &st); err != nil {
		h.t.Fatal(err)
	}
	if f, ok := h.request("turn.ack", protocol.RunRef{SessionID: h.laneID, RunID: run}); !ok || f.Error != nil {
		h.t.Fatalf("turn.ack: %s", rpcText(f.Error))
	}
	return st
}

// Execute runs one caller Text turn to its end.
func (h *harness) Execute(text string) protocol.RunStatus {
	h.t.Helper()
	return h.Wait(h.Start(text))
}

func (h *harness) Interrupt() *protocol.RPCError {
	h.t.Helper()
	f, _ := h.request("turn.interrupt", protocol.SessionTarget{SessionID: h.laneID})
	return f.Error
}

func source() kit.DeliverySource {
	return kit.DeliverySource{SessionID: "parent@local", Name: "parent", Product: "claude-peer", Groups: []string{"g"}}
}

// Deliver sends message.deliver without a run (a delivery to a lane that may be running).
func (h *harness) Deliver(body string) protocol.Frame {
	h.t.Helper()
	f, _ := h.request("message.deliver", kit.DeliveryRequest{MessageID: "m-idle", From: source(), Body: body})
	return f
}

// Wake delivers body as an idle-lane wake run and waits for the run to end.
func (h *harness) Wake(body string) (kit.DeliveryRequest, kit.DeliveryReceipt, *protocol.RPCError, protocol.RunStatus) {
	h.t.Helper()
	req := kit.DeliveryRequest{MessageID: fmt.Sprintf("m-%d", h.seq+1), RunID: h.nextRun(), From: source(), Body: body}
	f, ok := h.request("message.deliver", req)
	var receipt kit.DeliveryReceipt
	if ok && f.Error == nil {
		if err := protocol.UnmarshalResult("message.deliver", f.Result, &receipt); err != nil {
			h.t.Fatal(err)
		}
	}
	return req, receipt, f.Error, h.Wait(req.RunID)
}

// Close sends session.close and waits until the worker has stopped.
func (h *harness) Close() {
	h.t.Helper()
	f, ok := h.request("session.close", kit.SessionCloseRequest{SessionID: h.laneID})
	if ok && f.Error != nil {
		h.t.Fatalf("session.close: %s", rpcText(f.Error))
	}
	h.waitGone()
}

func (h *harness) waitGone() {
	h.t.Helper()
	select {
	case <-h.gone:
	case <-time.After(waitFor):
		h.t.Fatal("worker did not stop")
	}
}

// lockFree reports whether the lane lock of key can be taken (host.AcquireSessionLock).
func (h *harness) lockFree(key string) bool {
	l, err := host.AcquireSessionLock(h.sock, "openclaw-peer", key)
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

func completed(t *testing.T, st protocol.RunStatus) string {
	t.Helper()
	if st.State != "done" || st.Result == nil || st.Result.Outcome != "completed" {
		t.Fatalf("run %s: state=%s reason=%q result=%+v, want completed", st.RunID, st.State, st.Reason, st.Result)
	}
	return st.Result.Result
}

func outcome(st protocol.RunStatus) string {
	if st.Result == nil {
		return st.State + ":" + st.Reason
	}
	return st.Result.Outcome
}

func result(st protocol.RunStatus) string {
	if st.Result == nil {
		return ""
	}
	return st.Result.Result
}

func str(v any) string { s, _ := v.(string); return s }

func meta(r logRec) map[string]any { m, _ := r["meta"].(map[string]any); return m }

// WakeStart delivers body as a wake run and returns once message.deliver is answered (the
// receipt), without waiting for the run to end.
func (h *harness) WakeStart(body string) (kit.DeliveryRequest, kit.DeliveryReceipt, *protocol.RPCError) {
	h.t.Helper()
	req := kit.DeliveryRequest{MessageID: fmt.Sprintf("m-%d", h.seq+1), RunID: h.nextRun(), From: source(), Body: body}
	f, ok := h.request("message.deliver", req)
	var receipt kit.DeliveryReceipt
	if !ok {
		return req, receipt, &protocol.RPCError{Message: "connection closed"}
	}
	if f.Error == nil {
		if err := protocol.UnmarshalResult("message.deliver", f.Result, &receipt); err != nil {
			h.t.Fatal(err)
		}
	}
	return req, receipt, f.Error
}

// waitReady waits at most d for turn.ready of run and returns it without reading turn.status.
func (h *harness) waitReady(run string, d time.Duration) protocol.TurnReady {
	h.t.Helper()
	deadline := time.After(d)
	for {
		select {
		case ready := <-h.ready:
			if ready.RunID == run {
				return ready
			}
		case <-h.eof:
			h.t.Fatalf("connection closed before turn.ready of %s", run)
		case <-deadline:
			h.t.Fatalf("no turn.ready for %s within %s; fake log tail:\n%s", run, d, h.e.logTail(10))
		}
	}
}
