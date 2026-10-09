package lane

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	kit "github.com/antst/sessionbus/bus/sdk/go"
)

// The bridge is the worker's channel to the OpenClaw plugin (bridge wire v1, JSON Lines over a
// unix socket): settings, lane registration, steer, and the lane's voice (bus.action).
const (
	bridgeDialTimeout = 5 * time.Second
	bridgeMaxFrame    = 1 << 20
	bridgeEnvVar      = "SESSIONBUS_OPENCLAW_BRIDGE"
	bridgeSocketName  = "bridge.sock"
	bridgeDirPrefix   = "openclaw-sessionbus"
)

// bridgeRPCDeadline bounds every worker→plugin frame write and answer wait. A Bridge copies it at
// creation, so a test that shortens its own bridge's deadline never races another bridge's goroutines.
const bridgeRPCDeadline = 10 * time.Second

// ErrNotWritten: the steer frame never reached the plugin. ErrNoReply: it was written and the
// answer never came (disconnect or deadline), so the plugin may or may not have admitted it.
var (
	ErrNotWritten = errors.New("bridge: frame not written")
	ErrNoReply    = errors.New("bridge: no reply after write")
)

// BridgeError is an error frame from the plugin.
type BridgeError struct{ Code, Message string }

func (e *BridgeError) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return e.Code + ": " + e.Message
}

// Settings is the `settings.get` result.
type Settings struct {
	Agents        []Agent `json:"agents"`
	CredentialDir string  `json:"credentialDir"`
	AuditLog      string  `json:"auditLog,omitempty"`
}

