#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
failures=0

check() {
  local label="$1"
  shift
  if "$@"; then
    printf '%s=ok\n' "$label"
  else
    printf '%s=failed\n' "$label" >&2
    failures=$((failures + 1))
  fi
}

printf '== Toolchain ==\n'
check node_24_or_newer node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
check xcode_16_or_newer bash -c 'version="$(xcodebuild -version 2>/dev/null | awk "NR==1 {print \$2}")"; [[ "${version%%.*}" -ge 16 ]]'
check tunnel_client bash -c 'command -v tunnel-client >/dev/null 2>&1'

printf '\n== Bridge contract ==\n'
check direct_mcp_smoke node "$REPO_ROOT/scripts/appium-mcp-smoke.mjs"

printf '\n== Physical device presence ==\n'
device_count="$(xcrun xctrace list devices 2>/dev/null | awk '
  /^== Simulators ==/ {simulators=1}
  !simulators && /(iPhone|iPad)/ && /\([0-9A-Fa-f-]{20,}\)$/ {count++}
  END {print count+0}
')"
printf 'connected_real_ios_devices=%s\n' "$device_count"
if [[ "$device_count" -lt 1 ]]; then failures=$((failures + 1)); fi

printf '\n== Signing ==\n'
if ! bash "$REPO_ROOT/scripts/ios-signing-status.sh"; then failures=$((failures + 1)); fi

printf '\n== Managed runtime ==\n'
if ! bash "$REPO_ROOT/scripts/status.sh"; then failures=$((failures + 1)); fi

printf '\nDOCTOR_FAILURES=%s\n' "$failures"
[[ "$failures" -eq 0 ]]
