#!/usr/bin/env bash
# Peer smoke on the OpenClaw Docker matrix (8.2 and 9.8): bus message -> `sessionbus` channel turn.
# Clauses per version: plugin-loaded, tool-offered, idle-wake, tool-called, busy-mid, busy-mid-boundary (x5),
# slash-as-text (x2: default config and commands.allowFrom["*"]), tg-split. See smoke/docker/README.md.
set -euo pipefail

cd "$(dirname "$0")/../.."
SMOKE_INSTALL="${SMOKE_INSTALL:-tgz}"
SMOKE_BRIDGE_PORT="${SMOKE_BRIDGE_PORT:-47911}"
export SMOKE_BRIDGE_PORT
# Versions: SMOKE_VERSIONS, else OPENCLAW_VERSION, else the 8.2 + 9.8 matrix. OPENCLAW_IMAGE pins one image.
caller_image="${OPENCLAW_IMAGE:-}"
if [[ -n "$caller_image" ]]; then
  versions=("${OPENCLAW_VERSION:-custom-image}")
else
  read -r -a versions <<<"${SMOKE_VERSIONS:-${OPENCLAW_VERSION:-2026.8.2 2026.9.8}}"
fi
# The agent the clauses talk to (extension point for the codex stream).
AGENT="${SMOKE_AGENT:-smoke}"
SENDER_ID="${SMOKE_SENDER_ID:-smoke-sender}"
BUSY_GROUP=oc-smoke

bridge_pid=""
pack_dir=""
overall=0
version=""
compose=()
snapfile=$(mktemp)
state_probe_out=$(mktemp)
clause_base=0

saw_probe_fail=0
say() {
  printf '%s\n' "$*"
  [[ "$*" == *" probe-"*": FAIL"* ]] && saw_probe_fail=1
  return 0
}
result() { # result <clause> <PASS|FAIL> <evidence>
  say "[$version] $1: $2 — $3"
  [[ "$2" == PASS ]] || overall=1
  # A failed codex/probe line carries its own evidence (the logs are gone once the version is torn down).
  if [[ "$2" == FAIL && ( "$1" == *codex* || "$1" == probe* ) && -n "${compose[*]:-}" ]]; then dump_evidence "$1"; fi
}

# Ids of the bus messages of the clause under way (set by the codex clauses and probe-d), for dump_evidence.
evidence_ids=()
# dump_evidence <label>: what the Gateway, the plugin, the fixture and the mock saw — receipts' ids in the Gateway log,
# the channel session the dispatch went to, whether the model call reached the fixture or the mock, the agent's sessions.
dump_evidence() {
  local id agent=${AGENT:-codexsmoke}
  snap || true
  say "[$version]   evidence($1): message ids: ${evidence_ids[*]:-none}; peer: ${peer_id:-none}"
  for id in "${evidence_ids[@]:-}"; do
    [[ -n "$id" ]] || continue
    say "[$version]   gateway lines mentioning $id:"
    grep -F -- "$id" "$snapfile" | cut -c1-300 | tail -8 | sed 's/^/      /' || true
  done
  say "[$version]   sessionbus lines (last 12):"
  grep -E 'sessionbus' "$snapfile" | cut -c1-300 | tail -12 | sed 's/^/      /' || true
  say "[$version]   fixture lines (last 10, bodies omitted):"
  grep 'codex-fixture:' "$snapfile" | grep -v 'body n=' | cut -c1-260 | tail -10 | sed 's/^/      /' || true
  say "[$version]   mock lines (last 6):"
  grep 'mock-model: req n=' "$snapfile" | cut -c1-220 | tail -6 | sed 's/^/      /' || true
  say "[$version]   sessions of $agent: $("${compose[@]}" exec -T openclaw-gateway node openclaw.mjs sessions --agent "$agent" --json 2>&1 | head -c 1500 | tr '\n' ' ')"
  say "[$version]   agents.entries.$agent: $("${compose[@]}" exec -T openclaw-gateway node openclaw.mjs config get "agents.entries.$agent" --json 2>&1 | tail -n 12 | tr '\n' ' ' | cut -c1-600)"
  say "[$version]   channels.sessionbus: $("${compose[@]}" exec -T openclaw-gateway node openclaw.mjs config get channels.sessionbus --json 2>&1 | tail -n 3 | tr '\n' ' ')"
}

