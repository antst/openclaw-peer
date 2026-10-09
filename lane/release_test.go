// SPDX-License-Identifier: MIT

package lane_test

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func TestReleaseFilesHoldNoSecrets(t *testing.T) {
	files, err := filepath.Glob("../scripts/*")
	if err != nil {
		t.Fatal(err)
	}
	workflows, err := filepath.Glob("../.github/workflows/*.yml")
	if err != nil {
		t.Fatal(err)
	}
	files = append(files, workflows...)
	if _, err := os.Stat("../.github/workflows/release.yml"); err != nil {
		t.Fatalf("release workflow: %v", err)
	}
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)(ghp_|github_pat_|gho_|sk-|xox[abp]-|AKIA[0-9A-Z]{16}|-----BEGIN)`),
		regexp.MustCompile(`(?i)\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?[A-Za-z0-9_/-]{8,}`),
		regexp.MustCompile(`\b[0-9a-fA-F]{32,}\b`),
		regexp.MustCompile(`\b[A-Za-z0-9+/]{40,}={0,2}\b`),
	}
	actionPin := regexp.MustCompile(`^(\s*-?\s*uses:\s*[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@)[0-9a-f]{40}(\s|$)`)
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(b), "\n") {
			if strings.Contains(line, "github.token") {
				line = strings.ReplaceAll(line, "${{ github.token }}", "")
			}
			if strings.HasPrefix(file, "../.github/workflows/") {
				line = actionPin.ReplaceAllString(line, "$1$2") // a full commit SHA pinning an action is not a secret
			}
			for _, re := range patterns {
				if re.MatchString(line) {
					t.Errorf("%s:%d: secret-like literal: %s", file, i+1, line)
				}
			}
			if strings.HasPrefix(file, "../scripts/") && regexp.MustCompile(`\$\{?[A-Za-z_]*(TOKEN|PASSWORD|SECRET|KEY)[A-Za-z_]*`).MatchString(line) {
				t.Errorf("%s:%d: credential variable reference", file, i+1)
			}
		}
	}
	readme, err := os.ReadFile("../README.md")
	if err != nil {
		t.Fatal(err)
	}
	section := strings.SplitN(string(readme), "## Install\n", 2)
	if len(section) != 2 {
		t.Fatal("README install section missing")
	}
	install := strings.SplitN(section[1], "\n## ", 2)[0]
	if !strings.Contains(install, "scripts/install.sh | sh") || !strings.Contains(install, "OPENCLAW_PEER_VERSION") {
		t.Fatal("README prebuilt install option missing")
	}
	for i, line := range strings.Split(install, "\n") {
		for _, re := range patterns {
			if re.MatchString(line) {
				t.Errorf("README.md Install:%d: secret-like literal", i+1)
			}
		}
	}
}

func TestReleaseWorkflowPublishRerun(t *testing.T) {
	b, err := os.ReadFile("../.github/workflows/release.yml")
	if err != nil {
		t.Fatal(err)
	}
	part := strings.SplitN(string(b), "      - name: Publish release\n", 2)
	if len(part) != 2 {
		t.Fatal("publish step missing")
	}
	block := strings.SplitN(part[1], "        run: |\n", 2)
	if len(block) != 2 {
		t.Fatal("publish step needs a shell block")
	}
	var lines []string
	for _, line := range strings.Split(block[1], "\n") {
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "          ") {
			break
		}
		lines = append(lines, strings.TrimPrefix(line, "          "))
	}
	if len(lines) == 0 {
		t.Fatal("publish shell block empty")
	}
	dir := t.TempDir()
	for _, name := range []string{"openclaw-peer-linux-amd64.tar.gz", "SHA256SUMS"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0755); err != nil {
		t.Fatal(err)
	}
	fake := `#!/bin/sh
echo "$*" >> "$PUBLISH_LOG"
case "$1 $2" in
  'release view') test -f "$RELEASE_STATE";;
  'release create') test ! -f "$RELEASE_STATE" || exit 9; touch "$RELEASE_STATE";;
  'release upload') test -f "$RELEASE_STATE" || exit 8; case "$*" in *--clobber*) ;; *) exit 7;; esac;;
  *) exit 6;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(fake), 0755); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(dir, "calls")
	state := filepath.Join(dir, "release-created")
	for i := 0; i < 2; i++ {
		c := exec.Command("sh", "-c", strings.Join(lines, "\n"))
		c.Dir = dir
		c.Env = append(os.Environ(), "PATH="+bin+":/usr/bin:/bin", "PUBLISH_LOG="+log, "RELEASE_STATE="+state, "GITHUB_REF_NAME=v0.2.0", "GITHUB_REPOSITORY=imortkz/openclaw-peer", "GITHUB_SHA="+versionRevision)
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("publish run %d: %v %s", i+1, err, out)
		}
	}
	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(calls), "release create") != 1 || strings.Count(string(calls), "release upload") != 2 {
		t.Fatalf("publish calls: %s", calls)
	}
}

