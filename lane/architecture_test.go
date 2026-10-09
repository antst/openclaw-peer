// SPDX-License-Identifier: MIT

package lane_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepositoryBoundary(t *testing.T) {
	allowed := map[string]bool{
		".github": true, ".gitignore": true, "LICENSE": true, "README.md": true,
		"RELEASE_VERSION": true, "docs": true, "index.js": true, "lane": true,
		"openclaw.plugin.json": true, "package-lock.json": true, "package.json": true,
		"scripts": true, "smoke": true, "src": true, "test": true,
		".git": true, "node_modules": true, ".lane": true,
	}
	entries, err := os.ReadDir("..")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if allowed[name] {
			continue
		}
		if !entry.IsDir() && strings.HasPrefix(name, "openclaw-sessionbus-peer-") && strings.HasSuffix(name, ".tgz") {
			continue
		}
		t.Errorf("unexpected repository root entry: %s", filepath.Join("..", name))
	}
}
