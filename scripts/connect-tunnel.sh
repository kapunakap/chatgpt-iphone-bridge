#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-iphone-bridge}"
TUNNEL_ID="${CONTROL_PLANE_TUNNEL_ID:-}"
RUNTIME_API_KEY_FILE="${CONTROL_PLANE_RUNTIME_API_KEY_FILE:-$HOME/.config/chatgpt-iphone-bridge/runtime-api-key}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${IPHONE_BRIDGE_CELLULAR_ENABLED:-false}" == "true" ]]; then
  APPIUM_LAUNCHER="$REPO_ROOT/scripts/appium-mcp-cellular-current.sh"
else
  APPIUM_LAUNCHER="$REPO_ROOT/scripts/appium-mcp-current.sh"
fi
ARTIFACT_ROOT="${APPIUM_BRIDGE_ARTIFACT_ROOT:-$HOME/Library/Application Support/chatgpt-iphone-bridge}"
CONNECT_LOCK="$ARTIFACT_ROOT/runtime/connect.lock"

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
umask 077
mkdir -p "$ARTIFACT_ROOT/runtime"
if ! mkdir "$CONNECT_LOCK" 2>/dev/null; then
  fail "Another bridge connect operation is active."
fi
trap 'rmdir "$CONNECT_LOCK" 2>/dev/null || true' EXIT

printf '== Direct Appium MCP smoke ==\n'
node "$REPO_ROOT/scripts/appium-mcp-smoke.mjs"

if [[ "${IPHONE_BRIDGE_CELLULAR_ENABLED:-false}" == "true" ]]; then
  printf '\n== Cellular pairing preflight ==\n'
  node "$REPO_ROOT/scripts/cellular-ops.mjs" doctor
  printf 'IOS_SIGNING_PREFLIGHT=skipped_cellular_mode\n'
else
  printf '\n== iOS signing preflight ==\n'
  bash "$REPO_ROOT/scripts/ios-signing-status.sh"
fi

MCP_COMMAND="\"${APPIUM_LAUNCHER}\""

printf '\n== Connecting managed tunnel runtime (%s) ==\n' "$ALIAS"
set +e
before_json="$(tunnel-client runtimes --json status "$ALIAS" 2>/dev/null)"
before_rc=$?
set -e
target_rc=1
if [[ "$before_rc" -eq 0 ]]; then
  set +e
  BRIDGE_STATUS_JSON="$before_json" BRIDGE_EXPECTED_LAUNCHER="$APPIUM_LAUNCHER" node <<'NODE'
const status = JSON.parse(process.env.BRIDGE_STATUS_JSON);
if (status.process_running !== true) process.exit(1);
const target = String(status?.process?.target_value ?? '').replace(/^['"]|['"]$/g, '');
process.exit(target === process.env.BRIDGE_EXPECTED_LAUNCHER ? 0 : 2);
NODE
  target_rc=$?
  set -e
fi
if [[ "$target_rc" -eq 0 ]]; then
  printf 'Runtime is already running with the expected launcher.\n'
  bash "$REPO_ROOT/scripts/status.sh"
  exit 0
elif [[ "$target_rc" -eq 2 ]]; then
  fail "Alias $ALIAS is running a different launcher; refusing to replace it."
fi

started_here=0
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
started_here=1

printf '\n== Waiting for running + healthy + ready ==\n'
status_json=''
for _ in {1..30}; do
  set +e
  status_json="$(tunnel-client runtimes --json status "$ALIAS" 2>&1)"
  status_rc=$?
  set -e

  if [[ "$status_rc" -eq 0 ]] && BRIDGE_STATUS_JSON="$status_json" BRIDGE_EXPECTED_LAUNCHER="$APPIUM_LAUNCHER" node <<'NODE'
const status = JSON.parse(process.env.BRIDGE_STATUS_JSON);
const target = String(status?.process?.target_value ?? '').replace(/^['"]|['"]$/g, '');
process.exit(
  status.process_running === true &&
  status.healthy === true &&
  status.ready === true &&
  target === process.env.BRIDGE_EXPECTED_LAUNCHER ? 0 : 1
);
NODE
  then
    printf '\nTUNNEL_READY=1\n'
    exit 0
  fi
  sleep 1
done

if [[ "$started_here" -eq 1 ]]; then
  tunnel-client runtimes --json stop "$ALIAS" >/dev/null 2>&1 || true
fi
fail "Managed runtime did not reach process_running=true, healthy=true, ready=true."