teardown_version() {
  if [[ -n "$bridge_pid" ]]; then
    kill "$bridge_pid" 2>/dev/null || true
    wait "$bridge_pid" 2>/dev/null || true
    bridge_pid=""
  fi
  if (( ${#compose[@]} )); then "${compose[@]}" down -v >/dev/null 2>&1 || true; fi
  rm -rf smoke/docker/.state
}

cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 || overall != 0 )) && (( ${#compose[@]} )); then
    echo "gateway logs (last 200 lines):" >&2
    "${compose[@]}" logs --no-color --tail 200 openclaw-gateway >&2 || true
    echo "mock-model logs (last 200 lines):" >&2
    "${compose[@]}" logs --no-color --tail 200 mock-model >&2 || true
  fi
  teardown_version
  if [[ -n "$pack_dir" ]]; then rm -rf "$pack_dir"; fi
  rm -f "$snapfile" "$state_probe_out"
  (( status != 0 )) && exit "$status"
  exit "$overall"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

case "$SMOKE_INSTALL" in
  tgz|link) ;;
  *) echo "SMOKE_INSTALL must be tgz or link" >&2; exit 2 ;;
esac
if ! [[ "$SMOKE_BRIDGE_PORT" =~ ^[0-9]+$ ]] || (( SMOKE_BRIDGE_PORT < 1 || SMOKE_BRIDGE_PORT > 65535 )); then
  echo "SMOKE_BRIDGE_PORT must be 1..65535" >&2
  exit 2
fi
if lsof -nP -iTCP:"$SMOKE_BRIDGE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "bridge port $SMOKE_BRIDGE_PORT is already bound" >&2
  exit 2
fi

# shellcheck source=smoke/docker/codex-lib.sh
source smoke/docker/codex-lib.sh

# ---------------------------------------------------------------- codex probe (SMOKE_MODE=probe, see codex-probe.sh)
# X1 step 1: the facts CODEX-FIXTURE.md §7 leaves open, measured in the real image against the fixture.
fixture_log() { "${compose[@]}" logs --no-color codex-fixture 2>&1; }
gw() { "${compose[@]}" exec -T openclaw-gateway "$@"; }
agent_turn() { # agent_turn <session> <message> [timeout s]
  gw timeout "${3:-120}" node openclaw.mjs agent --agent codexsmoke --session-key "agent:codexsmoke:$1" --message "$2" --json 2>&1
}
probe_codex() {
  local bins out turn_out n_before n_after reply status
  # (0) hermeticity first: nothing may leave the Gateway container, or a dummy key could reach the real API.
  if egress_blocked; then
    say "[$version] probe-egress: PASS — api.openai.com is unreachable from the Gateway (internal network); only the mock and the fixture are reachable"
  else
    say "[$version] probe-egress: FAIL — the Gateway container can reach api.openai.com; refusing to run any codex turn"
    overall=1
    return
  fi
  # (a) the codex binary the plugin manages, and that the plugin is enabled
  bins=$(gw sh -c 'find / -path "*@openai/codex*" -name codex -type f 2>/dev/null | head -3; openclaw plugins list 2>&1 | grep -i codex; openclaw doctor --lint --only codex/managed-app-server --json 2>&1 | head -c 400' 2>&1 | tr '\n' '|')
  say "[$version] probe-a-binary: $bins"

  # (b) config.toml in <agentDir>/codex-home is picked up, (c) a turn starts and completes without any key
  write_codex_home codexsmoke
  n_before=$(fixture_log | grep -c 'codex-fixture: req n=' || true)
  turn_out=$(agent_turn probe-1 "PROBE hello" 150) && status=0 || status=$?
  n_after=$(fixture_log | grep -c 'codex-fixture: req n=' || true)
  reply=$(jq -r '[.result.payloads[]?.text] | join(" ")' <<<"$turn_out" 2>/dev/null || true)
  if (( n_after > n_before )); then
    say "[$version] probe-b-config-toml: PASS — the codex process called the fixture ($((n_after - n_before)) request(s)); ua: $(fixture_log | grep -m1 'codex-fixture: req n=' | cut -c1-200)"
  else
    say "[$version] probe-b-config-toml: FAIL — no request reached the fixture; agent exit=$status out: $(printf '%s' "$turn_out" | head -c 500)"
    say "[$version] probe-b-diagnosis: $(printf '%s' "$turn_out" | grep -o -E 'Unknown model[^"]*|unexpected status [0-9]+[^,]*|api\.openai\.com' | head -2 | tr '\n' ' ') | gateway: $("${compose[@]}" logs --no-color openclaw-gateway 2>&1 | grep -i -E 'codex|app-server' | tail -4 | cut -c1-220 | tr '\n' '|')"
    overall=1
    return
  fi
  if (( status == 0 )) && [[ "$reply" == *ECHO* ]]; then
    say "[$version] probe-c-no-key: PASS — the turn started and completed with no key/profile; reply: ${reply:0:100}; deltas needed: no (minimal Responses events sufficed)"
    say "[$version] probe-e-deltas: not needed"
  else
    say "[$version] probe-c-no-key: FAIL — exit=$status reply='${reply:0:100}' out: $(printf '%s' "$turn_out" | head -c 400); gateway: $("${compose[@]}" logs --no-color openclaw-gateway 2>&1 | grep -i -E 'codex|auth|key' | tail -3 | cut -c1-200 | tr '\n' '|')"
    overall=1
    # (e) retry with the delta events: does the turn then complete?
    CODEX_FIXTURE_DELTAS=1 "${compose[@]}" up -d --force-recreate codex-fixture >/dev/null 2>&1
    sleep 2
    turn_out=$(agent_turn probe-2 "PROBE hello again" 150) && status=0 || status=$?
    reply=$(jq -r '[.result.payloads[]?.text] | join(" ")' <<<"$turn_out" 2>/dev/null || true)
    if (( status == 0 )) && [[ "$reply" == *ECHO* ]]; then say "[$version] probe-e-deltas: NEEDED — the turn completes only with output_item.added / output_text.delta events (set CODEX_FIXTURE_DELTAS=1 in compose)"; else say "[$version] probe-e-deltas: still failing with deltas: exit=$status out: $(printf '%s' "$turn_out" | head -c 300)"; fi
    return
  fi

  # (d) BUSY-MID on the REAL path: the sessionbus channel dispatch of the codexsmoke peer. The CLI `openclaw agent`
  # path is NOT ours: a second CLI message to a busy session queues behind the run as a followup ("lane wait exceeded …
  # activeAhead=1" in the Gateway log) — it measures the CLI lane, not the channel's steer. So: a bus message to the
  # peer starts the SLOW codex turn, a second bus message from the same sender arrives while the native tool runs.
  local saved_agent=$AGENT saved_peer=${peer_id:-}
  AGENT=codexsmoke
  if ! find_peer; then
    say "[$version] probe-d-steer-shape: FAIL — openclaw-codexsmoke peer not visible on the bus (host daemon, group $BUSY_GROUP)"
    overall=1
    AGENT=$saved_agent; peer_id=$saved_peer
    return
  fi
  mark
  local r1 r1id tool inject final shape body turn
  r1=$(sender "msg=SLOW probe-steer") || { say "[$version] probe-d-steer-shape: FAIL — bus send failed"; overall=1; AGENT=$saved_agent; peer_id=$saved_peer; return; }
  r1id=$(jq -r '.message_id' <<<"$r1" 2>/dev/null || true)
  evidence_ids=("$r1id")
  say "[$version] probe-d: SLOW bus message $r1id to $peer_id, receipt: $(printf '%s' "$r1" | head -c 300)"
  tool=$(wait_line 'codex-fixture: tool-call n=[0-9]+' 120) || tool=""
  if [[ -z "$tool" ]]; then
    say "[$version] probe-d-steer-shape: FAIL — the SLOW bus message never produced a native tool call at the fixture (not routed to the codex harness?)"
    overall=1
    AGENT=$saved_agent; peer_id=$saved_peer
    return
  fi
  sleep 3
  local r2
  r2=$(sender "msg=INJECT-MARK probe-steer") || true
  evidence_ids+=("$(jq -r '.message_id' <<<"$r2" 2>/dev/null || true)")
  say "[$version] probe-d: INJECT-MARK bus message receipt: $(printf '%s' "$r2" | head -c 300)"
  inject=$(wait_line 'codex-fixture: req .*sawInject=true' 90) || inject=""
  final=$(wait_line "sessionbus: reply suppressed $(ere_escape "${r1id:-none}") kind=final" 60) || final=""
  snap
  inject=$(line_of 'codex-fixture: req .*sawInject=true')
  final=$(line_of "sessionbus: reply suppressed $(ere_escape "${r1id:-none}") kind=final")
  turn=$(text_at "${inject:-1}" | grep -o 'turn=[a-z]*' || true)
  body=$(tail -n +"$((clause_base + 1))" "$snapfile" | grep 'codex-fixture: body n=' | grep 'INJECT-MARK probe-steer' | head -1 | sed -E 's/^[^{]*//' || true)
  shape=$(jq -c '[.input[]? | select(tostring | contains("INJECT-MARK")) | {type, role, content: (.content // null | if type=="array" then map(.type) else . end)}]' <<<"${body:-null}" 2>/dev/null || true)
  if [[ -z "$inject" ]]; then
    say "[$version] probe-d-steer-shape: FAIL — INJECT-MARK never reached the fixture (lost); r1 final line #${final:-none}"
    overall=1
  elif [[ "$turn" == "turn=same" ]]; then
    say "[$version] probe-d-steer-shape: PASS — the second bus message was steered into the running codex turn ($turn). item shape(s): ${shape:-unparsed}; request: $(text_at "$inject"); SLOW final line #${final:-none}, INJECT request line #$inject"
  else
    say "[$version] probe-d-steer-shape: FAIL — the second bus message did NOT join the running codex turn ($turn: it ran as a followup after the first final). item shape(s): ${shape:-unparsed}; request: $(text_at "$inject"); SLOW final line #${final:-none}, INJECT request line #$inject"
    overall=1
  fi
  AGENT=$saved_agent; peer_id=$saved_peer

}

# cfg_json: the JSON value at the end of a CLI output that may carry warning lines before it and spans several lines
# (`openclaw config get <path> --json`). Prints it compactly, or nothing when no suffix of the output parses.
cfg_json() {
  node -e 'const lines=require("node:fs").readFileSync(0,"utf8").split("\n");for(let i=0;i<lines.length;i++){const t=lines.slice(i).join("\n").trim();if(!t)continue;try{process.stdout.write(JSON.stringify(JSON.parse(t)));process.exit(0)}catch{}}process.exit(1)'
}

# ---------------------------------------------------------------- log helpers
# snap: gateway + mock logs of this compose project, one chronological stream (docker timestamps), in $snapfile.
snap() {
  "${compose[@]}" logs -t --no-color openclaw-gateway mock-model codex-fixture 2>&1 | sed -E 's/^[^|]*\| *//' | sort -s -k1,1 >"$snapfile" || true
}
mark() { snap; clause_base=$(wc -l <"$snapfile" | tr -d ' '); }
# line_of <ERE>: 1-based line (after the clause mark) of the first match in the current snapshot, empty if none.
line_of() { tail -n +"$((clause_base + 1))" "$snapfile" | grep -n -m1 -E -- "$1" | cut -d: -f1 || true; }
# line_after <N> <ERE>: like line_of, but only lines after relative line N (the first match following it).
line_after() {
  local n
  n=$(tail -n +"$((clause_base + $1 + 1))" "$snapfile" | grep -n -m1 -E -- "$2" | cut -d: -f1 || true)
  [[ -n "$n" ]] && printf '%s' "$(($1 + n))"
  return 0
}
# wait_line <ERE> <seconds>: refresh until the pattern shows up; prints its line number.
wait_line() {
  local pattern=$1 limit=$2 deadline n
  deadline=$((SECONDS + limit))
  while (( SECONDS < deadline )); do
    snap
    n=$(line_of "$pattern")
    if [[ -n "$n" ]]; then printf '%s' "$n"; return 0; fi
    sleep 1
  done
  return 1
}
text_at() { tail -n +"$((clause_base + 1))" "$snapfile" | sed -n "${1}p" | cut -c1-220; }

sender() { node smoke/docker/bus-send.mjs --id "$SENDER_ID" --group "$BUSY_GROUP" --target "$peer_id" "$@"; }
# Same-sender helper: quote-free message tokens only.
send_msg() { sender "msg=$1" >/dev/null; }
mock_body() { printf 'body=%s' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1")"; }
ere_escape() { printf '%s' "$1" | sed -E 's/[][\.^$*+?(){}|]/\\&/g'; }

wait_gateway() {
  local deadline=$((SECONDS + 120))
  until "${compose[@]}" exec -T openclaw-gateway node dist/docker-healthcheck.js >/dev/null 2>&1; do
    (( SECONDS < deadline )) || { echo "gateway healthcheck timed out" >&2; return 1; }
    sleep 2
  done
}

find_peer() {
  local listing deadline=$((SECONDS + 120))
  peer_id=""
  while [[ -z "$peer_id" ]]; do
    listing=$(sessionbus-call -g "$BUSY_GROUP" session.list '{}')
    peer_id=$(AGENT="$AGENT" node -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const row=v.sessions?.find(x=>x.product==="openclaw-peer" && x.session_id?.startsWith(`openclaw-${process.env.AGENT}@`)); if(row) process.stdout.write(row.session_id)' <<<"$listing")
    [[ -n "$peer_id" ]] && break
    (( SECONDS < deadline )) || { echo "openclaw-$AGENT peer not visible" >&2; return 1; }
    sleep 2
  done
}

# ---------------------------------------------------------------- clauses
clause_idle_wake_and_tool() {
  mark
  local receipt mid text="Smoke check: call sessionbus list, then finish."
  receipt=$(sender "msg=$text")
  jq -e 'any(.deliveries[]?; .disposition=="queued_for_next_turn")' <<<"$receipt" >/dev/null \
    || { result idle-wake FAIL "no queued_for_next_turn receipt: $receipt"; return; }
  mid=$(jq -r '.message_id' <<<"$receipt")
  local body_re offered wake called final
  body_re="body=\"$(ere_escape "$text")\""
  # Every line below is tied to THIS message: the gateway's delivery line carries its id, the mock request carries its
  # text and the tool in the same line, and the channel's own `deliver` logs `reply suppressed <id> kind=final` (only a
  # channel dispatch for exactly this message writes it — a heartbeat or main-session turn cannot).
  final=$(wait_line "sessionbus: reply suppressed $(ere_escape "$mid") kind=final" 90) || final=""
  snap
  wake=$(line_of "sessionbus: delivery $(ere_escape "$mid") from .*queued_for_next_turn")
  offered=$(line_of "mock-model: req n=[0-9]+ .*$body_re tools=sessionbus")
  called=$(line_of "mock-model: tool-result n=[0-9]+ $body_re")
  [[ -n "$offered" ]] && result tool-offered PASS "sessionbus offered on the request carrying this message: $(text_at "$offered")" || result tool-offered FAIL "no model request carried this message text together with the sessionbus tool (message $mid)"
  # No other turn may have called the model between the mark and the final: a heartbeat or main-session turn would add
  # a request whose text is not this message.
  local stray
  stray=$(tail -n +"$((clause_base + 1))" "$snapfile" | head -n "${final:-0}" | grep -E 'mock-model: req n=' | grep -v -E -- "$body_re" | head -1 | cut -c1-200 || true)
  if [[ -n "$wake" && -n "$final" && -z "$stray" ]]; then
    result idle-wake PASS "message $mid: receipt queued_for_next_turn, delivery line, one channel turn ended with reply suppressed (line #$final), no other model request in the window: $(text_at "$wake")"
  else
    result idle-wake FAIL "message $mid: delivery line='${wake:+yes}' final(reply suppressed)='${final:+line $final}' stray request='${stray}'"
  fi
  [[ -n "$called" ]] && result tool-called PASS "tool result returned for this message's chain: $(text_at "$called")" || result tool-called FAIL "no tool-result request for this message's chain (message $mid)"
  sleep 4
}

# busy-mid: SLOW run, a second message of the same sender mid-run; the model must see it before the run's final.
clause_busy_mid() {
  mark
  local r1 r2 r1id r2id start inject final
  r1=$(sender "msg=SLOW busy-mid") || { result busy-mid FAIL "first send failed"; return; }
  r1id=$(jq -r '.message_id' <<<"$r1")
  start=$(wait_line 'mock-model: stream n=[0-9]+ start' 60) || { result busy-mid FAIL "SLOW run never started (no stream start)"; return; }
  sleep 3
  r2=$(sender "msg=INJECT-MARK busy-mid") || { result busy-mid FAIL "second send failed"; return; }
  r2id=$(jq -r '.message_id' <<<"$r2")
  inject=$(wait_line 'mock-model: req .*sawInject=true body="INJECT-MARK busy-mid"' 60) || inject=""
  # The terminal of the SLOW run is the channel's `reply suppressed <r1> kind=final`, not any message's.
  final=$(wait_line "sessionbus: reply suppressed $(ere_escape "$r1id") kind=final" 60) || final=""
  snap
  inject=$(line_of 'mock-model: req .*sawInject=true body="INJECT-MARK busy-mid"')
  final=$(line_of "sessionbus: reply suppressed $(ere_escape "$r1id") kind=final")
  local fallback r2final
  fallback=$(line_of 'steer fallback')
  r2final=$(line_of "sessionbus: reply suppressed $(ere_escape "$r2id") kind=final")
  local evidence="ids: $r1id / $r2id; receipts: $(jq -rc '[.deliveries[]?.disposition]' <<<"$r1") $(jq -rc '[.deliveries[]?.disposition]' <<<"$r2"); active work: $(text_at "$start"); reaction: ${inject:+$(text_at "$inject")}; r1 final (reply suppressed) line #${final:-none}, r2 final line #${r2final:-none}, INJECT req line #${inject:-none}"
  if [[ -z "$inject" ]]; then
    result busy-mid FAIL "model never saw INJECT-MARK. $evidence"
  elif [[ -z "$final" ]]; then
    result busy-mid FAIL "no terminal (reply suppressed kind=final) for the SLOW message $r1id within 60 s. $evidence"
  elif [[ "$inject" -lt "$final" ]]; then
    result busy-mid PASS "same run: INJECT-MARK reached the model before the SLOW run's own final. $evidence"
  else
    result busy-mid FAIL "INJECT-MARK arrived only after the SLOW run's final (separate followup turn). $evidence"
  fi
  [[ -z "$fallback" ]] || result busy-mid FAIL "steer fallback line present: $(text_at "$fallback")"
  sleep 4
}

# busy-mid-boundary: INJECT-MARK sent when the mock prints the boundary line (500 ms before the last chunk).
# Either the same run or a followup turn within 10 s of the end is accepted; no delivery at all is the loss window.
clause_busy_mid_boundary() {
  local i ok=0 modes=()
  for i in 1 2 3 4 5; do
    mark
    local r1 r1id seen final mode
    r1=$(sender "msg=SLOW boundary-$i") || { result "busy-mid-boundary #$i" FAIL "send failed"; continue; }
    r1id=$(jq -r '.message_id' <<<"$r1")
    if ! wait_line 'mock-model: boundary n=[0-9]+' 60 >/dev/null; then
      result "busy-mid-boundary #$i" FAIL "no boundary marker from the mock"
      continue
    fi
    sender "msg=INJECT-MARK boundary-$i" >/dev/null
    seen=$(wait_line "mock-model: req .*sawInject=true body=\"INJECT-MARK boundary-$i\"" 40) || seen=""
    final=$(wait_line "sessionbus: reply suppressed $(ere_escape "$r1id") kind=final" 40) || final=""
    snap
    if [[ -z "$seen" ]]; then
      result "busy-mid-boundary #$i" FAIL "INJECT-MARK never reached the model (message lost in the finalization window)"
    elif [[ -z "$final" ]]; then
      result "busy-mid-boundary #$i" FAIL "no terminal (reply suppressed kind=final) for the SLOW message $r1id within 40 s"
    else
      seen=$(line_of "mock-model: req .*sawInject=true body=\"INJECT-MARK boundary-$i\"")
      final=$(line_of "sessionbus: reply suppressed $(ere_escape "$r1id") kind=final")
      if [[ "$seen" -lt "$final" ]]; then mode=same-run; else mode=followup-after-end_turn; fi
      modes+=("$mode")
      ok=$((ok + 1))
      result "busy-mid-boundary #$i" PASS "$mode (INJECT req line #$seen, SLOW final line #$final): $(text_at "$seen")"
    fi
    sleep 8 # let the followup (if any) finish before the next iteration
  done
  if (( ok == 5 )); then result busy-mid-boundary PASS "5/5 delivered (${modes[*]})"; else result busy-mid-boundary FAIL "$ok/5 delivered"; fi
}

clause_slash_as_text() { # clause_slash_as_text <label>
  local label=$1 text n
  mark
  for text in "/status" "/stop" "text /model x text" "/smoke-skill inline"; do
    send_msg "$text"
    if n=$(wait_line "mock-model: req .*$(ere_escape "$(mock_body "$text")")" 60); then
      result "$label" PASS "reached the model as text: $(text_at "$n")"
    else
      result "$label" FAIL "text '$text' never reached the model (executed or swallowed as a command)"
    fi
    sleep 3
  done
  # `stop` while a turn is running must not interrupt it.
  mark
  send_msg "SLOW $label"
  wait_line 'mock-model: stream n=[0-9]+ start' 60 >/dev/null || { result "$label" FAIL "SLOW run did not start"; return; }
  sleep 3
  send_msg "stop"
  local stopline endline
  stopline=$(wait_line "mock-model: req .*$(ere_escape "$(mock_body stop)")" 60) || stopline=""
  endline=$(wait_line 'mock-model: stream n=[0-9]+ end closed=' 40) || endline=""
  if [[ -n "$stopline" && -n "$endline" ]] && grep -q 'end closed=false' <<<"$(text_at "$endline")"; then
    result "$label" PASS "'stop' reached the model as text and the SLOW run was not interrupted: $(text_at "$endline")"
  else
    result "$label" FAIL "stop line='${stopline}' stream end='$(text_at "${endline:-1}")'"
  fi
  sleep 4
}

# busy-mid-codex (X1): the same BUSY-MID check on an agent whose runtime is the REAL codex harness, with the model
# behind it replaced by codex-fixture. The codex app-server must ask the fixture for a native tool (sleep), the second
# message must reach the model in the SAME turn (SAW-INJECT after the tool output, before the first final), and the
# steer fallback (a followup turn after the first final) is a FAIL — no grace window on codex.
clause_busy_mid_codex() {
  local saved_agent=$AGENT saved_peer=${peer_id:-}
  AGENT=codexsmoke
  if ! find_peer; then
    result busy-mid-codex FAIL "openclaw-codexsmoke peer not visible"
    AGENT=$saved_agent; peer_id=$saved_peer
    return
  fi
  local r1 r2 r1id r2id toolcall inject followup final fallback ua harness
  if ! egress_blocked; then
    result busy-mid-codex FAIL "the Gateway container can reach the internet; refusing to run a codex turn (dummy key must only ever reach the fixture)"
    AGENT=$saved_agent; peer_id=$saved_peer
    return
  fi
  write_codex_home codexsmoke
  mark
  r1=$(sender "msg=SLOW busy-mid-codex") || { result busy-mid-codex FAIL "first send failed"; AGENT=$saved_agent; peer_id=$saved_peer; return; }
  r1id=$(jq -r '.message_id' <<<"$r1")
  evidence_ids=("$r1id")
  say "[$version] busy-mid-codex: SLOW bus message $r1id to $peer_id, receipt: $(printf '%s' "$r1" | head -c 300)"
  toolcall=$(wait_line 'codex-fixture: tool-call n=[0-9]+' 120) || toolcall=""
  if [[ -z "$toolcall" ]]; then
    result busy-mid-codex FAIL "codex never asked the fixture for the native tool: the turn did not reach the codex harness or the fixture. fixture lines: $(grep -c 'codex-fixture:' "$snapfile") gateway codex lines: $(grep -i -m3 'codex' "$snapfile" | cut -c1-200 | tr '\n' '|')"
    AGENT=$saved_agent; peer_id=$saved_peer
    return
  fi
  sleep 3
  r2=$(sender "msg=INJECT-MARK busy-mid-codex")
  r2id=$(jq -r '.message_id' <<<"$r2")
  evidence_ids+=("$r2id")
  # The terminal of the SLOW turn. The codex harness delivers no final text to the channel (deliveryDefaults.visibleReplies
  # = "message_tool": extensions/codex/harness.ts:114-116 on 8.2, :143-145 on 9.8), so there is no `reply suppressed` for
  # it; the turn's end is OpenClaw's own `[turn/execution] ... channel=sessionbus ... sessionKey=<the session> cause=completed`
  # line (src/channels/turn/execution.ts:115) — accepted only AFTER the same-turn request. The channel's own
  # `reply suppressed <r1> kind=final` is accepted too (an embedded runtime would write it). No terminal = FAIL.
  local session_key term_re
  snap
  session_key=$(grep -E "sessionbus: delivery $(ere_escape "$r1id") from " "$snapfile" | grep -o 'session=[^ ]*' | head -1 | cut -d= -f2 || true)
  term_re="(sessionbus: reply suppressed $(ere_escape "$r1id") kind=final|\\[turn/execution\\].*channel=sessionbus .*sessionKey=$(ere_escape "${session_key:-none}") cause=completed)"
  inject=$(wait_line 'codex-fixture: req .*tool_output=true slow=true sawInject=true turn=same' 60) || inject=""
  final=""
  if [[ -n "$inject" ]]; then
    local deadline=$((SECONDS + 60))
    while [[ -z "$final" ]] && (( SECONDS < deadline )); do
      snap
      final=$(line_after "$inject" "$term_re")
      [[ -n "$final" ]] || sleep 1
    done
  fi
  snap
  inject=$(line_of 'codex-fixture: req .*tool_output=true slow=true sawInject=true turn=same')
  followup=$(line_of 'codex-fixture: req .*sawInject=true turn=followup')
  [[ -z "$inject" ]] || final=$(line_after "$inject" "$term_re")
  fallback=$(line_of 'steer fallback')
  ua=$(line_of 'codex-fixture: req n=[0-9]+ .* codex=yes')
  harness=$("${compose[@]}" exec -T openclaw-gateway sh -c 'ps -eo args | grep "[a]pp-server" | head -2; ls /home/node/.openclaw/agents/codexsmoke/agent/codex-home 2>&1 | head -5' 2>&1 | tr '\n' '|' | cut -c1-300)
  local evidence="ids: $r1id / $r2id; active work: $(text_at "$toolcall"); reaction: ${inject:+$(text_at "$inject")}; terminal line #${final:-none}, same-turn INJECT req line #${inject:-none}, followup INJECT req line #${followup:-none}; codex harness: ua line #${ua:-none}, $harness"
  if [[ -z "$ua" ]]; then
    result busy-mid-codex FAIL "no request from the managed codex app-server (codex=yes: user agent openclaw/<codex version> and the fixture bearer) reached the fixture. $evidence"
  elif [[ -n "$fallback" ]]; then
    result busy-mid-codex FAIL "steer fallback line present: $(text_at "$fallback"). $evidence"
  elif [[ -z "$inject" && -n "$followup" ]]; then
    result busy-mid-codex FAIL "INJECT-MARK ran as a followup turn after the first final, not in the running turn (fixture turn=followup). $evidence"
  elif [[ -z "$inject" ]]; then
    result busy-mid-codex FAIL "the model never saw INJECT-MARK in the running turn. $evidence"
  elif [[ -z "$final" ]]; then
    result busy-mid-codex FAIL "no terminal for the SLOW turn within 60 s after the same-turn request (neither `reply suppressed $r1id kind=final` nor the `[turn/execution] … sessionKey=${session_key:-unknown} cause=completed` line). $evidence"
  elif [[ "$inject" -lt "$final" ]]; then
    result busy-mid-codex PASS "same turn (fixture turn=same) on the real codex harness, before the SLOW message's own final. $evidence"
  else
    result busy-mid-codex FAIL "the same-turn request was logged after the SLOW final (inconsistent order). $evidence"
  fi
  AGENT=$saved_agent; peer_id=$saved_peer
  sleep 4
}

clause_tg_split() {
  mark
  send_msg "SLOW tg-split"
  wait_line 'mock-model: stream n=[0-9]+ start' 60 >/dev/null || { result tg-split FAIL "bus SLOW run did not start"; return; }
  sleep 2
  local out status=0
  out=$("${compose[@]}" exec -T openclaw-gateway node openclaw.mjs agent --agent "$AGENT" --session-key "agent:$AGENT:main" --message "TG-SIM tg-split" --json 2>&1) || status=$?
  # OpenClaw prefixes a CLI agent turn with a timestamp envelope ("[Mon 2026-10-05 10:51 UTC] TG-SIM tg-split") and, on 9.8,
  # can follow the text with runtime lines inside the same user message: the unique token anywhere in the body counts.
  local tg busend tg_re='mock-model: req .*body="[^"]*TG-SIM tg-split'
  tg=$(wait_line "$tg_re" 30) || tg=""
  busend=$(wait_line 'mock-model: stream n=[0-9]+ end closed=' 40) || busend=""
  snap
  tg=$(line_of "$tg_re")
  busend=$(line_of 'mock-model: stream n=[0-9]+ end closed=')
  local sessions
  sessions=$("${compose[@]}" exec -T openclaw-gateway node openclaw.mjs sessions --agent "$AGENT" --json 2>/dev/null | head -c 600 || true)
  if (( status == 0 )) && [[ -n "$tg" && -n "$busend" && "$tg" -lt "$busend" ]] && grep -q 'end closed=false' <<<"$(text_at "$busend")"; then
    result tg-split PASS "TG-style turn in agent:$AGENT:main completed while the bus SLOW run streamed, and the bus run was not interrupted ($(text_at "$busend")); sessions: ${sessions:-n/a}"
  else
    result tg-split FAIL "agent exit=$status tg line='${tg}' bus end='$(text_at "${busend:-1}")' out: $(printf '%s' "$out" | head -c 300)"
  fi
  sleep 4
}

# ---------------------------------------------------------------- one version
run_version() {
  version=$1
  export COMPOSE_PROJECT_NAME="oc_mvp_smoke_${$}_${version//[^0-9a-z]/_}"
  export OPENCLAW_IMAGE="${caller_image:-ghcr.io/openclaw/openclaw:${version}}"
  compose=(docker compose -f smoke/docker/compose.yaml)
  say "=== OpenClaw ${version} (image $OPENCLAW_IMAGE) ==="

  mkdir -p smoke/docker/.state smoke/docker/.pkg
  chmod -R a+rwX smoke/docker/.state
  cp smoke/docker/openclaw.json5 smoke/docker/.state/openclaw.json
  if [[ "${SMOKE_PEER_OWNERSHIP:-explicit}" == marker ]]; then
    # The legacy `default: true` marker instead of explicit ownership. OpenClaw materializes a channel-wide sessionbus
    # binding to `smoke`; the plugin's synthetic peer-wildcard binding outranks it (P-ROUTE-1, option B), so every clause,
    # busy-mid-codex included, must pass in this mode too.
    sed -i.bak -e '/^    ownership: "explicit",$/d' -e 's/^      smoke: { tools:/      smoke: { default: true, tools:/' smoke/docker/.state/openclaw.json && rm -f smoke/docker/.state/openclaw.json.bak
  fi
  chmod a+rw smoke/docker/.state/openclaw.json

  if [[ "$SMOKE_INSTALL" == tgz ]]; then
    if [[ -z "$pack_dir" ]]; then
      pack_dir=$(mktemp -d smoke/docker/.pkg/pack.XXXXXXXX)
      # mktemp creates 0700; the Gateway container reads the tarball as its own non-root user.
      chmod 755 "$pack_dir"
      pack_json=$(npm pack --json --pack-destination "$pack_dir")
      pack_file=$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(!p[0]?.filename) process.exit(1); process.stdout.write(p[0].filename)' <<<"$pack_json")
    fi
    "${compose[@]}" run --rm --no-deps -T openclaw-setup node openclaw.mjs plugins install "/plugin-pkg/${pack_dir##*/}/$pack_file" --force --accept-capabilities
    say "install: tgz $pack_file"
  else
    [[ -d node_modules/@sessionbus/kit ]] || { echo "link mode needs host node_modules" >&2; exit 2; }
    "${compose[@]}" run --rm --no-deps -T openclaw-setup node openclaw.mjs plugins install --link /plugin-src --force --accept-capabilities
    say "install: link /plugin-src"
  fi
  # The channel id is unknown to config validation until the plugin is installed (spike 003 check 1): set it now.
  "${compose[@]}" run --rm --no-deps -T openclaw-setup node openclaw.mjs config set channels.sessionbus.enabled true

  node smoke/docker/socket-bridge.mjs host &
  bridge_pid=$!
  sleep 1
  kill -0 "$bridge_pid"
  "${compose[@]}" up -d
  wait_gateway

  inspect=$("${compose[@]}" exec -T openclaw-gateway node openclaw.mjs plugins inspect sessionbus --runtime --json)
  inspect_status=$(node -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(v.plugin?.id!=="sessionbus") process.exit(1); process.stdout.write(v.plugin.status ?? "")' <<<"$inspect")
  if [[ "$inspect_status" == loaded ]]; then result plugin-loaded PASS "plugin.status=$inspect_status"; else result plugin-loaded FAIL "plugin inspect status: $inspect_status"; teardown_version; return; fi

  if [[ "${SMOKE_MODE:-smoke}" == probe ]]; then saw_probe_fail=0; probe_codex || true; if (( saw_probe_fail )); then dump_evidence probe; fi; teardown_version; return; fi
  find_peer || { result plugin-loaded FAIL "peer not visible"; teardown_version; return; }

  clause_idle_wake_and_tool
  clause_busy_mid
  clause_busy_mid_boundary
  clause_slash_as_text slash-as-text
  clause_tg_split
  clause_busy_mid_codex

  # D23: an operator's wildcard commands.allowFrom must not turn bus text into commands.
  "${compose[@]}" run --rm --no-deps -T openclaw-setup node openclaw.mjs config set commands.allowFrom '{"*":["*"]}' --strict-json
  "${compose[@]}" restart openclaw-gateway >/dev/null
  wait_gateway
  find_peer
  # The variant only counts if the wildcard really is the effective config after the restart (the CLI rewrites the
  # config on `config set`: it must keep the value, and must not drop the agents the codex clause needs).
  local effective codex_agent
  local effective_raw codex_raw
  effective_raw=$("${compose[@]}" exec -T openclaw-gateway node openclaw.mjs config get commands.allowFrom --json 2>&1) || true
  codex_raw=$("${compose[@]}" exec -T openclaw-gateway node openclaw.mjs config get agents.entries.codexsmoke --json 2>&1) || true
  effective=$(cfg_json <<<"$effective_raw") || effective=""
  codex_agent=$(cfg_json <<<"$codex_raw") || codex_agent=""
  if jq -e '. == {"*":["*"]}' <<<"$effective" >/dev/null 2>&1; then
    result allowFrom-config PASS "commands.allowFrom is {\"*\":[\"*\"]} after the restart (effective config)"
    clause_slash_as_text "slash-as-text[allowFrom *]"
  else
    result allowFrom-config FAIL "commands.allowFrom is not the wildcard after the restart (parsed: ${effective:-nothing}; raw: $(printf '%s' "$effective_raw" | tr '\n' ' ' | cut -c1-300)); the slash-as-text[allowFrom *] variant would repeat the default case"
  fi
  if jq -e 'type=="object"' <<<"$codex_agent" >/dev/null 2>&1; then
    say "[$version] note: agents.entries.codexsmoke survived the config rewrite: $(printf '%s' "$codex_agent" | cut -c1-200)"
  else
    say "[$version] note: agents.entries.codexsmoke is missing after the config rewrite (parsed: ${codex_agent:-nothing}; raw: $(printf '%s' "$codex_raw" | tr '\n' ' ' | cut -c1-300)) — the CLI dropped it"
  fi

  teardown_version
}

for v in "${versions[@]}"; do
  run_version "$v"
done

say "=== summary ==="
if (( overall == 0 )); then say "ALL CLAUSES PASS"; else say "SOME CLAUSES FAILED"; fi
