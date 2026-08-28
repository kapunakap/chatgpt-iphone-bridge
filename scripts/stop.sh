#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-iphone}"

command -v tunnel-client >/dev/null 2>&1 || {
  printf 'ERROR: tunnel-client is not installed.\n' >&2
  exit 1
}

printf 'Delete the active Appium session from ChatGPT first when possible.\n'
tunnel-client runtimes --json stop "$ALIAS"
