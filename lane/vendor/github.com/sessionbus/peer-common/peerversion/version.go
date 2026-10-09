// SPDX-License-Identifier: MIT

// Package peerversion owns the public peer-command version boundary.
package peerversion

import (
	"fmt"
	"path/filepath"
	"runtime/debug"
)

// Release and Revision are populated by release builds through Go linker
// values. Source builds retain an explicit development label and use Go's VCS
// build information when available.
var (
	Release  = "development"
	Revision string
)

// Resolve handles only the canonical public command. Private MCP, broker,
// hook, and installer aliases retain their closed argument surfaces.
func Resolve(command, invoked string, arguments []string) (resolved []string, report string, handled bool) {
	if filepath.Base(invoked) != command || len(arguments) != 1 {
		return arguments, "", false
	}
	switch arguments[0] {
	case "--version":
		return nil, String(command), true
	case "--native-version":
		return []string{"--version"}, "", false
	}
	if arguments[0] == shortFlag(command) {
		return nil, String(command), true
	}
	return arguments, "", false
}

// String returns the stable human-readable peer release identity.
func String(command string) string {
	release := Release
	if release == "" {
		release = "development"
	}
	revision := Revision
	if revision == "" {
		revision = buildRevision()
	}
	if revision == "" {
		revision = "unknown"
	}
	return fmt.Sprintf("%s %s (%s)", command, release, revision)
}

func buildRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, setting := range info.Settings {
		if setting.Key == "vcs.revision" {
			return setting.Value
		}
	}
	return ""
}

func shortFlag(command string) string {
	if command == "codex-peer" {
		return "-V"
	}
	switch command {
	case "claude-peer", "grok-peer", "kilo-peer", "omp-peer", "opencode-peer", "pi-peer", "qwen-peer":
		return "-v"
	default:
		return ""
	}
}
