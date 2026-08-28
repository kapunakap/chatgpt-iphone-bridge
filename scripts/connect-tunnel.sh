#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-iphone}"
TUNNEL_ID="${CONTROL_PLANE_TUNNEL_ID:-}"
RUNTIME_API_KEY_FILE="${CONTROL_PLANE_RUNTIME_API_KEY_FILE:-$HOME/.config/chatgpt-iphone-bridge/runtime-api-key}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPIUM_LAUNCHER="$REPO_ROOT/scripts/appium-mcp-current.sh"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -n "$TUNNEL_ID" ]] || fail "Set CONTROL_PLANE_TUNNEL_ID to the dedicated tunnel_... ID."
[[ "$TUNNEL_ID" =~ ^tunnel_[a-z0-9]{32}$ ]] || fail "Tunnel ID does not look like a tunnel_... ID."
[[ -f "$RUNTIME_API_KEY_FILE" && -s "$RUNTIME_API_KEY_FILE" ]] || fail "Runtime API key file is missing or empty: $RUNTIME_API_KEY_FILE"
[[ "$(stat -f '%Su' "$RUNTIME_API_KEY_FILE")" == "$(id -un)" ]] || fail "Runtime API key file must be owned by the current user."
[[ "$(stat -f '%Lp' "$RUNTIME_API_KEY_FILE")" == "600" ]] || fail "Runtime API key file permissions must be 600."
command -v tunnel-client >/dev/null 2>&1 || fail "tunnel-client is not installed."
[[ -x "$APPIUM_LAUNCHER" ]] || fail "Appium launcher is missing: $APPIUM_LAUNCHER"

printf '== Direct Appium MCP smoke ==\n'
node "$REPO_ROOT/scripts/appium-mcp-smoke.mjs"

printf '\n== iOS signing preflight ==\n'
bash "$REPO_ROOT/scripts/ios-signing-status.sh"

MCP_COMMAND="\"${APPIUM_LAUNCHER}\""

printf '\n== Connecting managed tunnel runtime (%s) ==\n' "$ALIAS"
set +e
connect_output="$({
  tunnel-client runtimes --json connect \
    --alias "$ALIAS" \
    --tunnel-id "$TUNNEL_ID" \
    --runtime-api-key "file:$RUNTIME_API_KEY_FILE" \
    --mcp-command "$MCP_COMMAND"
} 2>&1)"
connect_rc=$?
set -e
printf '%s\n' "$connect_output"
[[ "$connect_rc" -eq 0 ]] || fail "tunnel-client runtimes connect failed (exit $connect_rc)."

printf '\n== Waiting for running + healthy + ready ==\n'
status_json=''
for _ in {1..30}; do
  set +e
  status_json="$(tunnel-client runtimes --json status "$ALIAS" 2>&1)"
  status_rc=$?
  set -e

  if [[ "$status_rc" -eq 0 ]] && STATUS_JSON="$status_json" node <<'NODE'
const status = JSON.parse(process.env.STATUS_JSON);
process.exit(status.process_running === true && status.healthy === true && status.ready === true ? 0 : 1);
NODE
  then
    printf '%s\n' "$status_json"
    printf '\nTUNNEL_READY=1\n'
    exit 0
  fi
  sleep 1
done

printf '%s\n' "$status_json"
fail "Managed runtime did not reach process_running=true, healthy=true, ready=true."
