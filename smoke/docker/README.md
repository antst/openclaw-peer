# Local OpenClaw smoke

This checks an OpenClaw Gateway in Docker against the host's Sessionbus daemon.
It uses the published Gateway image, installs this plugin, sends a bus message, and records
whether the model was offered and called the `sessionbus` tool.
The isolated config sets `gateway.mode: local` and `gateway.bind: loopback`; health checks and
CLI probes run inside the container, so the Gateway port is not published.

Prerequisites: Docker Desktop running, the host Sessionbus daemon up, `sessionbus-call` on the
host PATH, and Node and npm on the host. The host daemon socket must be available through
`SESSIONBUS_SOCKET` or its usual `/tmp/sessionbus-<uid>/presence.sock` path.

Run from the repository root:

```sh
smoke/docker/run.sh
```

The runner walks the matrix `2026.8.2` then `2026.9.8` (one compose project, fresh state and a fresh
Gateway per version). `SMOKE_VERSIONS="2026.9.8"` (or `OPENCLAW_VERSION=<release>`) narrows it,
`OPENCLAW_IMAGE=<ref>` pins one specific image.

The two bus agents (`smoke`, `codexsmoke`) run in one of two roster modes, and every clause must pass in both:
`smoke/docker/run.sh` uses `agents.ownership: "explicit"` (no binding for the channel), and
`SMOKE_PEER_OWNERSHIP=marker smoke/docker/run.sh` uses the legacy `default: true` marker, which OpenClaw
materializes into a channel-wide `sessionbus` binding to `smoke`; the plugin's synthetic peer-wildcard binding keeps
`busy-mid-codex` (a message to `codexsmoke`) routed to its own agent. Published images include extra plugins such as `codex` and
`diagnostics-otel`; these checks do not depend on the complete tool list.

The acceptance run defaults to an `npm pack` tgz install and prints `install: tgz <filename>`.
Both runner install paths pass `--accept-capabilities` for the reviewed local plugin; OpenClaw's
non-interactive local install requires explicit capability consent.
For iteration only, `SMOKE_INSTALL=link smoke/docker/run.sh` links the worktree into the
container; that form does not count for A5 acceptance and needs host `node_modules` installed.
`SMOKE_BRIDGE_PORT` can change the local bridge port (default 47911).

## Clauses (per version)

The runner prints `[<version>] <clause>: PASS|FAIL — <evidence>` and exits non-zero when any clause fails.

| clause | what it proves |
|---|---|
| `plugin-loaded`, `tool-offered`, `tool-called` | plugin loaded; `sessionbus` offered in the channel session and called by the mock |
| `idle-wake` | one bus message wakes the idle agent: receipt `queued_for_next_turn`, the model is called, no heartbeat path |
| `busy-mid` | a SLOW run (15 s of ticks), then a second message of the *same sender*: the model sees `INJECT-MARK` before the run's first final (`SAW-INJECT`); a `steer fallback` log line is a FAIL |
| `busy-mid-boundary` | x5: the second message is sent when the mock prints `boundary` (500 ms before the last chunk). Delivered in the same run or as a followup turn = PASS; never delivered = FAIL (lost in the finalization window) |
| `slash-as-text` | `/status`, `/stop`, `text /model x text`, `/smoke-skill inline` and `stop` during a SLOW run reach the model as plain text; the run is not interrupted. Run twice: default config and `commands.allowFrom: {"*":["*"]}` (D23) |
| `busy-mid-codex` | X1: the same BUSY-MID check for agent `codexsmoke`, whose runtime is the **real codex harness** (`codex app-server` from the image) with the model API replaced by `codex-fixture.mjs` (Responses SSE, `SLOW` → native `sleep` tool → `SAW-INJECT`). PASS needs: a request from a codex user agent at the fixture, the native tool active, `INJECT-MARK` reaching the model in the same turn (before the first final); a followup turn after the first final or a `steer fallback` line is a FAIL (no grace on codex) |
| `tg-split` | an `openclaw agent` turn in `agent:smoke:main` runs while the bus SLOW run streams; the bus run is not interrupted |

Helpers: `bus-send.mjs` is a dependency-free bus sender with a stable session id (several messages from the
same sender; `sessionbus-call` picks a new id per call). `mock-model.mjs` logs `mock-model: req n=.. body=<json>`,
`stream n=.. start|end closed=..` and `boundary n=..`; the runner reads them together with the Gateway's
`sessionbus: delivery/reply suppressed` lines in one timestamp-ordered stream.
`SMOKE_AGENT` (default `smoke`) names the agent the clauses talk to.

The channel id is not known to config validation until the plugin is installed, so `channels.sessionbus.enabled`
is set by the runner (`config set`) right after `plugins install`, not in `openclaw.json5`.

On failure it prints the last 200 Gateway and mock-model log lines before cleanup. On exit,
failure, or Ctrl-C it stops the host bridge, runs `docker compose down -v`, and removes
the isolated `.state` directory. The packed tgz stays under ignored `.pkg` for inspection.

## Codex probe (X1 step 1)

`smoke/docker/codex-probe.sh` (= `SMOKE_MODE=probe run.sh`) installs the plugin, starts the fixture and measures
what `CODEX-FIXTURE.md` §7 left open, per version: `probe-a-binary` (managed codex binary, plugin enabled),
`probe-b-config-toml` (the codex process reads `<agentDir>/codex-home/config.toml` and calls the fixture),
`probe-c-no-key` (a `codex/fixture-model` turn completes with no key or profile), `probe-d-steer-shape` (the item
shape of a steered message in the next `/v1/responses` request) and `probe-e-deltas` (whether the fixture needs the
`output_item.added` / `output_text.delta` events; `CODEX_FIXTURE_DELTAS=1`). The Gateway runs on an internal docker network (no route out) with a dummy `OPENAI_API_KEY`, and the probe
starts with `probe-egress`: it proves `api.openai.com` is unreachable and refuses to run a codex turn otherwise, so the
dummy key can only ever reach the fixture. `codex-lib.sh` (shared with the lane smoke) documents, with source
citations, how the real codex app-server is pointed at the fixture (`openai/gpt-5.5` + `appServer.args` `-c openai_base_url=...`).
