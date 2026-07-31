#!/usr/bin/env bash
set -euo pipefail

# One-command release for Panda Code mobile: bump the version, build a signed
# App Store IPA, upload it to TestFlight, then commit + tag the release.
#
# Thin wrapper around scripts/testflight.sh (which owns the build + upload).
# Four modes:
#   major   1.2.3 -> 2.0.0   breaking / big release
#   minor   1.2.3 -> 1.3.0   features
#   patch   1.2.3 -> 1.2.4   fixes
#   build   1.2.3 -> 1.2.3   SAME marketing version, new build — push another
#                            TestFlight build of a version already in flight
#
# The build number (CFBundleVersion) is always a fresh timestamp. Apple requires
# it to increase monotonically within a marketing version, so a timestamp is
# what lets "build" mode re-push the same version as many times as needed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBSPEC="$APP_DIR/pubspec.yaml"

usage() {
  cat <<'EOF'
Usage:
  apps/mobile/scripts/deploy.sh <major|minor|patch|build> [--no-git] [--dry-run]

Bumps the version, builds a signed IPA, uploads to TestFlight, and (unless
--no-git) commits the bump and tags the release.

Modes:
  major   X.Y.Z -> (X+1).0.0
  minor   X.Y.Z -> X.(Y+1).0
  patch   X.Y.Z -> X.Y.(Z+1)
  build   X.Y.Z -> X.Y.Z      same version, new build number only

Options:
  --no-git    Skip the release commit + tag.
  --dry-run   Print the computed version and stop (no build/upload/git).
  -h, --help  Show this help.

Upload auth comes from apps/mobile/.env.local (App Store Connect API key), the
same file scripts/testflight.sh reads.
EOF
}

MODE=""
DO_GIT=1
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    major|minor|patch|build) MODE="$1"; shift ;;
    --no-git) DO_GIT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "error: a mode is required (major|minor|patch|build)" >&2
  usage >&2
  exit 2
fi

# Current version is NAME+BUILD, e.g. 1.0.2+202607160208.
CURRENT="$(awk '/^version: / { print $2; exit }' "$PUBSPEC")"
NAME="${CURRENT%%+*}"
IFS='.' read -r MAJOR MINOR PATCH <<<"$NAME"
if ! [[ "$MAJOR" =~ ^[0-9]+$ && "$MINOR" =~ ^[0-9]+$ && "$PATCH" =~ ^[0-9]+$ ]]; then
  echo "error: could not parse semver from pubspec version '$CURRENT'" >&2
  exit 1
fi

case "$MODE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  build) : ;; # marketing version unchanged
esac
NEW_NAME="${MAJOR}.${MINOR}.${PATCH}"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
NEW_VERSION="${NEW_NAME}+${BUILD_NUMBER}"

echo "==> Release mode: $MODE"
echo "    $CURRENT  ->  $NEW_VERSION"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "(dry run) stopping before build."
  exit 0
fi

# Bump pubspec now so the build embeds the new version; restore it if the
# build/upload fails so an aborted run leaves the tree untouched.
restore_pubspec() {
  /usr/bin/sed -i '' -E "s/^version: .*/version: ${CURRENT}/" "$PUBSPEC"
  echo "==> Build/upload failed — restored pubspec version to $CURRENT."
}
/usr/bin/sed -i '' -E "s/^version: .*/version: ${NEW_VERSION}/" "$PUBSPEC"
trap restore_pubspec ERR

"$SCRIPT_DIR/testflight.sh" --upload \
  --build-name "$NEW_NAME" \
  --build-number "$BUILD_NUMBER"

trap - ERR
echo "==> Uploaded $NEW_VERSION to TestFlight."

if [[ "$DO_GIT" == "1" ]]; then
  if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    TAG="mobile-v${NEW_VERSION}"
    # ONLY the version bump. This used to be `add -A -- "$APP_DIR"`, which swept
    # every uncommitted file under apps/mobile into the release commit — someone
    # else's in-flight work included, buried under a message that says nothing
    # but "release". A release commit should contain the release and nothing else.
    git -C "$APP_DIR" add -- "$PUBSPEC"
    git -C "$APP_DIR" commit -m "chore(mobile): release ${NEW_NAME} (${BUILD_NUMBER})" >/dev/null
    git -C "$APP_DIR" tag -a "$TAG" -m "Panda Code mobile ${NEW_VERSION}"
    echo "==> Committed and tagged $TAG"
    echo "    Push with: git push && git push origin $TAG"
  else
    echo "!! Not a git repo — skipping commit + tag."
  fi
fi

echo "==> Done. $NEW_VERSION is processing in App Store Connect / TestFlight."
