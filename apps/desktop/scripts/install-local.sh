#!/usr/bin/env bash
set -euo pipefail

# Never copy over a running Electron bundle: the existing main process may spawn
# helpers from the newly replaced Framework/app.asar and mix generations. A
# completed build is copied to a separate bundle first, then swapped into place
# only after every process from the installed app has exited.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
SRC="$(cd "$SCRIPT_DIR/.." && pwd)/release/mac-arm64/Panda Code.app"
DEST="/Applications/Panda Code.app"
PENDING="/Applications/.Panda Code.pending.app"
BACKUP="/Applications/.Panda Code.previous.app"
JOB_LABEL="dev.pandacode.install-local.${UID}"
PROCESS_PATTERN='^/Applications/Panda Code[.]app/Contents/'

bundle_hash() {
  shasum -a 256 "$1/Contents/Resources/app.asar" | awk '{print $1}'
}

app_is_running() {
  pgrep -f "$PROCESS_PATTERN" >/dev/null
}

finish_install() {
  local staged="$1"
  local destination="$2"
  local expected_hash="$3"

  [[ "$staged" == "$PENDING" ]] || { echo "Refusing unexpected staged path: $staged" >&2; exit 1; }
  [[ "$destination" == "$DEST" ]] || { echo "Refusing unexpected destination: $destination" >&2; exit 1; }
  [[ -d "$staged" ]] || { echo "Staged Panda Code update is missing: $staged" >&2; exit 1; }
  [[ "$(bundle_hash "$staged")" == "$expected_hash" ]] || {
    echo "Staged Panda Code update failed verification." >&2
    exit 1
  }

  while app_is_running; do
    sleep 1
  done
  # Require two consecutive closed checks. This avoids swapping during the
  # brief gap between the main process and a late-shutting-down helper.
  sleep 1
  while app_is_running; do
    sleep 1
  done

  rm -rf "$BACKUP"
  local had_previous=false
  if [[ -e "$destination" ]]; then
    mv "$destination" "$BACKUP"
    had_previous=true
  fi
  if ! mv "$staged" "$destination"; then
    if [[ "$had_previous" == true && -e "$BACKUP" && ! -e "$destination" ]]; then
      mv "$BACKUP" "$destination"
    fi
    echo "Could not install the staged Panda Code update; the previous app was restored." >&2
    exit 1
  fi

  xattr -dr com.apple.quarantine "$destination" 2>/dev/null || true
  if [[ "$(bundle_hash "$destination")" != "$expected_hash" ]]; then
    rm -rf "$destination"
    if [[ "$had_previous" == true && -e "$BACKUP" ]]; then
      mv "$BACKUP" "$destination"
    fi
    echo "Install verification failed; the previous app was restored." >&2
    exit 1
  fi
  rm -rf "$BACKUP"
  echo "==> Installed Panda Code successfully."
}

if [[ "${1:-}" == "--finish" ]]; then
  [[ $# -eq 4 ]] || { echo "Invalid staged-install invocation." >&2; exit 1; }
  # `launchctl submit` creates a keep-alive job. Remove the job on every exit so
  # a successful one-shot install (or a permanent verification failure) cannot
  # be respawned in a loop. This also works for direct --finish invocations.
  trap 'launchctl remove "$JOB_LABEL" >/dev/null 2>&1 || true' EXIT
  finish_install "$2" "$3" "$4"
  exit 0
fi

[[ -d "$SRC" ]] || { echo "No build at $SRC — run pnpm --dir apps/desktop package:mac first." >&2; exit 1; }

src_hash="$(bundle_hash "$SRC")"

# Cancel an older waiter before refreshing its staging bundle. It cannot be in
# the swap phase while the installed app is running; when the app is already
# closed, finish synchronously instead of creating a new waiter.
launchctl remove "$JOB_LABEL" >/dev/null 2>&1 || true

echo "==> Staging $SRC -> $PENDING"
rsync -a --delete "$SRC/" "$PENDING/"
xattr -dr com.apple.quarantine "$PENDING" 2>/dev/null || true
[[ "$(bundle_hash "$PENDING")" == "$src_hash" ]] || {
  echo "Staging verification failed: staged app.asar does not match the build." >&2
  exit 1
}

if app_is_running; then
  launchctl submit -l "$JOB_LABEL" -- "$SCRIPT" --finish "$PENDING" "$DEST" "$src_hash"
  echo "==> Panda Code is running; the verified update is staged."
  echo "==> Quit Panda Code when its work finishes, wait a moment, then relaunch."
  exit 0
fi

finish_install "$PENDING" "$DEST" "$src_hash"
echo "==> Open Panda Code when ready."
