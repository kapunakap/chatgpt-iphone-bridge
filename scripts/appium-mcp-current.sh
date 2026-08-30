#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPIUM_MCP_SERVER="$REPO_ROOT/scripts/appium-mcp-server.mjs"
ARTIFACT_ROOT="${APPIUM_BRIDGE_ARTIFACT_ROOT:-$HOME/Library/Application Support/chatgpt-iphone-bridge}"

umask 077

[[ -f "$REPO_ROOT/node_modules/appium-mcp/package.json" ]] || {
  printf 'ERROR: Appium MCP is not installed. Run bash scripts/bootstrap-local.sh.\n' >&2
  exit 1
}
[[ -f "$APPIUM_MCP_SERVER" ]] || {
  printf 'ERROR: Appium MCP server is missing: %s\n' "$APPIUM_MCP_SERVER" >&2
  exit 1
}

mkdir -p "$ARTIFACT_ROOT/screenshots" "$ARTIFACT_ROOT/runtime"
chmod 700 "$ARTIFACT_ROOT" "$ARTIFACT_ROOT/screenshots" "$ARTIFACT_ROOT/runtime"

export SCREENSHOTS_DIR="$ARTIFACT_ROOT/screenshots"
export APPIUM_MCP_APPS_ENABLED="${APPIUM_MCP_APPS_ENABLED:-true}"
export APPIUM_MCP_ON_CLIENT_DISCONNECT="delete_all"
export APPIUM_MCP_RELAXED_SECURITY="${APPIUM_MCP_RELAXED_SECURITY:-false}"
export REMOTE_SERVER_URL_ALLOW_REGEX="${REMOTE_SERVER_URL_ALLOW_REGEX:-^$}"

exec node "$APPIUM_MCP_SERVER" "$@"
