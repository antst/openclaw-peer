package main

import (
	"context"
	"fmt"
	"os"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	lane "github.com/imortkz/openclaw-peer/lane"
	"github.com/sessionbus/peer-common/peerversion"
)

const tokenlessDiagnostic = `openclaw-peer (Go) is the Sessionbus lane worker; the interactive openclaw-peer is the OpenClaw plugin. Start a lane with spawn {product:"openclaw-peer"}`

func main() {
	if code := run(); code != 0 {
		os.Exit(code)
	}
}

func run() int {
	if _, report, handled := peerversion.Resolve("openclaw-peer", os.Args[0], os.Args[1:]); handled {
		fmt.Fprintln(os.Stdout, report)
		return 0
	}
	if os.Getenv("SESSIONBUS_LAUNCH_TOKEN") == "" {
		fmt.Fprintln(os.Stderr, tokenlessDiagnostic)
		return 2
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "lane worker arguments belong in session.open")
		return 1
	}
	cfg, bridge, err := lane.LoadConfig(os.Environ())
	if err != nil {
		fmt.Fprintln(os.Stderr, "openclaw-peer:", err)
		return 1
	}
	defer bridge.Close()
	w := lane.New(cfg, bridge)
	worker := kit.NewWorker(w)
	w.SetCaller(worker.Caller())
	bridge.ServeActions(worker.Caller())
	w.SetShutdown(worker.Shutdown)
	defer w.Close(context.Background(), kit.SessionCloseRequest{})
	if err := worker.Serve(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "openclaw-peer:", err)
		return 1
	}
	return 0
}
