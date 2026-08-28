#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${IOS_PROVISIONING_PROFILE_DIR:-$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

[[ "$(uname -s)" == "Darwin" ]] || fail "iOS signing checks require macOS."

identity_output="$(security find-identity -v -p codesigning 2>&1 || true)"
identity_count="$(printf '%s\n' "$identity_output" | awk '/^[[:space:]]*[0-9]+\)/ {count++} END {print count+0}')"
printf 'valid_code_signing_identities=%s\n' "$identity_count"
[[ "$identity_count" -gt 0 ]] || fail "No valid Apple Development signing identity was found. Add the Apple ID and Personal Team in Xcode."

[[ -d "$PROFILE_DIR" ]] || fail "Provisioning profile directory does not exist: $PROFILE_DIR"

profile_count=0
recommended_count=0
while IFS= read -r -d '' profile; do
  profile_count=$((profile_count + 1))
  plist="$(mktemp "${TMPDIR:-/tmp}/iphone-bridge-profile.XXXXXX")"
  if security cms -D -i "$profile" >"$plist" 2>/dev/null; then
    name="$(plutil -extract Name raw -o - "$plist" 2>/dev/null || true)"
    bundle_id="${name#*: }"
    recommended=false
    if [[ "$bundle_id" == "*" || "$bundle_id" == *.xctrunner ]]; then
      recommended=true
      recommended_count=$((recommended_count + 1))
    fi
    printf 'profile=%s recommendedForWda=%s name=%s\n' "$(basename "$profile")" "$recommended" "$name"
  fi
  rm -f "$plist"
done < <(find "$PROFILE_DIR" -maxdepth 1 -type f -name '*.mobileprovision' -print0)

printf 'mobileprovision_profiles=%s\n' "$profile_count"
printf 'recommended_wda_profiles=%s\n' "$recommended_count"
[[ "$profile_count" -gt 0 ]] || fail "No .mobileprovision profiles were found where Appium MCP looks for them."
[[ "$recommended_count" -gt 0 ]] || fail "No profile is a wildcard or has a bundle ID ending in .xctrunner."

printf 'IOS_SIGNING_READY=1\n'
