#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPIUM_MCP_SERVER="$REPO_ROOT/scripts/appium-mcp-server.mjs"
ARTIFACT_ROOT="${APPIUM_BRIDGE_ARTIFACT_ROOT:-$HOME/Library/Application Support/chatgpt-iphone-bridge}"

[[ -f "$REPO_ROOT/node_modules/appium-mcp/package.json" ]] || {
  printf 'ERROR: Appium MCP is not installed. Run bash scripts/bootstrap-local.sh.\n' >&2
  exit 1
}
[[ -f "$APPIUM_MCP_SERVER" ]] || {
  printf 'ERROR: Appium MCP server is missing: %s\n' "$APPIUM_MCP_SERVER" >&2
  exit 1
}

mkdir -p "$ARTIFACT_ROOT/screenshots"

export SCREENSHOTS_DIR="$ARTIFACT_ROOT/screenshots"
export APPIUM_MCP_APPS_ENABLED="${APPIUM_MCP_APPS_ENABLED:-true}"

exec node "$APPIUM_MCP_SERVER" "$@"
