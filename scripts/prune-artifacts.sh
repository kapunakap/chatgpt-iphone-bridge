#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_ROOT="${APPIUM_BRIDGE_ARTIFACT_ROOT:-$HOME/Library/Application Support/chatgpt-iphone-bridge}"
SCREENSHOT_ROOT="$ARTIFACT_ROOT/screenshots"
RETENTION_DAYS="${APPIUM_BRIDGE_RETENTION_DAYS:-7}"

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || {
  printf 'ERROR: APPIUM_BRIDGE_RETENTION_DAYS must be a non-negative integer.\n' >&2
  exit 2
}
[[ -d "$SCREENSHOT_ROOT" ]] || {
  printf 'PRUNED_FILES=0\n'
  exit 0
}

before="$(find "$SCREENSHOT_ROOT" -type f -mtime "+$RETENTION_DAYS" | wc -l | tr -d ' ')"
find "$SCREENSHOT_ROOT" -type f -mtime "+$RETENTION_DAYS" -delete
printf 'PRUNED_FILES=%s\n' "$before"