func installerFixture(t *testing.T, role, member string, extra ...*tar.Header) (string, string) {
	t.Helper()
	dir := t.TempDir()
	asset := "openclaw-peer-" + runtime.GOOS + "-" + runtime.GOARCH + ".tar.gz"
	f, err := os.Create(filepath.Join(dir, asset))
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for name, body := range map[string]string{"ROLE": role + "\n", member: "#!/bin/sh\nprintf installed > \"$INSTALL_MARKER\"\n"} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0755, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(tw, body); err != nil {
			t.Fatal(err)
		}
	}
	for _, h := range extra {
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, asset))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte(fmt.Sprintf("%x  %s\n", sum, asset)), 0644); err != nil {
		t.Fatal(err)
	}
	return dir, asset
}

func runInstaller(t *testing.T, root, marker string, extra ...string) (string, error) {
	t.Helper()
	env := []string{"OPENCLAW_PEER_DOWNLOAD_ROOT=file://" + root, "OPENCLAW_PEER_VERSION=v1.2.3", "INSTALL_MARKER=" + marker}
	env = append(env, extra...)
	return releaseCommand(t, env, "sh", "../scripts/install.sh")
}

func TestInstallerRequiresExactChecksumBeforeInstallation(t *testing.T) {
	root, asset := installerFixture(t, "openclaw", "install")
	marker := filepath.Join(t.TempDir(), "installed")
	good, err := os.ReadFile(filepath.Join(root, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, sums string
		success    bool
	}{
		{"missing", "", false}, {"duplicate", string(good) + string(good), false},
		{"wrong", strings.Repeat("0", 64) + "  " + asset + "\n", false},
		{"malformed", "abc  " + asset + "\n", false}, {"exact", string(good), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os.Remove(marker)
			if err := os.WriteFile(filepath.Join(root, "SHA256SUMS"), []byte(tc.sums), 0644); err != nil {
				t.Fatal(err)
			}
			out, err := runInstaller(t, root, marker)
			if (err == nil) != tc.success {
				t.Fatalf("success=%v: %v %s", tc.success, err, out)
			}
			_, stat := os.Stat(marker)
			if (stat == nil) != tc.success {
				t.Fatalf("install marker: %v", stat)
			}
		})
	}
}

func TestInstallerRejectsUnsafeArchive(t *testing.T) {
	for _, tc := range []struct {
		name, role, member string
		extra              *tar.Header
	}{
		{"traversal", "openclaw", "../install", nil}, {"absolute", "openclaw", "/install", nil}, {"wrong-role", "claude", "install", nil},
		{"symlink", "openclaw", "install", &tar.Header{Name: "lib", Typeflag: tar.TypeSymlink, Linkname: "/bin/true", Mode: 0755}},
		{"hardlink", "openclaw", "install", &tar.Header{Name: "copy", Typeflag: tar.TypeLink, Linkname: "install", Mode: 0755}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var extra []*tar.Header
			if tc.extra != nil {
				extra = append(extra, tc.extra)
			}
			root, _ := installerFixture(t, tc.role, tc.member, extra...)
			marker := filepath.Join(t.TempDir(), "installed")
			out, err := runInstaller(t, root, marker)
			if err == nil {
				t.Fatalf("accepted: %s", out)
			}
			if tc.name != "wrong-role" && !strings.Contains(out, "Unsafe archive member") {
				t.Fatalf("installer did not reject unsafe member itself: %s", out)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("installer ran: %v", err)
			}
		})
	}
}

