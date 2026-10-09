package lane

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/imortkz/openclaw-peer/lane/internal/fakebridge"
)

var testSettings = map[string]any{"agents": []Agent{{ID: "lane", Workspace: "/tmp/lane"}}, "credentialDir": "/tmp/cli"}

func dialFake(t *testing.T, opts fakebridge.Options) (*Bridge, *fakebridge.Server) {
	t.Helper()
	srv := fakebridge.Start(t, opts)
	b, err := Dial(context.Background(), srv.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	return b, srv
}

func TestBridgeResolveEndpoint(t *testing.T) {
	if got := ResolveEndpoint([]string{"SESSIONBUS_OPENCLAW_BRIDGE=/x/b.sock", "XDG_RUNTIME_DIR=/run"}); got != "/x/b.sock" {
		t.Fatalf("env: %q", got)
	}
	if got := ResolveEndpoint([]string{"XDG_RUNTIME_DIR=/run/u"}); got != "/run/u/openclaw-sessionbus/bridge.sock" {
		t.Fatalf("xdg: %q", got)
	}
	if got := ResolveEndpoint(nil); filepath.Base(got) != "bridge.sock" || filepath.Dir(filepath.Dir(got)) != "/tmp" {
		t.Fatalf("default: %q", got)
	}
}

func TestBridgeDialWithoutSocket(t *testing.T) {
	if _, err := Dial(context.Background(), filepath.Join(t.TempDir(), "none.sock")); err == nil {
		t.Fatal("Dial succeeded without a socket")
	}
	if _, err := Dial(context.Background(), t.TempDir()); err == nil {
		t.Fatal("Dial accepted a directory")
	}
}

func TestBridgeSettings(t *testing.T) {
	b, _ := dialFake(t, fakebridge.Options{Settings: testSettings})
	s, err := b.Settings(context.Background())
	if err != nil || len(s.Agents) != 1 || s.Agents[0].ID != "lane" || s.CredentialDir != "/tmp/cli" {
		t.Fatalf("settings %+v %v", s, err)
	}
	b2, _ := dialFake(t, fakebridge.Options{})
	_, err = b2.Settings(context.Background())
	var be *BridgeError
	if !errors.As(err, &be) || be.Code != "lanes_not_configured" {
		t.Fatalf("want lanes_not_configured, got %v", err)
	}
}

func TestBridgeRegisterErrorCodes(t *testing.T) {
	var got [3]string
	b, _ := dialFake(t, fakebridge.Options{OnRegister: func(key, agent, acp string) string {
		got = [3]string{key, agent, acp}
		if key == "bad" {
			return "bad_key"
		}
		return ""
	}})
	ctx := context.Background()
	if err := b.Register(ctx, "k", "lane", "acp-1"); err != nil || got != [3]string{"k", "lane", "acp-1"} {
		t.Fatalf("register: %v %v", err, got)
	}
	var be *BridgeError
	if err := b.Register(ctx, "bad", "lane", "acp-1"); !errors.As(err, &be) || be.Code != "bad_key" {
		t.Fatalf("want bad_key, got %v", err)
	}
}

func TestBridgeSteerOutcomesInternal(t *testing.T) {
	ctx := context.Background()
	b, srv := dialFake(t, fakebridge.Options{})
	if ok, _, err := b.Steer(ctx, "k", "m1", "hello"); err != nil || !ok {
		t.Fatalf("eligible: %v %v", ok, err)
	}
	ev := srv.Log()
	if len(ev) != 1 || ev[0].Method != "lane.steer" || ev[0].Params["sessionKey"] != "k" || ev[0].Params["messageId"] != "m1" || ev[0].Params["text"] != "hello" {
		t.Fatalf("steer frame: %+v", ev)
	}

	b, _ = dialFake(t, fakebridge.Options{Steer: fakebridge.False, Reason: "registry_absent"})
	if ok, reason, err := b.Steer(ctx, "k", "m", "t"); err != nil || ok || reason != "registry_absent" {
		t.Fatalf("not eligible: %v %q %v", ok, reason, err)
	}

	b, _ = dialFake(t, fakebridge.Options{Steer: fakebridge.NoReply})
	if _, _, err := b.Steer(ctx, "k", "m", "t"); !errors.Is(err, ErrNoReply) {
		t.Fatalf("no reply: %v", err)
	}

	// Close drops the connection after lane.register: the next frame is never written.
	b, _ = dialFake(t, fakebridge.Options{Steer: fakebridge.Close})
	if err := b.Register(ctx, "k", "lane", "acp"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-b.done:
	case <-time.After(5 * time.Second):
		t.Fatal("bridge not marked lost")
	}
	if _, _, err := b.Steer(ctx, "k", "m", "t"); !errors.Is(err, ErrNotWritten) {
		t.Fatalf("closed: %v", err)
	}

	// no bridge at all: nothing is written either.
	var none *Bridge
	if _, _, err := none.Steer(ctx, "k", "m", "t"); !errors.Is(err, ErrNotWritten) {
		t.Fatalf("nil bridge: %v", err)
	}
}

type fakeCaller struct {
	started   chan struct{}
	cancelled chan struct{} // closed when a blocked action sees its context cancelled
	err       error
}

func (c *fakeCaller) Action(ctx context.Context, action string, args json.RawMessage) (json.RawMessage, error) {
	if action == "block" {
		close(c.started)
		<-ctx.Done()
		if c.cancelled != nil {
			close(c.cancelled)
		}
		return nil, ctx.Err()
	}
	if c.err != nil {
		return nil, c.err
	}
	return json.RawMessage(`{"echo":` + string(args) + `}`), nil
}

func TestBridgeActionRoundTripAndCancel(t *testing.T) {
	b, srv := dialFake(t, fakebridge.Options{})
	caller := &fakeCaller{started: make(chan struct{})}
	b.serveActions(caller)
	// the fakebridge learns the connection from the first accepted dial; push an action.
	res, err := srv.SendAction("list", map[string]int{"n": 1})
	if err != nil || string(res) != `{"echo":{"n":1}}` {
		t.Fatalf("round trip: %s %v", res, err)
	}
	caller.err = errors.New("boom")
	if _, err := srv.SendAction("list", nil); err == nil || err.Error() != "action_failed: boom" {
		t.Fatalf("action error: %v", err)
	}
	caller.err = nil
	done := make(chan error, 1)
	go func() { _, err := srv.SendAction("block", nil); done <- err }()
	<-caller.started
	srv.Cancel("p:3") // p:1, p:2 were the earlier actions
	select {
	case err := <-done:
		if err == nil || err.Error() != "cancelled: cancelled by rpc.cancel" {
			t.Fatalf("cancel: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("action not cancelled")
	}
}

func TestBridgeActionWithoutCaller(t *testing.T) {
	_, srv := dialFake(t, fakebridge.Options{})
	if _, err := srv.SendAction("list", nil); err == nil {
		t.Fatal("action served without a caller")
	}
}

func TestBridgeLostFiresOnce(t *testing.T) {
	b, srv := dialFake(t, fakebridge.Options{})
	var n atomic.Int32
	lost := make(chan struct{}, 4)
	b.OnLost(func() { n.Add(1); lost <- struct{}{} })
	b.Settings(context.Background()) // the connection is established and served
	srv.Drop()
	select {
	case <-lost:
	case <-time.After(5 * time.Second):
		t.Fatal("OnLost not called")
	}
	time.Sleep(50 * time.Millisecond)
	b.Close()
	if n.Load() != 1 || !b.Lost() {
		t.Fatalf("OnLost calls = %d lost=%v", n.Load(), b.Lost())
	}
}

func TestBridgeLostBeforeOnLost(t *testing.T) {
	b, srv := dialFake(t, fakebridge.Options{})
	b.Settings(context.Background())
	srv.Drop()
	select {
	case <-b.done:
	case <-time.After(5 * time.Second):
		t.Fatal("bridge not marked lost")
	}
	var m atomic.Int32
	b.OnLost(func() { m.Add(1) })
	b.OnLost(func() { m.Add(1) })
	if m.Load() != 1 {
		t.Fatalf("late OnLost calls = %d, want 1", m.Load())
	}
}

func TestBridgeCloseIsNotLoss(t *testing.T) {
	b, _ := dialFake(t, fakebridge.Options{})
	var n atomic.Int32
	b.OnLost(func() { n.Add(1) })
	b.Close()
	<-b.done
	time.Sleep(50 * time.Millisecond)
	if n.Load() != 0 {
		t.Fatal("OnLost fired after Close")
	}
}

// CR-L1-1: a failed write leaves a frame of unknown extent on the stream, so the connection is
// dropped and OnLost fires instead of the next frame being glued onto the half line.
func TestBridgeWriteErrorClosesConnection(t *testing.T) {
	client, server := net.Pipe() // nobody reads server: the write times out
	defer server.Close()
	b := newBridge(client, 100*time.Millisecond)
	lost := make(chan struct{}, 1)
	b.OnLost(func() { lost <- struct{}{} })
	if _, _, err := b.Steer(context.Background(), "k", "m", "t"); !errors.Is(err, ErrNotWritten) {
		t.Fatalf("steer: %v", err)
	}
	select {
	case <-lost:
	case <-time.After(5 * time.Second):
		t.Fatal("connection kept open after a write error")
	}
	if _, _, err := b.Steer(context.Background(), "k", "m", "t"); !errors.Is(err, ErrNotWritten) {
		t.Fatalf("steer after loss: %v", err)
	}
}

// CR-L1-2: a silent plugin yields ErrNoReply at the RPC deadline, never a fake success.
func TestBridgeRPCDeadlineIsNoReply(t *testing.T) {
	srv := fakebridge.Start(t, fakebridge.Options{Steer: fakebridge.Silent})
	conn, err := net.Dial("unix", srv.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	b := newBridge(conn, 150*time.Millisecond)
	t.Cleanup(b.Close)
	start := time.Now()
	ok, _, err := b.Steer(context.Background(), "k", "m", "t")
	if !errors.Is(err, ErrNoReply) || ok {
		t.Fatalf("silent plugin: eligible=%v err=%v", ok, err)
	}
	if d := time.Since(start); d < 100*time.Millisecond || d > 3*time.Second {
		t.Fatalf("returned after %s, want about the deadline", d)
	}
	if b.Lost() {
		t.Fatal("a deadline is not a loss")
	}
}

// CR-L1-2: bridge loss cancels in-flight bus.action calls.
func TestBridgeLossCancelsInFlightActions(t *testing.T) {
	b, srv := dialFake(t, fakebridge.Options{})
	caller := &fakeCaller{started: make(chan struct{}), cancelled: make(chan struct{})}
	b.serveActions(caller)
	go srv.SendAction("block", nil)
	<-caller.started
	srv.Drop()
	select {
	case <-caller.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("in-flight action not cancelled on bridge loss")
	}
}
