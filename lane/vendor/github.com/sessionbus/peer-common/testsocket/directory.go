// SPDX-License-Identifier: MIT

// Package testsocket provides short, production-shaped socket directories for tests.
package testsocket

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// Directory returns a private test directory below the selected Sessionbus runtime root.
func Directory(t testing.TB) string {
	t.Helper()
	root := os.Getenv("XDG_RUNTIME_DIR")
	if root != "" {
		root = filepath.Join(root, "sessionbus")
	} else {
		root = filepath.Join("/tmp", "sessionbus-"+strconv.Itoa(os.Getuid()))
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	directory, err := os.MkdirTemp(root, "test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(directory); err != nil {
			t.Errorf("remove socket directory: %v", err)
		}
	})
	physical, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	return physical
}
