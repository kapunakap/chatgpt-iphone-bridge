#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALIAS="${TUNNEL_ALIAS:-local-iphone-bridge}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

printf '== chatgpt-iphone-bridge bootstrap ==\n'
[[ "$(uname -s)" == "Darwin" ]] || fail "This bridge requires macOS."

command -v node >/dev/null 2>&1 || fail "Node.js 24 or newer is required."
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$node_major" -ge 24 ]] || fail "Node.js 24 or newer is required; active version is $(node --version)."
command -v npm >/dev/null 2>&1 || fail "npm is required."
printf 'node=%s\n' "$(node --version)"

command -v xcodebuild >/dev/null 2>&1 || fail "Full Xcode is required."
xcode_version="$(xcodebuild -version | awk 'NR==1 {print $2}')"
xcode_major="${xcode_version%%.*}"
[[ "$xcode_major" -ge 16 ]] || fail "Xcode 16 or newer is required; active version is $xcode_version."
printf 'xcode=%s\n' "$xcode_version"

if ! command -v tunnel-client >/dev/null 2>&1; then
  [[ "${BRIDGE_INSTALL_TUNNEL_CLIENT:-0}" == "1" ]] || fail "Install openai/tools/tunnel-client, or rerun with BRIDGE_INSTALL_TUNNEL_CLIENT=1."
  command -v brew >/dev/null 2>&1 || fail "Homebrew is required for the requested tunnel-client installation."
  brew install openai/tools/tunnel-client
fi
printf 'tunnel_client=%s\n' "$(tunnel-client --version)"

set +e
runtime_json="$(tunnel-client runtimes --json status "$ALIAS" 2>/dev/null)"
runtime_rc=$?
set -e
if [[ "$runtime_rc" -eq 0 ]] && BRIDGE_RUNTIME_JSON="$runtime_json" node <<'NODE'
const status = JSON.parse(process.env.BRIDGE_RUNTIME_JSON);
process.exit(status.process_running === true ? 0 : 1);
NODE
then
  fail "Managed runtime $ALIAS is active. Stop it before changing dependencies."
fi

printf '\n== Installing pinned Appium MCP ==\n'
cd "$REPO_ROOT"
npm ci
installed_version="$(node -p 'require("./node_modules/appium-mcp/package.json").version')"
[[ "$installed_version" == "1.92.11" ]] || fail "Expected appium-mcp 1.92.11, found $installed_version."
printf 'appium_mcp=%s\n' "$installed_version"

printf '\n== Direct MCP smoke ==\n'
npm run smoke

printf '\n== Connected Apple devices ==\n'
xcrun xctrace list devices

printf '\n== iOS signing status ==\n'
set +e
bash "$REPO_ROOT/scripts/ios-signing-status.sh"
signing_rc=$?
set -e

printf '\nBOOTSTRAP_OK=1\n'
if [[ "$signing_rc" -eq 0 ]]; then
  printf 'IOS_SIGNING_READY=1\n'
else
  printf 'IOS_SIGNING_READY=0\n'
  printf 'Next: add the Apple ID/Personal Team in Xcode and create a profile whose bundle ID ends in .xctrunner.\n'
fi
