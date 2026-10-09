# Shared by the peer smoke, the lane smoke and the codex probe (sourced; needs the `compose` array of the caller).
#
# How the REAL codex app-server of the codex harness is pointed at the codex-fixture (X1-2/X1-3), from the sources:
# - the agent's model is `openai/gpt-5.5` with `agentRuntime.id: "codex"`. `gpt-5.5` is in the bundled/offline model
#   catalog (docs/plugins/codex-harness-reference.md:784-846); an invented `codex/fixture-model` is "Unknown model" on
#   8.2 (X1-2). For provider `openai` OpenClaw sends modelProvider "openai" in thread/start, so the codex built-in
#   OpenAI provider is used and `config.toml`'s model_provider is ignored (extensions/codex/src/app-server/
#   thread-model-selection.ts:114-139 on 8.2, :109-135 on 9.8; on 9.8 `codex/<m>` gets modelProvider "openai" the same way once the model resolves) — X1-3.
# - the built-in provider's base URL is Codex's `openai_base_url`. It is given as `-c openai_base_url="..."` in the codex
#   plugin's `appServer.args` (extensions/codex/src/app-server/config-runtime.ts:133,319: args are taken as written,
#   default ["app-server","--listen","stdio://"]; docs/plugins/codex-harness-reference.md:524-533: OpenClaw groups `-c`
#   before `app-server`), and again in <agentDir>/codex-home/config.toml (extensions/codex/src/app-server/
#   auth-start-options.ts:7-12 on 8.2: CODEX_HOME = <agentDir>/codex-home).
# - the key: for an API-key route OpenClaw falls back to OPENAI_API_KEY (docs/plugins/codex-harness-reference.md:539-543).
#   The compose files give the Gateway a dummy OPENAI_API_KEY; it can only ever reach the fixture because the Gateway's
#   network is `internal: true` (no route out) and every codex clause first proves that (`egress_blocked`).

CODEX_FIXTURE_URL=http://codex-fixture:8001/v1

codex_toml() { # codex_toml <base_url>
  cat <<TOML
openai_base_url = "$1"
cli_auth_credentials_store = "ephemeral"
web_search = "disabled"

[analytics]
enabled = false

[feedback]
enabled = false
TOML
}

# write_codex_home <agent id> [base_url]: written as root through `compose exec` (the state may be a docker volume).
write_codex_home() {
  local agent=$1 base_url=${2:-$CODEX_FIXTURE_URL} dir
  dir="/home/node/.openclaw/agents/$agent/agent/codex-home"
  codex_toml "$base_url" | "${compose[@]}" exec -T -u root openclaw-gateway sh -c 'mkdir -p "$1" && cat >"$1/config.toml" && chown -R node:node "$2"' _ "$dir" "/home/node/.openclaw/agents/$agent"
}

# egress_blocked: true only when the Gateway container fails at the NETWORK level to reach api.openai.com (no route, no
# DNS, refused, timeout). Any other outcome — a TLS error, a reset, an HTTP answer — means packets left the container
# (e.g. behind an intercepting proxy) and counts as NOT blocked (CR-X1-2).
egress_blocked() {
  local out
  out=$("${compose[@]}" exec -T openclaw-gateway node -e 'const r=require("node:https").get("https://api.openai.com/v1/models",{timeout:5000},(res)=>{console.log("REACHED "+res.statusCode);process.exit(0)});const net=new Set(["ENETUNREACH","EHOSTUNREACH","EAI_AGAIN","ENOTFOUND","ECONNREFUSED","ETIMEDOUT"]);r.on("error",(e)=>{console.log((net.has(e.code)?"BLOCKED ":"UNEXPECTED ")+e.code);process.exit(0)});r.on("timeout",()=>{console.log("BLOCKED timeout");process.exit(0)})' 2>&1) || true
  [[ "$out" == BLOCKED* ]]
}
