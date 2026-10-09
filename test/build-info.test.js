import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA = "ca426d2025d9aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "build-info-"));
  mkdirSync(path.join(dir, "scripts"));
  mkdirSync(path.join(dir, "src"));
  copyFileSync(path.join(ROOT, "scripts/build-info.mjs"), path.join(dir, "scripts/build-info.mjs"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  return dir;
}

function run(dir, env = {}) {
  const clean = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  delete clean.OPENCLAW_PEER_RELEASE;
  delete clean.OPENCLAW_PEER_REVISION;
  execFileSync(process.execPath, ["scripts/build-info.mjs"], { cwd: dir, env: { ...clean, ...env }, stdio: "pipe" });
  const raw = readFileSync(path.join(dir, "src/build-info.json"), "utf8");
  assert.ok(raw.endsWith("\n"));
  return JSON.parse(raw);
}

test("build-info records release and revision from env, tag or development", () => {
  const dir = fixture();
  try {
    assert.deepEqual(run(dir), { version: "1.2.3", release: "development", revision: "unknown" });
    assert.deepEqual(
      run(dir, { OPENCLAW_PEER_RELEASE: "v1.2.3", OPENCLAW_PEER_REVISION: SHA }),
      { version: "1.2.3", release: "v1.2.3", revision: SHA },
    );

    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x");
    const head = git("rev-parse", "HEAD").toString().trim();
    assert.deepEqual(run(dir), { version: "1.2.3", release: "development", revision: head });
    const tag = (name) => git("-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "-m", "r", name);
    tag("v1.2.3-rc1");
    tag("lane-x");
    assert.deepEqual(run(dir), { version: "1.2.3", release: "development", revision: head });
    tag("v1.2.3");
    assert.deepEqual(run(dir), { version: "1.2.3", release: "v1.2.3", revision: head });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
