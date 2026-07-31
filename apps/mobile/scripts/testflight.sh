#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load local, gitignored secrets (App Store Connect API key, etc.) if present.
if [[ -f "$APP_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_DIR/.env.local"
  set +a
fi

usage() {
  cat <<'EOF'
Usage:
  apps/mobile/scripts/testflight.sh [--build-name 1.0.0] [--build-number 202607150601] [--upload] [--no-open]

Builds a signed App Store/TestFlight IPA for Panda Code mobile and opens it in
Transporter. This uses the Apple account/profiles available to Xcode on this Mac;
no App Store Connect API key is required.

Options:
  --build-name VALUE     CFBundleShortVersionString. Defaults to pubspec version name.
  --build-number VALUE   CFBundleVersion. Defaults to current timestamp (YYYYMMDDHHMM).
  --upload               Upload with altool after building. Uses an App Store Connect
                         API key if APP_STORE_API_KEY_ID + APP_STORE_API_ISSUER_ID are set,
                         otherwise falls back to APP_STORE_USERNAME + APP_STORE_PASSWORD.
  --no-open              Do not open Transporter after building.
  -h, --help             Show this help.

Environment:
  FLUTTER_BIN               Flutter executable. Defaults to $HOME/flutter/bin/flutter, then PATH.
  IOS_TEAM_ID               Apple Developer Team ID. Required for manual signing.
  IOS_BUNDLE_ID             iOS app bundle identifier. Required for manual signing.
  SIGN_IDENTITY             Codesigning identity for manual signing.
  PROVISIONING_PROFILE      Provisioning profile name for manual signing.
  App Store Connect API key (preferred for --upload):
    APP_STORE_API_KEY_ID    Key ID, e.g. WGXQ6U853Z. The matching AuthKey_<ID>.p8 must live
                            in ~/.appstoreconnect/private_keys/ (or ./private_keys/).
    APP_STORE_API_ISSUER_ID Issuer ID (UUID) from the App Store Connect Keys page.
  App-specific password (fallback for --upload):
    APP_STORE_USERNAME      Apple ID email.
    APP_STORE_PASSWORD      App-specific password, @env:NAME, or @keychain:NAME.
EOF
}

pubspec_version() {
  awk '/^version: / { print $2; exit }' "$APP_DIR/pubspec.yaml"
}

BUILD_NAME=""
BUILD_NUMBER=""
OPEN_TRANSPORTER=1
UPLOAD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --build-name)
      BUILD_NAME="${2:-}"
      shift 2
      ;;
    --build-number)
      BUILD_NUMBER="${2:-}"
      shift 2
      ;;
    --upload)
      UPLOAD=1
      OPEN_TRANSPORTER=0
      shift
      ;;
    --no-open)
      OPEN_TRANSPORTER=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

VERSION="$(pubspec_version)"
if [[ -z "$BUILD_NAME" ]]; then
  BUILD_NAME="${VERSION%%+*}"
fi
if [[ -z "$BUILD_NUMBER" ]]; then
  BUILD_NUMBER="$(date +%Y%m%d%H%M)"
fi

if [[ -z "${FLUTTER_BIN:-}" ]]; then
  if [[ -x "$HOME/flutter/bin/flutter" ]]; then
    FLUTTER_BIN="$HOME/flutter/bin/flutter"
  else
    FLUTTER_BIN="flutter"
  fi
fi

cd "$APP_DIR"

TEAM_ID="${IOS_TEAM_ID:-${APPLE_TEAM_ID:-}}"
BUNDLE_ID="${IOS_BUNDLE_ID:-${PRODUCT_BUNDLE_IDENTIFIER:-}}"

# App Store Connect API credentials, so uploads do not depend on an interactive
# Xcode session. Put account-specific values in apps/mobile/.env.local rather
# than in the repository.
#
# NOTE: this authenticates the UPLOAD only. Signing still needs the Xcode account,
# or a complete manual-signing configuration in the environment.

echo "==> Building Panda Code iOS IPA"
echo "    version: $BUILD_NAME+$BUILD_NUMBER"

# Clear any previous IPA first. `flutter build ipa` can fail at the export step
# (a missing signing identity, say) while still exiting 0, and the find below
# would then happily pick up a stale IPA from an earlier run and upload THAT.
# That is not hypothetical: it shipped a 4-hour-old build to altool once.
rm -f "$APP_DIR/build/ios/ipa/"*.ipa

# Manual signing against a locally-held certificate. Xcode's automatic signing
# uses a CLOUD-MANAGED certificate whose private key lives on Apple's servers and
# is only reachable through an authenticated Xcode session — which lapsed twice in
# one evening and took the release with it. The certificate named here was minted
# through the App Store Connect API with a locally generated private key (the same
# thing Codemagic and fastlane do), so signing needs no session at all.
SIGN_IDENTITY="${SIGN_IDENTITY:-}"
PROVISIONING_PROFILE="${PROVISIONING_PROFILE:-}"

