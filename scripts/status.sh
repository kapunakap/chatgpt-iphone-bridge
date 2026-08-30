#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-iphone-bridge}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${IPHONE_BRIDGE_CELLULAR_ENABLED:-false}" == "true" ]]; then
  EXPECTED_LAUNCHER="$REPO_ROOT/scripts/appium-mcp-cellular-current.sh"
else
  EXPECTED_LAUNCHER="$REPO_ROOT/scripts/appium-mcp-current.sh"
fi

printf '== Versions ==\n'
printf 'node=%s\n' "$(node --version)"
printf 'xcode=%s\n' "$(xcodebuild -version | awk 'NR==1 {print $2}')"
printf 'appium_mcp=%s\n' "$(node -p 'require(process.argv[1]).version' "$REPO_ROOT/node_modules/appium-mcp/package.json")"
printf 'tunnel_client=%s\n' "$(tunnel-client --version)"

printf '\n== Direct MCP smoke ==\n'
node "$REPO_ROOT/scripts/appium-mcp-smoke.mjs"

printf '\n== Tunnel runtime (%s) ==\n' "$ALIAS"
status_json="$(tunnel-client runtimes --json status "$ALIAS")"
BRIDGE_STATUS_JSON="$status_json" BRIDGE_EXPECTED_LAUNCHER="$EXPECTED_LAUNCHER" node <<'NODE'
const status = JSON.parse(process.env.BRIDGE_STATUS_JSON);
const target = String(status?.process?.target_value ?? '').replace(/^['"]|['"]$/g, '');
const checks = {
  process_running: status.process_running === true,
  healthy: status.healthy === true,
  ready: status.ready === true,
  target_matches: target === process.env.BRIDGE_EXPECTED_LAUNCHER,
};
console.log(`runtime_state=${status.runtime_state ?? 'unknown'}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${name}=${ok}`);
if (!Object.values(checks).every(Boolean)) process.exit(2);
NODE

printf '\nBRIDGE_RUNTIME_READY=1\n'

if [[ "${IPHONE_BRIDGE_CELLULAR_ENABLED:-false}" == "true" ]]; then
  printf '\n== Cellular browser ==\n'
  node "$REPO_ROOT/scripts/cellular-ops.mjs" status
fi
