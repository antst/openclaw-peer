// Package lane is the openclaw-peer Sessionbus lane worker.
package lane

import (
	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/antst/sessionbus/bus/sdk/go/protocol"
	"github.com/sessionbus/peer-common/host"
	"github.com/sessionbus/peer-common/testsocket"
)

// Compile-time references to the kit/peer-common API this module relies on,
// so an incompatible dependency fails here rather than in a later wave.
var _ = []any{
	kit.NewWorker,
	host.AcquireSessionLock, host.RenderNativeMessage, host.NotRunning, host.BuildArguments,
	host.SocketEnv, host.LocalKeyEnv, host.TokenEnv, host.SessionIDEnv, host.NameEnv, host.GroupsEnv,
	testsocket.Directory,
	protocol.RequestBytes, protocol.ResultBytes, protocol.DecodeFrame,
}

var (
	_ kit.WorkerCallbacks
	_ host.Handoff
	_ host.ArgumentRule
	_ protocol.ExtraArgument
)
