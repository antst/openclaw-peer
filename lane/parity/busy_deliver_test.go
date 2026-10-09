package parity

// TW-I1 — the busy-lane deliver truth over the real parity daemon (PLAN bus-0512,
// Test-writer stream): a SLOW run plus message.send → the delivery is steered through the
// worker bridge and answers `written` (T11/D2/D13), the agent never sees a second prompt,
// and the run's terminal stays collectable with turn.wait.
//
// What this file cannot prove here: the run *result containing the response* to the steered
// text — in parity the plugin side of the bridge is the developer-owned fakebridge, which
// answers lane.steer {eligible:true} but does not queue the text into the fake agent. That
// end-to-end clause belongs to the docker lane smoke `busy-mid` (F1b, master); noted as a
// gap in SUMMARY, not bent around.

import (
	"fmt"
	"testing"
)

func TestParityBusyDeliver(t *testing.T) {
	b := newBus(t)
	lane := b.mustSpawn(map[string]any{"arguments": []string{"--agent", "a"}})
	// One settled turn first, so the lane is open with the ACP child alive.
	completed(t, b.runText(lane, "hello"))

	var ref struct {
		RunID string `json:"run_id"`
	}
	b.mustCall("turn.start", map[string]any{"session_id": lane, "input": "SLOW work"}, &ref)
	eventually(t, "the SLOW prompt", func() bool {
		for _, p := range b.events("prompt") {
			if p["text"] == "SLOW work" {
				return true
			}
		}
		return false
	})

	// Three sends while the turn is live, so a lucky receipt cannot pass: each must come
	// back `written` for exactly this lane (T11: eligible steer in the bridge → written).
	const sends = 3
	for i := 1; i <= sends; i++ {
		body := fmt.Sprintf("mid-run steering number %d", i)
		var sent struct {
			Deliveries []struct {
				Target      string `json:"target"`
				SessionID   string `json:"session_id"`
				Disposition string `json:"disposition"`
				Reason      string `json:"reason"`
			} `json:"deliveries"`
		}
		b.mustCall("message.send", map[string]any{"target": lane, "message": body}, &sent)
		if len(sent.Deliveries) != 1 || sent.Deliveries[0].Disposition != "written" || sent.Deliveries[0].SessionID != lane {
			t.Fatalf("send %d: deliveries %+v, want exactly one written for %s", i, sent.Deliveries, lane)
		}
	}

	// The steered deliveries never became extra ACP prompts: still the hello + SLOW pair.
	if n := len(b.callerEvents("prompt")); n != 2 {
		t.Fatalf("prompts %d after %d busy sends, want 2 (a steered delivery must not prompt)", n, sends)
	}

	// The terminal of the steered run is still collectable (D13: no waiting on the turn
	// boundary in Deliver — the sender's hold ended at the receipt).
	b.mustCall("turn.interrupt", map[string]any{"session_id": lane}, nil)
	var st runStatus
	b.mustCall("turn.wait", map[string]any{"session_id": lane, "run_id": ref.RunID, "timeout_ms": 10000}, &st)
	if st.State != "done" || st.Result == nil || st.Result.Outcome != "interrupted" {
		t.Fatalf("wait after steer: %+v, want done/interrupted", st)
	}
	if n := len(b.callerEvents("prompt")); n != 2 {
		t.Fatalf("prompts %d after the terminal, want 2", n)
	}
}
