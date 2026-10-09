package lane_test

// TW-L1 — public-surface tests for the worker↔plugin bridge (PLAN bus-0512, Test-writer stream).
// Written from the PLAN `## Interface` ("Bridge wire v1", "Bridge endpoint") and the `lane/bridge.go`
// artifact API; the only double is the developer-owned lane/internal/fakebridge (contract in
// `## Test-writer stream`). Compile errors against either are the expected red before wave L1.

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/testsocket"

	lane "github.com/imortkz/openclaw-peer/lane"
	"github.com/imortkz/openclaw-peer/lane/internal/fakebridge"
)

const twL1UUID = "12345678-1234-4123-8123-123456789012"

func twL1Settings(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"agents": []any{
			map[string]any{"id": "a", "workspace": t.TempDir(), "description": "agent a"},
		},
		"credentialDir": filepath.Join(t.TempDir(), "cli"),
	}
}

func twL1Env(endpoint string) []string {
	return []string{"SESSIONBUS_OPENCLAW_BRIDGE=" + endpoint}
}

func TestLoadConfigFromBridge(t *testing.T) {
	fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), Steer: "eligible"})
	cfg, bridge, err := lane.LoadConfig(twL1Env(fb.Endpoint))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.SettingsErr != nil {
		t.Fatalf("SettingsErr: %v", cfg.SettingsErr)
	}
	if bridge == nil {
		t.Fatal("LoadConfig returned a nil bridge for a live endpoint")
	}
	defer bridge.Close()
	if len(cfg.Agents) != 1 || cfg.Agents[0].ID != "a" || cfg.Agents[0].Description != "agent a" {
		t.Fatalf("agents = %+v, want the one agent from settings.get", cfg.Agents)
	}
	if cfg.CredentialDir == "" {
		t.Fatal("credentialDir not loaded from settings.get")
	}
}

func TestLoadConfigWithoutBridge(t *testing.T) {
	missing := filepath.Join(testsocket.Directory(t), "missing.sock")
	cfg, bridge, err := lane.LoadConfig(twL1Env(missing))
	if err != nil {
		t.Fatalf("an unavailable bridge must not be a load error: %v", err)
	}
	if bridge != nil {
		t.Fatal("bridge must be nil when the endpoint is unreachable")
	}
	if cfg.SettingsErr == nil {
		t.Fatal("SettingsErr must carry the operator hint")
	}
	// "lane settings unavailable" is Hello's prefix; the SettingsErr itself is the bridge hint.
	mustContain(t, "SettingsErr", cfg.SettingsErr.Error(), "start the Gateway with the sessionbus plugin installed", "SESSIONBUS_OPENCLAW_BRIDGE")
	if strings.Contains(cfg.SettingsErr.Error(), "channels.sessionbus.enabled") {
		t.Fatalf("the bridge runs without the channel; the hint must not name its flag: %v", cfg.SettingsErr)
	}
}

