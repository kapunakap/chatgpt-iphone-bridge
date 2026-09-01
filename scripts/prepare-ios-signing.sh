#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVICE_UDID="${IOS_DEVICE_UDID:-}"
TEAM_ID="${DEVELOPMENT_TEAM:-}"
BUNDLE_ID_BASE="${WDA_BUNDLE_ID_BASE:-com.kapunakap.chatgptiphonebridge.WebDriverAgentRunner}"
WDA_PROJECT="$(node --input-type=module -e 'import { BOOTSTRAP_PATH } from "appium-webdriveragent"; console.log(`${BOOTSTRAP_PATH}/WebDriverAgent.xcodeproj`)')"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "This command requires macOS."
[[ -n "$DEVICE_UDID" ]] || fail "Set IOS_DEVICE_UDID to the connected iPhone or iPad UDID."
[[ -n "$TEAM_ID" ]] || fail "Set DEVELOPMENT_TEAM to the Apple Personal Team ID."
[[ "$BUNDLE_ID_BASE" != *.xctrunner ]] || fail "WDA_BUNDLE_ID_BASE must omit .xctrunner; Xcode adds that suffix to the runner profile."
[[ -d "$WDA_PROJECT" ]] || fail "Bundled WebDriverAgent project not found. Run bash scripts/bootstrap-local.sh."

derived_data="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-iphone-bridge-wda.XXXXXX")"
trap 'rm -rf "$derived_data"' EXIT
printf 'Preparing a temporary signed WDA build.\n'

xcodebuild \
  -project "$WDA_PROJECT" \
  -scheme WebDriverAgentRunner \
  -configuration Debug \
  -destination "id=$DEVICE_UDID" \
  -derivedDataPath "$derived_data" \
  -jobs 1 \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID_BASE" \
  build-for-testing

printf '\nWDA_SIGNING_BUILD_OK=1\n'
printf 'Run bash scripts/ios-signing-status.sh next.\n'
printf 'On the iOS device, trust the Developer App under Settings -> General -> VPN & Device Management before the first WDA launch.\n'
