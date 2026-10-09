#!/usr/bin/env bash
# X1 step 1, run by master in docker before the codex clauses: measures the open items of CODEX-FIXTURE.md §7 on the
# real images (2026.8.2 and 2026.9.8): (a) the codex binary + plugin, (b) config.toml in <agentDir>/codex-home is
# picked up, (c) a codex/<model> turn starts and completes with no key, (d) the shape of a steered message in the
# next /v1/responses request, (e) whether the fixture needs the delta events. Prints `[<version>] probe-*: PASS|FAIL`.
#   smoke/docker/codex-probe.sh                       # both versions
#   SMOKE_VERSIONS=2026.9.8 smoke/docker/codex-probe.sh
# The Gateway is on an internal docker network (no route out) with a dummy OPENAI_API_KEY; the probe first proves
# api.openai.com is unreachable (probe-egress) and refuses to run a codex turn otherwise.
set -euo pipefail
cd "$(dirname "$0")/../.."
SMOKE_MODE=probe exec smoke/docker/run.sh "$@"