func TestOpenWithoutBridgeRefuses(t *testing.T) {
	missing := filepath.Join(testsocket.Directory(t), "missing.sock")
	cfg, _, err := lane.LoadConfig(twL1Env(missing))
	if err != nil || cfg.SettingsErr == nil {
		t.Fatalf("load: cfg=%+v err=%v, want a SettingsErr", cfg, err)
	}
	w := lane.New(cfg, nil)
	hello, err := w.Hello(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(hello.ExtraArguments) != 1 {
		t.Fatalf("hello = %+v", hello)
	}
	mustContain(t, "hello description", hello.ExtraArguments[0].Description, "lane settings unavailable")
	if _, err := w.Open(context.Background(), kit.OpenRequest{}); err == nil {
		t.Fatal("Open must refuse without bridge settings")
	} else {
		mustContain(t, "open error", err.Error(), "sessionbus plugin installed", "SESSIONBUS_OPENCLAW_BRIDGE")
		if strings.Contains(err.Error(), "channels.sessionbus.enabled") {
			t.Fatalf("open error names the channel flag: %v", err)
		}
	}
}

// twL1RegisterStub plays the plugin side of lane.register validation per Interface «Bridge wire v1»:
// the fakebridge double delegates the codes to OnRegister, so the rules live here, exactly as the
// Interface states them (the acpSessionID identifies the connection: one key per connection, one
// live registration per key). What the test proves is the worker-side surface: an error frame's
// code surfaces in Bridge.Register's error.
func twL1RegisterStub(agents ...string) func(sessionKey, agentID, acpSessionID string) string {
	known := map[string]bool{}
	for _, a := range agents {
		known[a] = true
	}
	bound := map[string]string{} // acpSessionID → key (one key per connection)
	live := map[string]string{}  // key → acpSessionID (one live registration per key)
	return func(key, agent, acp string) string {
		m := laneKeyRe.FindStringSubmatch(key)
		if m == nil {
			return "bad_key"
		}
		if !known[agent] {
			return "unknown_agent"
		}
		if m[1] != agent {
			return "agent_mismatch"
		}
		if _, ok := bound[acp]; ok {
			return "already_bound"
		}
		if _, ok := live[key]; ok {
			return "key_in_use"
		}
		bound[acp] = key
		live[key] = acp
		return ""
	}
}

var laneKeyRe = regexp.MustCompile(`^agent:([a-z0-9][a-z0-9_-]{0,63}):sb-.+$`)

func TestBridgeRegisterCodes(t *testing.T) {
	fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), OnRegister: twL1RegisterStub("a")})
	ctx := context.Background()
	bridge, err := lane.Dial(ctx, fb.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	settings, err := bridge.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Agents) != 1 || settings.Agents[0].ID != "a" {
		t.Fatalf("settings.get = %+v", settings)
	}

	key := "agent:a:sb-" + twL1UUID
	for _, tc := range []struct {
		name, key, agent, code string
	}{
		{"bad_key", "not-a-lane-key", "a", "bad_key"},
		{"unknown_agent", "agent:ghost:sb-" + twL1UUID, "ghost", "unknown_agent"},
		{"agent_mismatch", "agent:b:sb-" + twL1UUID, "a", "agent_mismatch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := bridge.Register(ctx, tc.key, tc.agent, "acp-1")
			if err == nil || !strings.Contains(err.Error(), tc.code) {
				t.Fatalf("Register(%s) error = %v, want code %s", tc.key, err, tc.code)
			}
		})
	}

	if err := bridge.Register(ctx, key, "a", "acp-1"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	registered := false
	for _, ev := range fb.Log() {
		if ev.Method == "lane.register" && str(ev.Params["sessionKey"]) == key {
			registered = true
		}
	}
	if !registered {
		t.Fatalf("fakebridge log has no lane.register for %s: %+v", key, fb.Log())
	}

	if err := bridge.Register(ctx, key, "a", "acp-1"); err == nil || !strings.Contains(err.Error(), "already_bound") {
		t.Fatalf("second register on one connection = %v, want already_bound", err)
	}

	// A fresh fakebridge (fresh registration state), two connections: the same key on a second
	// live connection is key_in_use.
	fb2 := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), OnRegister: twL1RegisterStub("a")})
	first, err := lane.Dial(ctx, fb2.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if err := first.Register(ctx, key, "a", "acp-1"); err != nil {
		t.Fatal(err)
	}
	second, err := lane.Dial(ctx, fb2.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err := second.Register(ctx, key, "a", "acp-3"); err == nil || !strings.Contains(err.Error(), "key_in_use") {
		t.Fatalf("register of a live key on a second connection = %v, want key_in_use", err)
	}
}

func TestBridgeSteerOutcomes(t *testing.T) {
	key := "agent:a:sb-" + twL1UUID
	text := "steer me mid-turn"

	t.Run("eligible", func(t *testing.T) {
		fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), Steer: "eligible"})
		ctx := context.Background()
		bridge, err := lane.Dial(ctx, fb.Endpoint)
		if err != nil {
			t.Fatal(err)
		}
		defer bridge.Close()
		if err := bridge.Register(ctx, key, "a", "acp-1"); err != nil {
			t.Fatal(err)
		}
		eligible, reason, err := bridge.Steer(ctx, key, "m-1", text)
		if err != nil {
			t.Fatalf("Steer: %v", err)
		}
		if !eligible || reason != "" {
			t.Fatalf("Steer = (%v, %q), want eligible with no reason", eligible, reason)
		}
		seen := false
		for _, ev := range fb.Log() {
			if ev.Method == "lane.steer" && str(ev.Params["sessionKey"]) == key && strings.Contains(str(ev.Params["text"]), text) {
				seen = true
			}
		}
		if !seen {
			t.Fatalf("fakebridge log has no lane.steer with key and text: %+v", fb.Log())
		}
	})

	t.Run("not eligible", func(t *testing.T) {
		fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), Steer: fakebridge.False})
		ctx := context.Background()
		bridge, err := lane.Dial(ctx, fb.Endpoint)
		if err != nil {
			t.Fatal(err)
		}
		defer bridge.Close()
		if err := bridge.Register(ctx, key, "a", "acp-1"); err != nil {
			t.Fatal(err)
		}
		eligible, _, err := bridge.Steer(ctx, key, "m-1", text)
		if err != nil {
			t.Fatalf("Steer: %v", err)
		}
		if eligible {
			t.Fatal("Steer = eligible, want eligible:false")
		}
	})

	t.Run("no reply after write", func(t *testing.T) {
		fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), Steer: fakebridge.NoReply})
		ctx := context.Background()
		bridge, err := lane.Dial(ctx, fb.Endpoint)
		if err != nil {
			t.Fatal(err)
		}
		defer bridge.Close()
		if err := bridge.Register(ctx, key, "a", "acp-1"); err != nil {
			t.Fatal(err)
		}
		_, _, err = bridge.Steer(ctx, key, "m-1", text)
		if !errors.Is(err, lane.ErrNoReply) {
			t.Fatalf("Steer error = %v, want ErrNoReply (frame written, no answer)", err)
		}
	})

	t.Run("connection dropped before the steer write", func(t *testing.T) {
		fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), Steer: fakebridge.Close})
		ctx := context.Background()
		bridge, err := lane.Dial(ctx, fb.Endpoint)
		if err != nil {
			t.Fatal(err)
		}
		defer bridge.Close()
		if err := bridge.Register(ctx, key, "a", "acp-1"); err != nil {
			t.Fatal(err)
		}
		// fakebridge.Close drops the connection only when serve returns: without the wait the
		// steer frame can be written first, and a written frame is ErrNoReply, not ErrNotWritten.
		eventually(t, "bridge drop", bridge.Lost)
		_, _, err = bridge.Steer(ctx, key, "m-1", text)
		if !errors.Is(err, lane.ErrNotWritten) {
			t.Fatalf("Steer error = %v, want ErrNotWritten (nothing was submitted)", err)
		}
	})
}

