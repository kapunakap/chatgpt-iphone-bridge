#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v npm >/dev/null 2>&1 || {
  printf 'ERROR: npm is required.\n' >&2
  exit 1
}
[[ -f "$REPO_ROOT/relay/wrangler.jsonc" ]] || {
  printf 'ERROR: Cellular relay configuration is missing.\n' >&2
  exit 1
}

cd "$REPO_ROOT"
npm run check:relay
npm run test:relay
npm run deploy --prefix relay
