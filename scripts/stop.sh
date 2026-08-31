#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-iphone-bridge}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GENERIC_LAUNCHER="$REPO_ROOT/scripts/appium-mcp-current.sh"
CELLULAR_LAUNCHER="$REPO_ROOT/scripts/appium-mcp-cellular-current.sh"
ARTIFACT_ROOT="${APPIUM_BRIDGE_ARTIFACT_ROOT:-$HOME/Library/Application Support/chatgpt-iphone-bridge}"

command -v tunnel-client >/dev/null 2>&1 || {
  printf 'ERROR: tunnel-client is not installed.\n' >&2
  exit 1
}

set +e
status_json="$(tunnel-client runtimes --json status "$ALIAS" 2>/dev/null)"
status_rc=$?
set -e
[[ "$status_rc" -eq 0 ]] || {
  printf 'Runtime %s is already stopped or absent.\n' "$ALIAS"
  exit 0
}

set +e
BRIDGE_STATUS_JSON="$status_json" BRIDGE_GENERIC_LAUNCHER="$GENERIC_LAUNCHER" BRIDGE_CELLULAR_LAUNCHER="$CELLULAR_LAUNCHER" node <<'NODE'
const status = JSON.parse(process.env.BRIDGE_STATUS_JSON);
if (status.process_running !== true) process.exit(3);
const target = String(status?.process?.target_value ?? '').replace(/^['"]|['"]$/g, '');
if (![process.env.BRIDGE_GENERIC_LAUNCHER, process.env.BRIDGE_CELLULAR_LAUNCHER].includes(target)) process.exit(2);
NODE
check_rc=$?
set -e
if [[ "$check_rc" -eq 3 ]]; then
  printf 'Runtime %s is already stopped.\n' "$ALIAS"
  exit 0
fi
[[ "$check_rc" -eq 0 ]] || {
  printf 'ERROR: Alias %s targets a different launcher; refusing to stop it.\n' "$ALIAS" >&2
  exit 1
}

tunnel-client runtimes --json stop "$ALIAS" >/dev/null
for _ in {1..30}; do
  current="$(tunnel-client runtimes --json status "$ALIAS" 2>/dev/null || true)"
  if BRIDGE_STATUS_JSON="$current" node -e 'const s=JSON.parse(process.env.BRIDGE_STATUS_JSON || "{}"); process.exit(s.process_running === true ? 1 : 0)'; then
    remaining_lock="$(find "$ARTIFACT_ROOT/runtime" -maxdepth 1 -type d -name '*.lock' -print -quit 2>/dev/null || true)"
    if [[ -n "$remaining_lock" ]]; then
      printf 'ERROR: Runtime stopped but a session lease remains; cleanup is not proven.\n' >&2
      exit 2
    fi
    printf 'BRIDGE_STOPPED=1\n'
    exit 0
  fi
  sleep 1
done
printf 'ERROR: Runtime did not stop within 30 seconds.\n' >&2
exit 2