func TestBridgeActionRoundTripAndCancel(t *testing.T) {
	key := "agent:a:sb-" + twL1UUID

	t.Run("round trip", func(t *testing.T) {
		fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), Steer: "eligible"})
		ctx := context.Background()
		bridge, err := lane.Dial(ctx, fb.Endpoint)
		if err != nil {
			t.Fatal(err)
		}
		defer bridge.Close()
		if err := bridge.Register(ctx, key, "a", "acp-1"); err != nil {
			t.Fatal(err)
		}
		var calls atomic.Int32
		caller := kit.NewCaller(func(ctx context.Context, method string, params any) (json.RawMessage, error) {
			calls.Add(1)
			// kit.NewCaller validates the result against the method schema; message.send needs
			// {message_id, deliveries[]}.
			return json.RawMessage(`{"message_id":"m-1","deliveries":[{"session_id":"x@host","delivery_id":"d-1","target":"x@host","disposition":"queued_for_next_turn"}]}`), nil
		})
		bridge.ServeActions(caller)

		res, err := fb.SendAction("send", map[string]any{"target": "x@host", "message": "hi"})
		if err != nil {
			t.Fatalf("SendAction: %v", err)
		}
		if !strings.Contains(string(res), "queued_for_next_turn") || !strings.Contains(string(res), "m-1") {
			t.Fatalf("bus.action result = %s", res)
		}
		if n := calls.Load(); n != 1 {
			t.Fatalf("caller invoked %d time(s), want exactly one", n)
		}
	})

	t.Run("cancel", func(t *testing.T) {
		fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), Steer: "eligible"})
		ctx := context.Background()
		bridge, err := lane.Dial(ctx, fb.Endpoint)
		if err != nil {
			t.Fatal(err)
		}
		defer bridge.Close()
		if err := bridge.Register(ctx, key, "a", "acp-1"); err != nil {
			t.Fatal(err)
		}
		started := make(chan struct{})
		var once sync.Once
		caller := kit.NewCaller(func(ctx context.Context, method string, params any) (json.RawMessage, error) {
			once.Do(func() { close(started) })
			<-ctx.Done()
			return nil, ctx.Err()
		})
		bridge.ServeActions(caller)

		type outcome struct {
			res json.RawMessage
			err error
		}
		done := make(chan outcome, 1)
		go func() {
			res, err := fb.SendAction("list", map[string]any{})
			done <- outcome{res, err}
		}()
		// The fake bridge's first plugin→worker request is p:1; cancel only after the bridge has
		// the action in flight (rpc.cancel for an unknown id is a no-op).
		select {
		case <-started:
		case <-time.After(10 * time.Second):
			t.Fatal("the action never reached the caller")
		}
		fb.Cancel("p:1")
		select {
		case got := <-done:
			if got.err == nil || !strings.Contains(got.err.Error(), "cancelled") {
				t.Fatalf("cancelled action = (%s, %v), want error cancelled", got.res, got.err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("SendAction did not return after rpc.cancel")
		}
	})
}

func TestBridgeLostFiresOnce(t *testing.T) {
	fb := fakebridge.Start(t, fakebridge.Options{Settings: twL1Settings(t), Steer: "eligible"})
	ctx := context.Background()
	bridge, err := lane.Dial(ctx, fb.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	if err := bridge.Register(ctx, "agent:a:sb-"+twL1UUID, "a", "acp-1"); err != nil {
		t.Fatal(err)
	}
	var lost atomic.Int32
	bridge.OnLost(func() { lost.Add(1) })

	fb.Close()
	deadline := time.Now().Add(10 * time.Second)
	for lost.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if lost.Load() == 0 {
		t.Fatal("OnLost never fired after the bridge connection closed")
	}
	time.Sleep(200 * time.Millisecond)
	if n := lost.Load(); n != 1 {
		t.Fatalf("OnLost fired %d time(s), want exactly once", n)
	}
}
