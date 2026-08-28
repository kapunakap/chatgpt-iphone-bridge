#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-iphone}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

printf '== Versions ==\n'
printf 'node=%s\n' "$(node --version)"
printf 'xcode=%s\n' "$(xcodebuild -version | awk 'NR==1 {print $2}')"
printf 'appium_mcp=%s\n' "$(node -p 'require(process.argv[1]).version' "$REPO_ROOT/node_modules/appium-mcp/package.json")"
printf 'tunnel_client=%s\n' "$(tunnel-client --version)"

printf '\n== Direct MCP smoke ==\n'
node "$REPO_ROOT/scripts/appium-mcp-smoke.mjs"

printf '\n== Connected Apple devices ==\n'
xcrun xctrace list devices

printf '\n== iOS signing ==\n'
bash "$REPO_ROOT/scripts/ios-signing-status.sh"

printf '\n== Tunnel runtime (%s) ==\n' "$ALIAS"
status_json="$(tunnel-client runtimes --json status "$ALIAS")"
printf '%s\n' "$status_json"
STATUS_JSON="$status_json" node <<'NODE'
const status = JSON.parse(process.env.STATUS_JSON);
const checks = {
  process_running: status.process_running === true,
  healthy: status.healthy === true,
  ready: status.ready === true,
};
for (const [name, ok] of Object.entries(checks)) console.log(`${name}=${ok}`);
if (!Object.values(checks).every(Boolean)) process.exit(2);
NODE

printf '\nBRIDGE_LOCAL_READY=1\n'
