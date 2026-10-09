// Package fakebridge is a hermetic stand-in for the plugin side of the lane bridge (bridge wire v1,
// JSON Lines over a unix socket). It serves settings.get / lane.register / lane.steer by script,
// can push bus.action / rpc.cancel to the connected worker, and logs every request it receives.
package fakebridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/sessionbus/peer-common/testsocket"
)

// Steer modes for Options.Steer.
const (
	Eligible = "eligible" // {eligible:true}
	False    = "false"    // {eligible:false, reason:Options.Reason (default "not_eligible")}
	Refuse   = "refuse"   // answer lane.steer with an error frame (unbound)
	Silent   = "silent"   // read the lane.steer frame and never answer, keeping the connection open
	NoReply  = "no-reply" // read the lane.steer frame, then drop the connection without answering
	Close    = "close"    // drop the connection right after answering lane.register: the worker's
	// next frame is not written
)

type Options struct {
	// Settings is the settings.get result (any JSON-marshalable value); nil answers error
	// lanes_not_configured.
	Settings any
	// Steer is the lane.steer behaviour, default Eligible. SteerSeq, when set, overrides it call by
	// call; the last entry repeats.
	Steer    string
	SteerSeq []string
	Reason   string
	// OnRegister returns an error code for lane.register ("" accepts).
	OnRegister func(sessionKey, agentID, acpSessionID string) string
}

type Event struct {
	Method string
	Params map[string]any
}

type Server struct {
	Endpoint string

	t    *testing.T
	opts Options
	ln   net.Listener

	mu      sync.Mutex
	log     []Event
	conn    net.Conn
	connCh  chan struct{}
	steers  int
	seq     int
	waiters map[string]chan frame
}

