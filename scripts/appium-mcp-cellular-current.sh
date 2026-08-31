#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[[ "${IPHONE_BRIDGE_CELLULAR_ENABLED:-false}" == "true" ]] || {
  printf 'ERROR: Cellular launcher requires IPHONE_BRIDGE_CELLULAR_ENABLED=true.\n' >&2
  exit 1
}
[[ -n "${IPHONE_BRIDGE_CELLULAR_RELAY_URL:-}" ]] || {
  printf 'ERROR: Set IPHONE_BRIDGE_CELLULAR_RELAY_URL.\n' >&2
  exit 1
}
[[ -n "${IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE:-}" ]] || {
  printf 'ERROR: Set IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE.\n' >&2
  exit 1
}

exec "$REPO_ROOT/scripts/appium-mcp-current.sh" "$@"
