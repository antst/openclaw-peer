package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
)

const maxACPLine = 8 << 20

// ErrNotSent marks a Call that never reached the child: the client was already closed (a prior
// failure or a completed Close), or the write to stdin itself failed. Callers that must tell "the
// write never happened" apart from "sent, then lost" match on this with errors.Is.
var ErrNotSent = errors.New("acp request was not sent")

type response struct {
	result json.RawMessage
	err    error
}

type Client struct {
	input           io.Writer
	writeMu         sync.Mutex
	mu              sync.Mutex
	nextID          int64
	pending         map[int64]chan response
	inbound         map[string]bool
	closed          bool
	closing         bool
	failure         error
	updateSessionID string
	readerDone      chan struct{}
	OnRequest       func(context.Context, string, json.RawMessage) (any, error)
	OnUpdate        func(string, json.RawMessage)
	// taken is a test seam: run by the reader right after it has taken a correlated reply's
	// pending entry and released c.mu, before the reply is delivered. Nil in production.
	taken func()
}

func newClient(output io.Reader, input io.Writer) *Client {
	c := &Client{input: input, pending: make(map[int64]chan response), inbound: make(map[string]bool), readerDone: make(chan struct{})}
	go c.read(output)
	return c
}

func (c *Client) SetUpdateSessionID(id string) { c.mu.Lock(); c.updateSessionID = id; c.mu.Unlock() }

func (c *Client) Call(ctx context.Context, method string, params any, out any) error {
	c.mu.Lock()
	if c.closed {
		err := c.failure
		c.mu.Unlock()
		if err == nil {
			err = io.ErrClosedPipe
		}
		return fmt.Errorf("%w: %w", ErrNotSent, err)
	}
	c.nextID++
	id := c.nextID
	ch := make(chan response, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("%w: %w", ErrNotSent, err)
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		if out != nil {
			return json.Unmarshal(r.result, out)
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

func (c *Client) Notify(method string, params any) error {
	return c.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *Client) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.input.Write(b)
	if err != nil {
		// A dead child can close stdin before the reader/wait goroutine records its exit.
		// Preserve the original write error and let the wrapper retire that lane now.
		if errors.Is(err, syscall.EPIPE) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, os.ErrClosed) {
			return fmt.Errorf("acp write: %w: %w", ErrChildExited, err)
		}
		return fmt.Errorf("acp write: %w", err)
	}
	return nil
}

func (c *Client) read(output io.Reader) {
	defer close(c.readerDone)
	s := bufio.NewScanner(output)
	s.Buffer(make([]byte, 64<<10), maxACPLine+1)
	for s.Scan() {
		line := s.Bytes()
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(line, &msg) != nil {
			fmt.Fprintf(os.Stderr, "skipped non-JSON stdout line (%d bytes)\n", len(line))
			continue
		}
		if msg.Method != "" {
			if len(msg.ID) != 0 {
				go c.handleRequest(msg.ID, msg.Method, msg.Params)
			} else if msg.Method == "session/update" {
				c.handleUpdate(msg.Params)
			}
			continue
		}
		if len(msg.ID) == 0 {
			continue
		}
		var id int64
		if json.Unmarshal(msg.ID, &id) != nil {
			c.fail(errors.New("acp corrupt correlated response"))
			return
		}
		var rpcErr struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Data    struct {
				Details string `json:"details"`
			} `json:"data"`
		}
		corrupt := (len(msg.Result) == 0) == (len(msg.Error) == 0) ||
			len(msg.Error) != 0 && json.Unmarshal(msg.Error, &rpcErr) != nil
		c.mu.Lock()
		ch := c.pending[id]
		if ch == nil {
			c.mu.Unlock()
			continue
		}
		if corrupt {
			// Closed before any caller sees the error, the matched Call failed with the rest, in
			// one critical section: a Call made after the reply must get ErrNotSent, never be
			// written to the child (flake-acp-later-call).
			err := errors.New("acp corrupt correlated response")
			waiting := c.closeLocked(err)
			taken := c.taken
			c.mu.Unlock()
			if taken != nil {
				taken()
			}
			deliver(waiting, err)
			return
		}
		delete(c.pending, id)
		taken := c.taken
		c.mu.Unlock()
		if taken != nil {
			taken()
		}
		if len(msg.Error) != 0 {
			ch <- response{err: fmt.Errorf("acp error %d: %s", rpcErr.Code, sanitizeGatewayText(firstNonempty(rpcErr.Data.Details, rpcErr.Message)))}
		} else {
			ch <- response{result: append(json.RawMessage(nil), msg.Result...)}
		}
	}
	if err := s.Err(); err != nil {
		if strings.Contains(err.Error(), "token too long") {
			c.fail(errors.New("acp line exceeds 8 MiB"))
		} else {
			c.fail(fmt.Errorf("acp read: %w", err))
		}
	}
}

func firstNonempty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (c *Client) handleUpdate(raw json.RawMessage) {
	var v struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if json.Unmarshal(raw, &v) != nil {
		return
	}
	c.mu.Lock()
	wanted := c.updateSessionID
	handler := c.OnUpdate
	c.mu.Unlock()
	if handler != nil && wanted != "" && v.SessionID == wanted {
		handler(v.SessionID, v.Update)
	}
}

func (c *Client) handleRequest(id json.RawMessage, method string, params json.RawMessage) {
	key := string(id)
	c.mu.Lock()
	c.inbound[key] = true
	handler := c.OnRequest
	closed := c.closed || c.closing
	c.mu.Unlock()
	if closed {
		c.answerInbound(key, id, map[string]string{"outcome": "cancelled"}, nil)
		return
	}
	if handler == nil {
		c.answerInbound(key, id, nil, errors.New("method not found"))
		return
	}
	result, err := handler(context.Background(), method, params)
	c.answerInbound(key, id, result, err)
}

func (c *Client) answerInbound(key string, id json.RawMessage, result any, err error) {
	c.mu.Lock()
	active := c.inbound[key]
	delete(c.inbound, key)
	c.mu.Unlock()
	if !active {
		return
	}
	if err != nil {
		code := -32603
		if err.Error() == "method not found" {
			code = -32601
		}
		_ = c.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": sanitizeGatewayText(err.Error())}})
		return
	}
	_ = c.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (c *Client) closePending() {
	c.mu.Lock()
	c.closing = true
	ids := make([]json.RawMessage, 0, len(c.inbound))
	for key := range c.inbound {
		ids = append(ids, json.RawMessage(key))
	}
	c.mu.Unlock()
	for _, id := range ids {
		c.answerInbound(string(id), id, map[string]string{"outcome": "cancelled"}, nil)
	}
}

func (c *Client) fail(err error) {
	c.mu.Lock()
	waiting := c.closeLocked(err)
	c.mu.Unlock()
	deliver(waiting, err)
}

// closeLocked marks the client closed with err and takes every pending Call; the caller delivers
// err to them after releasing c.mu. Nil when the client was already closed. Called with c.mu held.
func (c *Client) closeLocked(err error) []chan response {
	if c.closed {
		return nil
	}
	c.closed = true
	c.failure = err
	waiting := make([]chan response, 0, len(c.pending))
	for id, ch := range c.pending {
		waiting = append(waiting, ch)
		delete(c.pending, id)
	}
	return waiting
}

func deliver(waiting []chan response, err error) {
	for _, ch := range waiting {
		ch <- response{err: err}
	}
}