type frame struct {
	V      int             `json:"v"`
	ID     string          `json:"id"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// Start listens on a fresh socket under a short temp dir and closes with the test.
func Start(t *testing.T, opts Options) *Server {
	t.Helper()
	if opts.Steer == "" {
		opts.Steer = Eligible
	}
	endpoint := filepath.Join(testsocket.Directory(t), "bridge.sock")
	ln, err := net.Listen("unix", endpoint)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Endpoint: endpoint, t: t, opts: opts, ln: ln, connCh: make(chan struct{}, 1), waiters: map[string]chan frame{}}
	go s.accept()
	t.Cleanup(s.Close)
	return s
}

func (s *Server) accept() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conn = c
		s.mu.Unlock()
		select {
		case s.connCh <- struct{}{}:
		default:
		}
		go s.serve(c)
	}
}

func (s *Server) serve(c net.Conn) {
	defer c.Close()
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 4096), 1<<20)
	for sc.Scan() {
		var f frame
		if json.Unmarshal(sc.Bytes(), &f) != nil {
			continue
		}
		if f.Method == "" {
			s.mu.Lock()
			ch := s.waiters[f.ID]
			delete(s.waiters, f.ID)
			s.mu.Unlock()
			if ch != nil {
				ch <- f
			}
			continue
		}
		var params map[string]any
		_ = json.Unmarshal(f.Params, &params)
		s.mu.Lock()
		s.log = append(s.log, Event{f.Method, params})
		s.mu.Unlock()
		if s.handle(c, f, params) {
			return
		}
	}
}

func (s *Server) write(c net.Conn, v any) {
	line, _ := json.Marshal(v)
	_, _ = c.Write(append(line, '\n'))
}

func (s *Server) ok(c net.Conn, id string, result any) {
	s.write(c, map[string]any{"v": 1, "id": id, "result": result})
}

func (s *Server) fail(c net.Conn, id, code, message string) {
	s.write(c, map[string]any{"v": 1, "id": id, "error": map[string]string{"code": code, "message": message}})
}

// handle answers one worker request; true means the connection was dropped.
func (s *Server) handle(c net.Conn, f frame, p map[string]any) bool {
	str := func(k string) string { v, _ := p[k].(string); return v }
	switch f.Method {
	case "settings.get":
		if s.opts.Settings == nil {
			s.fail(c, f.ID, "lanes_not_configured", "plugins.entries.sessionbus.config.lanes is not set")
		} else {
			s.ok(c, f.ID, s.opts.Settings)
		}
	case "lane.register":
		if s.opts.OnRegister != nil {
			if code := s.opts.OnRegister(str("sessionKey"), str("agentId"), str("acpSessionId")); code != "" {
				s.fail(c, f.ID, code, code)
				return false
			}
		}
		s.ok(c, f.ID, map[string]bool{"ready": true})
		if s.opts.Steer == Close {
			return true
		}
	case "lane.steer":
		s.mu.Lock()
		mode := s.opts.Steer
		if n := len(s.opts.SteerSeq); n > 0 {
			mode = s.opts.SteerSeq[min(s.steers, n-1)]
		}
		s.steers++
		s.mu.Unlock()
		switch mode {
		case Eligible:
			s.ok(c, f.ID, map[string]any{"eligible": true})
		case False:
			reason := s.opts.Reason
			if reason == "" {
				reason = "not_eligible"
			}
			s.ok(c, f.ID, map[string]any{"eligible": false, "reason": reason})
		case Refuse:
			s.fail(c, f.ID, "unbound", "connection has no registered lane")
		case Silent:
		case NoReply, Close:
			return true
		}
	default:
		s.fail(c, f.ID, "unknown_method", f.Method)
	}
	return false
}

// Log returns a copy of the requests received so far, in order.
func (s *Server) Log() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Event(nil), s.log...)
}

func (s *Server) waitConn() (net.Conn, error) {
	deadline := time.After(5 * time.Second)
	for {
		s.mu.Lock()
		c := s.conn
		s.mu.Unlock()
		if c != nil {
			return c, nil
		}
		select {
		case <-s.connCh:
		case <-deadline:
			return nil, errors.New("fakebridge: no worker connected")
		}
	}
}

func (s *Server) nextID() string {
	s.seq++
	return "p:" + strconv.Itoa(s.seq)
}

// SendAction pushes bus.action to the worker and waits for its answer. Request ids are p:1, p:2, …
// in send order (rpc.cancel frames take ids from the same counter).
func (s *Server) SendAction(action string, args any) (json.RawMessage, error) {
	c, err := s.waitConn()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	id := s.nextID()
	ch := make(chan frame, 1)
	s.waiters[id] = ch
	s.mu.Unlock()
	s.write(c, map[string]any{"v": 1, "id": id, "method": "bus.action", "params": map[string]any{"action": action, "arguments": args}})
	select {
	case f := <-ch:
		if f.Error != nil {
			return nil, errors.New(f.Error.Code + ": " + f.Error.Message)
		}
		var r struct {
			Result json.RawMessage `json:"result"`
		}
		_ = json.Unmarshal(f.Result, &r)
		return r.Result, nil
	case <-time.After(30 * time.Second):
		return nil, errors.New("fakebridge: no answer to bus.action")
	}
}

// Cancel pushes rpc.cancel for a previously sent action id.
func (s *Server) Cancel(id string) {
	c, err := s.waitConn()
	if err != nil {
		s.t.Fatal(err)
	}
	s.mu.Lock()
	rid := s.nextID()
	s.mu.Unlock()
	s.write(c, map[string]any{"v": 1, "id": rid, "method": "rpc.cancel", "params": map[string]string{"id": id}})
}

// Drop closes the current worker connection but keeps listening.
func (s *Server) Drop() {
	s.mu.Lock()
	c := s.conn
	s.mu.Unlock()
	if c != nil {
		_ = c.Close()
	}
}

func (s *Server) Close() {
	_ = s.ln.Close()
	s.Drop()
	_ = os.Remove(s.Endpoint)
}
