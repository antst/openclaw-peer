package lane

// flake-bridge-close (CI 37785684215) — two schedules behind one fake option (fakebridge.Close).
// The first test is a regression test for the lost reply; the second pins the class of a steer
// frame written before the drop is observed.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/sessionbus/peer-common/testsocket"
)

// heldWriteConn returns from Write only after the bridge's read loop has ended: the caller reaches
// its select after the reply is queued and done is closed, as on a loaded CI runner.
type heldWriteConn struct {
	net.Conn
	done <-chan struct{}
}

func (c *heldWriteConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
	}
	return n, err
}

// Attempts 1–2 (bridge_test.go:107): the plugin answers lane.register and drops the connection.
// readLoop queues the answer in the buffered pending channel, then closes done; call's select sees
// both ready and picks at random, so an answer that arrived is reported as ErrNoReply.
func TestBridgeReplyBeforeDropIsDelivered(t *testing.T) {
	const trials = 64
	lostReplies := 0
	for i := 0; i < trials; i++ {
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			line, err := bufio.NewReader(server).ReadBytes('\n')
			if err != nil {
				return
			}
			var f bridgeFrame
			_ = json.Unmarshal(line, &f)
			reply, _ := json.Marshal(map[string]any{"v": 1, "id": f.ID, "result": map[string]bool{"ready": true}})
			_, _ = server.Write(append(reply, '\n'))
		}()
		conn := &heldWriteConn{Conn: client}
		b := &Bridge{conn: conn, rpcDeadline: bridgeRPCDeadline, done: make(chan struct{}), pending: map[string]chan bridgeFrame{}, actions: map[string]context.CancelFunc{}}
		b.ctx, b.cancel = context.WithCancel(context.Background())
		conn.done = b.done
		go b.readLoop()
		err := b.Register(context.Background(), "k", "lane", "acp")
		b.Close()
		if err != nil {
			if !errors.Is(err, ErrNoReply) {
				t.Fatalf("trial %d: unexpected error class: %v", i, err)
			}
			lostReplies++
		}
	}
	if lostReplies > 0 {
		t.Fatalf("%d/%d registers lost an answer that had arrived: bridge: no reply after write: bridge lost", lostReplies, trials)
	}
}

// Attempt 3 (bridge_public_test.go:292): fakebridge.Close writes the register answer and closes
// the connection only when serve returns, so the worker's lane.steer write can land first. A frame
// handed to the socket before the drop is observed is uncertain, not "nothing submitted": the class
// is ErrNoReply. ErrNotWritten holds only when the drop is observed before Steer (the public
// subtest waits for it). This fake closes right after the steer frame arrives.
func TestBridgeSteerWrittenBeforeDropIsNoReply(t *testing.T) {
	endpoint := filepath.Join(testsocket.Directory(t), "bridge.sock")
	ln, err := net.Listen("unix", endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		line, err := r.ReadBytes('\n') // lane.register
		if err != nil {
			return
		}
		var f bridgeFrame
		_ = json.Unmarshal(line, &f)
		reply, _ := json.Marshal(map[string]any{"v": 1, "id": f.ID, "result": map[string]bool{"ready": true}})
		_, _ = c.Write(append(reply, '\n'))
		_, _ = r.ReadBytes('\n') // the close is still pending when lane.steer arrives
	}()
	ctx := context.Background()
	b, err := Dial(ctx, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if err := b.Register(ctx, "k", "lane", "acp"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.Steer(ctx, "k", "m-1", "t"); !errors.Is(err, ErrNoReply) {
		t.Fatalf("Steer error = %v, want ErrNoReply (the frame was written before the drop)", err)
	}
}
