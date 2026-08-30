#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
derived_data="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-iphone-bridge-ios-check.XXXXXX")"
trap 'rm -rf "$derived_data"' EXIT

xcrun swift-format lint --strict --recursive "$REPO_ROOT/ios/BridgeBrowser" "$REPO_ROOT/ios/BridgeBrowserTests"

build_log="$derived_data/xcodebuild.log"
if ! xcodebuild \
  -project "$REPO_ROOT/ios/BridgeBrowser.xcodeproj" \
  -scheme BridgeBrowser \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  build >"$build_log" 2>&1
then
  tail -200 "$build_log" >&2
  exit 1
fi

smoke_binary="$derived_data/BridgeCoreSmoke"
env CLANG_MODULE_CACHE_PATH="$derived_data/ModuleCache" SWIFT_MODULE_CACHE_PATH="$derived_data/ModuleCache" swiftc \
  -module-cache-path "$derived_data/ModuleCache" \
  "$REPO_ROOT/ios/BridgeBrowser/BridgeModels.swift" \
  "$REPO_ROOT/ios/BridgeBrowser/BridgeCrypto.swift" \
  "$REPO_ROOT/ios/BridgeBrowserTests/BridgeCoreSmoke.swift" \
  -o "$smoke_binary"
swift_vector="$($smoke_binary)"
SWIFT_CELLULAR_VECTOR="$swift_vector" node "$REPO_ROOT/scripts/verify-swift-crypto-vector.mjs"

printf 'CELLULAR_IOS_BUILD_OK=1\n'