if [[ -n "$TEAM_ID" && -n "$BUNDLE_ID" && -n "$SIGN_IDENTITY" && -n "$PROVISIONING_PROFILE" ]] &&
  security find-identity -v -p codesigning | grep -qF "$SIGN_IDENTITY"; then
  echo "==> Signing manually as: $SIGN_IDENTITY"
  cat > "$APP_DIR/build/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$SIGN_IDENTITY</string>
  <key>provisioningProfiles</key>
  <dict><key>$BUNDLE_ID</key><string>$PROVISIONING_PROFILE</string></dict>
  <key>destination</key><string>export</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
  EXPORT_ARGS=(--export-options-plist "$APP_DIR/build/ExportOptions.plist")
else
  # No local certificate — fall back to Xcode's automatic (cloud) signing, which
  # is what we had before and still works whenever the Xcode session is alive.
  echo "==> No local distribution certificate; falling back to automatic signing"
  EXPORT_ARGS=(--export-method app-store)
fi

"$FLUTTER_BIN" build ipa \
  --release \
  --build-name "$BUILD_NAME" \
  --build-number "$BUILD_NUMBER" \
  "${EXPORT_ARGS[@]}"

IPA_PATH="$(find "$APP_DIR/build/ios/ipa" -maxdepth 1 -type f -name '*.ipa' -print | sort | tail -n 1)"
if [[ -z "$IPA_PATH" ]]; then
  echo "No IPA was produced under $APP_DIR/build/ios/ipa." >&2
  echo "The archive step usually succeeds and the EXPORT step fails, so scroll up" >&2
  echo "for 'exportArchive' errors. The common cause is a missing signing identity:" >&2
  echo "  security find-identity -v -p codesigning | grep Distribution" >&2
  echo "If nothing lists there, sign in at Xcode > Settings > Accounts and let" >&2
  echo "automatic signing regenerate the distribution certificate." >&2
  exit 1
fi

# Belt and braces: prove the IPA we are about to upload is the one we just asked
# for. A version mismatch means we are holding someone else's build.
IPA_BUILD="$(unzip -p "$IPA_PATH" 'Payload/*.app/Info.plist' 2>/dev/null \
  | plutil -extract CFBundleVersion raw - 2>/dev/null || true)"
if [[ -n "$IPA_BUILD" && "$IPA_BUILD" != "$BUILD_NUMBER" ]]; then
  echo "Refusing to upload: IPA reports build $IPA_BUILD but this run is $BUILD_NUMBER." >&2
  echo "That means the export did not produce a fresh IPA." >&2
  exit 1
fi

echo "==> IPA ready"
echo "$IPA_PATH"

# altool cheerfully exits 0 after a rejected upload, so `set -e` never fires and
# the caller goes on to tag a release that does not exist. Run it through here
# instead: tee the output so the user still sees progress, then fail on ERROR.
run_altool() {
  local log
  log="$(mktemp -t altool)"
  local rc=0
  "$@" 2>&1 | tee "$log" || rc=$?
  if [[ $rc -ne 0 ]] || grep -qE '^[0-9-]+ [0-9:.]+ ERROR:|Failed to upload' "$log"; then
    echo >&2
    echo "Upload FAILED. altool reported:" >&2
    grep -E 'ERROR:|Failed to upload' "$log" | head -5 >&2
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}

if [[ "$UPLOAD" == "1" ]]; then
  echo "==> Uploading to App Store Connect / TestFlight"
  if [[ -n "${APP_STORE_API_KEY_ID:-}" && -n "${APP_STORE_API_ISSUER_ID:-}" ]]; then
    echo "    auth: App Store Connect API key ($APP_STORE_API_KEY_ID)"
    run_altool xcrun altool --upload-app \
      -f "$IPA_PATH" \
      --type ios \
      --apiKey "$APP_STORE_API_KEY_ID" \
      --apiIssuer "$APP_STORE_API_ISSUER_ID" \
      --output-format normal
  elif [[ -n "${APP_STORE_USERNAME:-}" && -n "${APP_STORE_PASSWORD:-}" ]]; then
    echo "    auth: app-specific password ($APP_STORE_USERNAME)"
    run_altool xcrun altool --upload-app \
      -f "$IPA_PATH" \
      -u "$APP_STORE_USERNAME" \
      -p "$APP_STORE_PASSWORD" \
      --output-format normal
  else
    echo "--upload requires either:" >&2
    echo "  APP_STORE_API_KEY_ID + APP_STORE_API_ISSUER_ID (API key, preferred), or" >&2
    echo "  APP_STORE_USERNAME + APP_STORE_PASSWORD (app-specific password)." >&2
    exit 2
  fi
fi

if [[ "$OPEN_TRANSPORTER" == "1" ]]; then
  if [[ -d "/Applications/Transporter.app" ]]; then
    echo "==> Opening in Transporter"
    open -a Transporter "$IPA_PATH"
  else
    echo "Transporter.app not found. Opening IPA folder instead."
    open "$(dirname "$IPA_PATH")"
  fi
fi