type bridgeFrame struct {
	V      int             `json:"v"`
	ID     string          `json:"id"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *BridgeError    `json:"error,omitempty"`
}

type Bridge struct {
	conn        net.Conn
	rpcDeadline time.Duration // fixed at creation; read by write and call
	done        chan struct{}

	wmu sync.Mutex // serializes frame writes

	mu      sync.Mutex
	seq     int
	pending map[string]chan bridgeFrame
	actions map[string]context.CancelFunc
	caller  actionCaller
	onLost  func()
	lost    bool // read loop ended
	closed  bool // Close was called: no OnLost
	fired   bool
	ctx     context.Context
	cancel  context.CancelFunc
}

// ResolveEndpoint mirrors src/bridge-path.js: $SESSIONBUS_OPENCLAW_BRIDGE, then
// $XDG_RUNTIME_DIR/openclaw-sessionbus/bridge.sock, then /tmp/openclaw-sessionbus-<uid>/bridge.sock.
func ResolveEndpoint(env []string) string {
	v := envValues(env)
	if p := v[bridgeEnvVar]; p != "" {
		return p
	}
	if x := v["XDG_RUNTIME_DIR"]; x != "" {
		return filepath.Join(x, bridgeDirPrefix, bridgeSocketName)
	}
	return filepath.Join("/tmp", bridgeDirPrefix+"-"+strconv.Itoa(os.Getuid()), bridgeSocketName)
}

// Dial connects to the plugin's bridge socket and starts reading frames.
func Dial(ctx context.Context, endpoint string) (*Bridge, error) {
	info, err := os.Lstat(endpoint)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return nil, fmt.Errorf("%s is not a socket", endpoint)
	}
	d := net.Dialer{Timeout: bridgeDialTimeout}
	conn, err := d.DialContext(ctx, "unix", endpoint)
	if err != nil {
		return nil, err
	}
	return newBridge(conn, bridgeRPCDeadline), nil
}

func newBridge(conn net.Conn, rpcDeadline time.Duration) *Bridge {
	b := &Bridge{conn: conn, rpcDeadline: rpcDeadline, done: make(chan struct{}), pending: map[string]chan bridgeFrame{}, actions: map[string]context.CancelFunc{}}
	b.ctx, b.cancel = context.WithCancel(context.Background())
	go b.readLoop()
	return b
}

func (b *Bridge) readLoop() {
	scanner := bufio.NewScanner(b.conn)
	scanner.Buffer(make([]byte, 4096), bridgeMaxFrame)
	for scanner.Scan() {
		var f bridgeFrame
		if json.Unmarshal(scanner.Bytes(), &f) != nil || f.V != 1 {
			continue
		}
		if f.Method != "" {
			b.handleRequest(f)
			continue
		}
		b.mu.Lock()
		ch := b.pending[f.ID]
		delete(b.pending, f.ID)
		b.mu.Unlock()
		if ch != nil {
			ch <- f
		}
	}
	b.mu.Lock()
	b.lost = true
	for _, cancel := range b.actions {
		cancel()
	}
	fire := b.onLost != nil && !b.closed && !b.fired
	if fire {
		b.fired = true
	}
	fn := b.onLost
	b.mu.Unlock()
	b.cancel()
	_ = b.conn.Close()
	close(b.done)
	if fire {
		fn()
	}
}

func (b *Bridge) handleRequest(f bridgeFrame) {
	switch f.Method {
	case "bus.action":
		var p struct {
			Action    string          `json:"action"`
			Arguments json.RawMessage `json:"arguments"`
		}
		b.mu.Lock()
		caller := b.caller
		b.mu.Unlock()
		if json.Unmarshal(f.Params, &p) != nil || p.Action == "" {
			b.reply(f.ID, nil, &BridgeError{"action_failed", "bad bus.action params"})
			return
		}
		if caller == nil {
			b.reply(f.ID, nil, &BridgeError{"action_failed", "lane voice not ready: Sessionbus caller unavailable"})
			return
		}
		ctx, cancel := context.WithCancel(b.ctx)
		b.mu.Lock()
		b.actions[f.ID] = cancel
		b.mu.Unlock()
		go func() {
			defer func() {
				b.mu.Lock()
				delete(b.actions, f.ID)
				b.mu.Unlock()
				cancel()
			}()
			result, err := caller.Action(ctx, p.Action, p.Arguments)
			switch {
			case ctx.Err() != nil && b.ctx.Err() == nil:
				b.reply(f.ID, nil, &BridgeError{"cancelled", "cancelled by rpc.cancel"})
			case err != nil:
				b.reply(f.ID, nil, &BridgeError{"action_failed", err.Error()})
			default:
				b.reply(f.ID, map[string]json.RawMessage{"result": result}, nil)
			}
		}()
	case "rpc.cancel":
		var p struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(f.Params, &p)
		b.mu.Lock()
		cancel := b.actions[p.ID]
		b.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		b.reply(f.ID, struct{}{}, nil)
	default:
		b.reply(f.ID, nil, &BridgeError{"unknown_method", f.Method})
	}
}

func (b *Bridge) reply(id string, result any, e *BridgeError) {
	f := map[string]any{"v": 1, "id": id}
	if e != nil {
		f["error"] = e
	} else {
		f["result"] = result
	}
	_ = b.write(f)
}

// write sends one frame under the writer lock with a deadline.
func (b *Bridge) write(frame any) error {
	line, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if len(line) >= bridgeMaxFrame {
		return fmt.Errorf("bridge frame too large (%d bytes)", len(line))
	}
	b.wmu.Lock()
	defer b.wmu.Unlock()
	_ = b.conn.SetWriteDeadline(time.Now().Add(b.rpcDeadline))
	if _, err = b.conn.Write(append(line, '\n')); err != nil {
		// A partly written frame leaves the JSON Lines stream with an unknown boundary: drop the
		// connection so the read loop ends and OnLost fires (fail closed).
		_ = b.conn.Close()
	}
	return err
}

// call sends a request and waits for its answer. A failure before or during the write is
// ErrNotWritten; once the frame is out, any missing answer is ErrNoReply.
func (b *Bridge) call(ctx context.Context, method string, params any, out any) error {
	if b == nil {
		return fmt.Errorf("%w: no bridge", ErrNotWritten)
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrNotWritten, err)
	}
	ch := make(chan bridgeFrame, 1)
	b.mu.Lock()
	if b.lost || b.closed {
		b.mu.Unlock()
		return fmt.Errorf("%w: bridge lost", ErrNotWritten)
	}
	b.seq++
	id := "w:" + strconv.Itoa(b.seq)
	b.pending[id] = ch
	b.mu.Unlock()
	forget := func() {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
	}
	if err := b.write(map[string]any{"v": 1, "id": id, "method": method, "params": json.RawMessage(raw)}); err != nil {
		forget()
		return fmt.Errorf("%w: %v", ErrNotWritten, err)
	}
	reply := func(f bridgeFrame) error {
		if f.Error != nil {
			return f.Error
		}
		if out != nil {
			return json.Unmarshal(f.Result, out)
		}
		return nil
	}
	timer := time.NewTimer(b.rpcDeadline)
	defer timer.Stop()
	select {
	case f := <-ch:
		return reply(f)
	case <-b.done:
		// readLoop queues a reply before it closes done: a reply that arrived wins over the drop.
		select {
		case f := <-ch:
			return reply(f)
		default:
		}
		forget()
		return fmt.Errorf("%w: bridge lost", ErrNoReply)
	case <-timer.C:
		forget()
		return fmt.Errorf("%w: no answer in %s", ErrNoReply, b.rpcDeadline)
	case <-ctx.Done():
		forget()
		return fmt.Errorf("%w: %v", ErrNoReply, ctx.Err())
	}
}

func (b *Bridge) Settings(ctx context.Context) (Settings, error) {
	var raw json.RawMessage
	var s Settings
	if err := b.call(ctx, "settings.get", struct{}{}, &raw); err != nil {
		return s, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	err := dec.Decode(&s)
	return s, err
}

func (b *Bridge) Register(ctx context.Context, key, agentID, acpSessionID string) error {
	return b.call(ctx, "lane.register", map[string]string{"sessionKey": key, "agentId": agentID, "acpSessionId": acpSessionID}, nil)
}

// Steer asks the plugin to inject text into the lane's active turn. An error frame comes back
// as *BridgeError (nothing was admitted).
func (b *Bridge) Steer(ctx context.Context, key, messageID, text string) (eligible bool, reason string, err error) {
	var r struct {
		Eligible bool   `json:"eligible"`
		Reason   string `json:"reason"`
	}
	err = b.call(ctx, "lane.steer", map[string]string{"sessionKey": key, "messageId": messageID, "text": text}, &r)
	return r.Eligible, r.Reason, err
}

// ServeActions starts answering the plugin's bus.action requests through caller.
func (b *Bridge) ServeActions(caller *kit.Caller) { b.serveActions(caller) }

// actionCaller is what bus.action needs from *kit.Caller.
type actionCaller interface {
	Action(ctx context.Context, action string, args json.RawMessage) (json.RawMessage, error)
}

func (b *Bridge) serveActions(caller actionCaller) {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.caller = caller
	b.mu.Unlock()
}

// OnLost registers fn, called once when the connection drops (not after Close). If the
// connection is already gone it runs at once.
func (b *Bridge) OnLost(fn func()) {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.onLost = fn
	fire := b.lost && !b.closed && !b.fired
	if fire {
		b.fired = true
	}
	b.mu.Unlock()
	if fire {
		fn()
	}
}

// Lost reports whether the connection has dropped.
func (b *Bridge) Lost() bool {
	if b == nil {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lost
}

func (b *Bridge) Close() {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	_ = b.conn.Close()
}