func TestInstallerSourceSelection(t *testing.T) {
	root, _ := installerFixture(t, "openclaw", "install")
	fake := t.TempDir()
	log := filepath.Join(fake, "calls")
	for name, body := range map[string]string{
		"gh":   "#!/bin/sh\necho gh:$* >> \"$CALL_LOG\"\nif [ \"$1 $2\" = 'auth status' ]; then exit \"${GH_AUTH:-0}\"; fi\n[ \"${GH_FAIL:-0}\" = 0 ] || exit 1\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = --dir ]; then shift; dest=$1; fi; shift; done\ncp \"$FIXTURE_ROOT\"/* \"$dest/\"\n",
		"curl": "#!/bin/sh\necho curl:$* >> \"$CALL_LOG\"\ncase \"$*\" in *releases/latest*) printf '302 https://github.com/imortkz/openclaw-peer/releases/tag/v1.2.3'; exit 0;; esac\nfor arg do case \"$arg\" in */SHA256SUMS|*.tar.gz) file=${arg##*/};; esac; done\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = -o ]; then shift; cp \"$FIXTURE_ROOT/$file\" \"$1\"; exit; fi; shift; done\nexit 1\n",
	} {
		if err := os.WriteFile(filepath.Join(fake, name), []byte(body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	base := []string{"PATH=" + fake + ":/usr/bin:/bin", "FIXTURE_ROOT=" + root, "CALL_LOG=" + log, "INSTALL_MARKER=" + filepath.Join(fake, "installed")}
	run := func(extra ...string) (string, error, string) {
		os.Remove(log)
		env := append(append([]string{}, base...), extra...)
		out, err := releaseCommand(t, env, "sh", "../scripts/install.sh")
		b, _ := os.ReadFile(log)
		return out, err, string(b)
	}
	if out, err, calls := run("OPENCLAW_PEER_DOWNLOAD_ROOT=file://" + root); err != nil || strings.Contains(calls, "gh:") || strings.Contains(calls, "github.com") {
		t.Fatalf("mirror: %v %s %s", err, out, calls)
	}
	if out, err, calls := run("OPENCLAW_PEER_DOWNLOAD_ROOT=", "OPENCLAW_PEER_VERSION=v1.2.3"); err != nil || !strings.Contains(calls, "gh:release download v1.2.3") || !strings.Contains(calls, "--repo imortkz/openclaw-peer") || !strings.Contains(calls, "--pattern SHA256SUMS") || strings.Contains(calls, "curl:") {
		t.Fatalf("gh tag: %v %s %s", err, out, calls)
	}
	if out, err, calls := run("OPENCLAW_PEER_DOWNLOAD_ROOT=", "OPENCLAW_PEER_VERSION=latest"); err != nil || strings.Contains(calls, "gh:release download v") || strings.Contains(calls, "curl:") {
		t.Fatalf("gh latest: %v %s %s", err, out, calls)
	}
	if out, err, calls := run("OPENCLAW_PEER_DOWNLOAD_ROOT=", "OPENCLAW_PEER_VERSION=latest", "GH_AUTH=1"); err != nil || !strings.Contains(calls, "releases/latest") || !strings.Contains(calls, "releases/download/v1.2.3/") {
		t.Fatalf("curl: %v %s %s", err, out, calls)
	}
	if _, err, calls := run("OPENCLAW_PEER_VERSION=bad/tag"); err == nil || calls != "" {
		t.Fatalf("invalid version: %v %s", err, calls)
	}
	os.Remove(filepath.Join(fake, "installed"))
	if out, err, calls := run("OPENCLAW_PEER_DOWNLOAD_ROOT=http://example.invalid/releases"); err == nil || calls != "" {
		t.Fatalf("insecure mirror: %v %s %s", err, out, calls)
	}
	if _, err := os.Stat(filepath.Join(fake, "installed")); !os.IsNotExist(err) {
		t.Fatalf("insecure mirror installed payload: %v", err)
	}
	if out, err, calls := run("OPENCLAW_PEER_DOWNLOAD_ROOT=", "GH_FAIL=1"); err == nil || !strings.Contains(out, "gh release download failed") || strings.Contains(out, "gh auth login") || strings.Contains(calls, "curl:") {
		t.Fatalf("gh failure: %v %s %s", err, out, calls)
	}
}

func releaseCommand(t *testing.T, env []string, name string, args ...string) (string, error) {
	t.Helper()
	c := exec.Command(name, args...)
	c.Env = append(os.Environ(), env...)
	b, err := c.CombinedOutput()
	return string(b), err
}

func packageArchive(t *testing.T) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skip("npm unavailable")
	}
	dir := t.TempDir()
	version, err := os.ReadFile("../RELEASE_VERSION")
	if err != nil {
		t.Fatal(err)
	}
	release := "v" + strings.TrimSpace(string(version))
	out, err := releaseCommand(t, []string{"OPENCLAW_PEER_REVISION=" + versionRevision, "OPENCLAW_PEER_RELEASE=" + release, "npm_config_cache=" + filepath.Join(dir, "cache")}, "sh", "../scripts/package", dir)
	if err != nil {
		t.Fatalf("package: %v: %s", err, out)
	}
	if _, err := os.Stat("../src/build-info.json"); !os.IsNotExist(err) {
		t.Fatalf("scripts/package left src/build-info.json in the source tree: %v", err)
	}
	return filepath.Join(dir, "openclaw-peer-"+runtime.GOOS+"-"+runtime.GOARCH+".tar.gz"), release
}

func TestPackageArchive(t *testing.T) {
	archive, release := packageArchive(t)
	f, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	r := tar.NewReader(gz)
	var names []string
	for {
		h, err := r.Next()
		if err != nil {
			break
		}
		names = append(names, h.Name)
	}
	sort.Strings(names)
	want := []string{"LICENSE", "README.md", "docs/GUIDE.md", "ROLE", "SOURCE.txt", "THIRD-PARTY-NOTICES.txt", "install", "openclaw-peer", "openclaw-sessionbus-peer-" + strings.TrimPrefix(release, "v") + ".tgz"}
	sort.Strings(want)
	if strings.Join(names, "|") != strings.Join(want, "|") {
		t.Fatalf("members: %v want %v", names, want)
	}
	dir := t.TempDir()
	if out, err := releaseCommand(t, nil, "tar", "-xzf", archive, "-C", dir); err != nil {
		t.Fatalf("extract: %v %s", err, out)
	}
	out, err := releaseCommand(t, nil, filepath.Join(dir, "openclaw-peer"), "--version")
	if err != nil || out != "openclaw-peer "+release+" ("+versionRevision+")\n" {
		t.Fatalf("version: %v %q", err, out)
	}
	bad := t.TempDir()
	out, err = releaseCommand(t, []string{"OPENCLAW_PEER_REVISION=" + versionRevision, "OPENCLAW_PEER_RELEASE=v9.9.9"}, "sh", "../scripts/package", bad)
	if err == nil {
		t.Fatalf("mismatched release accepted: %s", out)
	}
	if files, _ := filepath.Glob(filepath.Join(bad, "*.tar.gz")); len(files) != 0 {
		t.Fatalf("unexpected archives: %v", files)
	}
}

func TestArchiveInstallTouchesNoHostProduct(t *testing.T) {
	archive, release := packageArchive(t)
	payload := t.TempDir()
	if out, err := releaseCommand(t, nil, "tar", "-xzf", archive, "-C", payload); err != nil {
		t.Fatalf("extract: %v %s", err, out)
	}
	home := t.TempDir()
	fake := t.TempDir()
	marker := filepath.Join(home, "openclaw-called")
	if err := os.WriteFile(filepath.Join(fake, "openclaw"), []byte("#!/bin/sh\ntouch '"+marker+"'\nexit 97\n"), 0700); err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + home, "PATH=" + fake + ":/usr/bin:/bin:/usr/sbin:/sbin"}
	var first os.FileInfo
	for i := 0; i < 2; i++ {
		pluginName := "openclaw-sessionbus-peer-" + strings.TrimPrefix(release, "v") + ".tgz"
		if i == 1 {
			newName := "openclaw-sessionbus-peer-9.9.9.tgz"
			if err := os.Rename(filepath.Join(payload, pluginName), filepath.Join(payload, newName)); err != nil {
				t.Fatal(err)
			}
			pluginName = newName
		}
		out, err := releaseCommand(t, env, "sh", filepath.Join(payload, "install"))
		if err != nil {
			t.Fatalf("install %d: %v %s", i, err, out)
		}
		root := filepath.Join(home, ".local/libexec/sessionbus/openclaw")
		bin := filepath.Join(root, "openclaw-peer")
		info, err := os.Stat(bin)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = info
		} else if os.SameFile(first, info) {
			t.Fatal("binary inode was not replaced")
		}
		tgz := filepath.Join(root, pluginName)
		if _, err := os.Stat(tgz); err != nil {
			t.Fatal(err)
		}
		plugins, err := filepath.Glob(filepath.Join(root, "openclaw-sessionbus-peer-*.tgz"))
		if err != nil {
			t.Fatal(err)
		}
		if len(plugins) != 1 || plugins[0] != tgz {
			t.Fatalf("installed plugin packages: %v want only %s", plugins, tgz)
		}
		link, err := os.Readlink(filepath.Join(home, ".local/bin/openclaw-peer"))
		if err != nil || link != bin {
			t.Fatalf("symlink %q: %v", link, err)
		}
		if !strings.Contains(out, "openclaw plugins install "+tgz) || !strings.Contains(out, "SESSIONBUS_PRODUCTS") {
			t.Fatalf("missing next steps: %s", out)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("openclaw ran: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".config/sessionbus/service.env")); !os.IsNotExist(err) {
		t.Fatalf("service.env changed: %v", err)
	}
}
