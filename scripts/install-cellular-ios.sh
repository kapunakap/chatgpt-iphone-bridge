#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$REPO_ROOT/ios/BridgeBrowser.xcodeproj"
DEVICE_UDID="${IOS_DEVICE_UDID:-}"
TEAM_ID="${DEVELOPMENT_TEAM:-}"
BUNDLE_ID="${BRIDGE_BROWSER_BUNDLE_ID:-}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "Bridge Browser installation requires macOS."
command -v xcodebuild >/dev/null 2>&1 || fail "Full Xcode is required."
command -v xcrun >/dev/null 2>&1 || fail "Xcode command-line tools are required."
[[ -d "$PROJECT" ]] || fail "Bridge Browser Xcode project is missing."
[[ -n "$DEVICE_UDID" ]] || fail "Set IOS_DEVICE_UDID to the connected iPhone UDID."
[[ -n "$TEAM_ID" ]] || fail "Set DEVELOPMENT_TEAM to the Personal Team shown in Xcode."
[[ -n "$BUNDLE_ID" ]] || fail "Set BRIDGE_BROWSER_BUNDLE_ID to a unique reverse-DNS bundle ID."
[[ "$BUNDLE_ID" =~ ^[A-Za-z0-9.-]+$ ]] || fail "BRIDGE_BROWSER_BUNDLE_ID contains invalid characters."

derived_data="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-iphone-bridge-browser.XXXXXX")"
trap 'rm -rf "$derived_data"' EXIT

printf 'Building the free Personal Team Bridge Browser app.\n'
xcodebuild \
  -project "$PROJECT" \
  -scheme BridgeBrowser \
  -configuration Debug \
  -destination "id=$DEVICE_UDID" \
  -derivedDataPath "$derived_data" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  CODE_SIGN_STYLE=Automatic \
  build

app_path="$derived_data/Build/Products/Debug-iphoneos/BridgeBrowser.app"
[[ -d "$app_path" ]] || fail "Signed Bridge Browser app was not produced."

printf '\nInstalling on the selected iPhone.\n'
xcrun devicectl device install app --device "$DEVICE_UDID" "$app_path"

printf '\nCELLULAR_IOS_INSTALLED=1\n'
printf 'Free Personal Team provisioning expires after 7 days; rerun this command to renew it.\n'
