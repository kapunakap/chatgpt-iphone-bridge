#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

printf '== chatgpt-iphone-bridge bootstrap ==\n'
[[ "$(uname -s)" == "Darwin" ]] || fail "This bridge requires macOS."

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required."
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$node_major" -ge 22 ]] || fail "Node.js 22 or newer is required; active version is $(node --version)."
command -v npm >/dev/null 2>&1 || fail "npm is required."
printf 'node=%s\n' "$(node --version)"

command -v xcodebuild >/dev/null 2>&1 || fail "Full Xcode is required."
xcode_version="$(xcodebuild -version | awk 'NR==1 {print $2}')"
xcode_major="${xcode_version%%.*}"
[[ "$xcode_major" -ge 16 ]] || fail "Xcode 16 or newer is required; active version is $xcode_version."
printf 'xcode=%s\n' "$xcode_version"

if ! command -v tunnel-client >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || fail "Install Homebrew, then install openai/tools/tunnel-client."
  brew install openai/tools/tunnel-client
fi
printf 'tunnel_client=%s\n' "$(tunnel-client --version)"

printf '\n== Installing pinned Appium MCP ==\n'
cd "$REPO_ROOT"
npm install --save-exact appium-mcp@1.92.7
installed_version="$(node -p 'require("./node_modules/appium-mcp/package.json").version')"
[[ "$installed_version" == "1.92.7" ]] || fail "Expected appium-mcp 1.92.7, found $installed_version."
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
