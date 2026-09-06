#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${IOS_PROVISIONING_PROFILE_DIR:-$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles}"
DEVICE_UDID="${IOS_DEVICE_UDID:-}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

[[ "$(uname -s)" == "Darwin" ]] || fail "iOS signing checks require macOS."

identity_output="$(security find-identity -v -p codesigning 2>&1 || true)"
identity_count="$(printf '%s\n' "$identity_output" | awk '
  /^[[:space:]]*[0-9]+\)/ && /"(Apple Development|iPhone Developer):/ {count++}
  END {print count+0}
')"
printf 'apple_development_identities=%s\n' "$identity_count"
[[ "$identity_count" -gt 0 ]] || fail "No valid Apple Development signing identity was found."
[[ -d "$PROFILE_DIR" ]] || fail "Provisioning profile directory does not exist."

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/iphone-bridge-profiles.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT

profile_count=0
recommended_count=0
renewable_count=0
expired_count=0
unreadable_count=0
device_match_count=0

while IFS= read -r -d '' profile; do
  profile_count=$((profile_count + 1))
  plist="$tmp_root/profile-$profile_count.plist"
  if ! security cms -D -i "$profile" >"$plist" 2>/dev/null; then
    if ! openssl smime -inform der -verify -noverify -in "$profile" -out "$plist" >/dev/null 2>&1; then
      unreadable_count=$((unreadable_count + 1))
      continue
    fi
  fi

  application_identifier="$(plutil -extract Entitlements.application-identifier raw -o - "$plist" 2>/dev/null || true)"
  bundle_id="${application_identifier#*.}"
  platform="$(plutil -extract Platform.0 raw -o - "$plist" 2>/dev/null || true)"
  expiration="$(plutil -extract ExpirationDate raw -o - "$plist" 2>/dev/null || true)"
  get_task_allow="$(plutil -extract Entitlements.get-task-allow raw -o - "$plist" 2>/dev/null || true)"
  expired=false
  if [[ -z "$expiration" ]] || ! PROFILE_EXPIRATION="$expiration" node -e '
    const value = Date.parse(process.env.PROFILE_EXPIRATION);
    process.exit(Number.isFinite(value) && value > Date.now() ? 0 : 1);
  '; then
    expired=true
    expired_count=$((expired_count + 1))
  fi

  supports_device=true
  if [[ -n "$DEVICE_UDID" ]]; then
    provisioned_devices="$(plutil -extract ProvisionedDevices json -o - "$plist" 2>/dev/null || true)"
    if ! PROFILE_DEVICES="$provisioned_devices" PROFILE_DEVICE_UDID="$DEVICE_UDID" node -e '
      const devices = JSON.parse(process.env.PROFILE_DEVICES || "[]");
      process.exit(Array.isArray(devices) && devices.includes(process.env.PROFILE_DEVICE_UDID) ? 0 : 1);
    '; then
      supports_device=false
    else
      device_match_count=$((device_match_count + 1))
    fi
  fi

  if [[ "$expired" == false && "$supports_device" == true && "$platform" == "iOS" && "$get_task_allow" == "true" ]] &&
    [[ "$bundle_id" == "*" || "$bundle_id" == *.xctrunner ]]; then
    recommended_count=$((recommended_count + 1))
  fi
  if [[ "$expired" == true && "$supports_device" == true && "$platform" == "iOS" && "$get_task_allow" == "true" ]] &&
    [[ "$bundle_id" == *.xctrunner ]]; then
    renewable_count=$((renewable_count + 1))
  fi
done < <(find "$PROFILE_DIR" -maxdepth 1 -type f -name '*.mobileprovision' -print0)

printf 'mobileprovision_profiles=%s\n' "$profile_count"
printf 'unreadable_profiles=%s\n' "$unreadable_count"
printf 'expired_profiles=%s\n' "$expired_count"
printf 'recommended_wda_profiles=%s\n' "$recommended_count"
printf 'renewable_expired_wda_profiles=%s\n' "$renewable_count"
if [[ -n "$DEVICE_UDID" ]]; then printf 'profiles_matching_selected_device=%s\n' "$device_match_count"; fi

[[ "$profile_count" -gt 0 ]] || fail "No provisioning profiles were found."
[[ "$unreadable_count" -lt "$profile_count" ]] || fail "No provisioning profile could be decoded."
[[ "$recommended_count" -gt 0 || "$renewable_count" -gt 0 ]] ||
  fail "No valid or automatically renewable iOS profile is suitable for WDA and the selected device."
if [[ "$recommended_count" -eq 0 ]]; then printf 'IOS_SIGNING_RENEWAL_REQUIRED=1\n'; fi
printf 'IOS_SIGNING_READY=1\n'
