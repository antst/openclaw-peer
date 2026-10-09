// SPDX-License-Identifier: MIT
package host

import (
	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/antst/sessionbus/bus/sdk/go/protocol"
)

// NotRunning reports a definite pre-submission refusal. The daemon may retain
// the original, unmodified delivery and start or schedule a managed Run because
// no native or local queue submission was attempted before this error. The
// native turn may already have ended, or it may still be active without a
// receipt-safe mid-turn admission path.
func NotRunning() error {
	return &kit.ProtocolError{Code: protocol.NotRunning, Message: "not_running"}
}
