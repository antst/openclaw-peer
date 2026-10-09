// SPDX-License-Identifier: MIT

package lane_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const versionRevision = "0123456789abcdef0123456789abcdef01234567"

func buildVersionBinary(t *testing.T, ldflags string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "openclaw-peer")
	args := []string{"build", "-mod=vendor", "-trimpath"}
	if ldflags != "" {
		args = append(args, "-ldflags", ldflags)
	}
	args = append(args, "-o", path, "./cmd/openclaw-peer")
	build := exec.Command("go", args...)
	build.Env = append(os.Environ(), "GOWORK=off")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	return path
}

func TestVersionFlagReportsReleaseWithoutNative(t *testing.T) {
	releaseBytes, err := os.ReadFile("../RELEASE_VERSION")
	if err != nil {
		t.Fatal(err)
	}
	release := strings.TrimSpace(string(releaseBytes))
	ldflags := "-X github.com/sessionbus/peer-common/peerversion.Release=v" + release +
		" -X github.com/sessionbus/peer-common/peerversion.Revision=" + versionRevision
	peer := buildVersionBinary(t, ldflags)
	native := t.TempDir()
	marker := filepath.Join(t.TempDir(), "openclaw-invoked")
	fake := "#!/bin/sh\nprintf invoked > \"$PEER_NATIVE_MARKER\"\nexit 97\n"
	if err := os.WriteFile(filepath.Join(native, "openclaw"), []byte(fake), 0o700); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(peer, "--version")
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "SESSIONBUS_LAUNCH_TOKEN=") && !strings.HasPrefix(entry, "PATH=") {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "PATH="+native, "PEER_NATIVE_MARKER="+marker)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("--version: %v\n%s", err, output)
	}
	want := "openclaw-peer v" + release + " (" + versionRevision + ")\n"
	if string(output) != want {
		t.Fatalf("output=%q want=%q", output, want)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("openclaw was invoked: %v", err)
	}
}

func TestVersionFlagDevelopmentBuild(t *testing.T) {
	peer := buildVersionBinary(t, "")
	command := exec.Command(peer, "--version")
	command.Env = append(os.Environ(), "SESSIONBUS_LAUNCH_TOKEN=")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("--version: %v\n%s", err, output)
	}
	if !strings.HasPrefix(string(output), "openclaw-peer development (") || !strings.HasSuffix(string(output), ")\n") {
		t.Fatalf("unexpected development version: %q", output)
	}
}

func TestReleaseVersionMatchesPluginPackage(t *testing.T) {
	releaseBytes, err := os.ReadFile("../RELEASE_VERSION")
	if err != nil {
		t.Fatal(err)
	}
	release := strings.TrimSpace(string(releaseBytes))
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(release) {
		t.Fatalf("invalid release version %q", release)
	}
	packageBytes, err := os.ReadFile("../package.json")
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(packageBytes, &pkg); err != nil {
		t.Fatal(err)
	}
	if release != pkg.Version {
		t.Fatalf("RELEASE_VERSION=%q package.json version=%q", release, pkg.Version)
	}
}
