// SPDX-License-Identifier: MIT
// Writes src/build-info.json (run by `npm pack` via prepack): which build of the plugin this package is.
// `--clean` (postpack) removes it again, so a source checkout never carries a stale build record.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.env.OPENCLAW_PEER_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const buildFile = path.join(root, "src", "build-info.json");
if (process.argv.includes("--clean")) {
  rmSync(buildFile, { force: true });
  process.exit(0);
}

const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const release = process.env.OPENCLAW_PEER_RELEASE
  || git("tag", "--points-at", "HEAD").split("\n").find((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  || "development";
const revision = process.env.OPENCLAW_PEER_REVISION || git("rev-parse", "HEAD") || "unknown";

writeFileSync(buildFile, `${JSON.stringify({ version, release, revision })}\n`);
