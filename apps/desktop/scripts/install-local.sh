#!/usr/bin/env bash
set -euo pipefail

# Installing over a running Electron bundle mixes generations: the existing
# main process later spawns helpers from the newly replaced Framework/app.asar.
# Package while Panda Code runs, but install only after it has fully quit.

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/release/mac-arm64/Panda Code.app"
DEST="/Applications/Panda Code.app"

[[ -d "$SRC" ]] || { echo "No build at $SRC — run pnpm --dir apps/desktop package:mac first." >&2; exit 1; }

if pgrep -f "/Applications/Panda Code.app/Contents/" >/dev/null; then
  echo "Panda Code is running; refusing to replace its Electron bundle in place." >&2
  echo "Quit Panda Code completely, then run: pnpm --dir apps/desktop sync:mac" >&2
  exit 2
fi

echo "==> Installing $SRC -> $DEST"
rsync -a --delete "$SRC/" "$DEST/"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

src_hash="$(shasum -a 256 "$SRC/Contents/Resources/app.asar" | awk '{print $1}')"
dest_hash="$(shasum -a 256 "$DEST/Contents/Resources/app.asar" | awk '{print $1}')"
if [[ "$src_hash" != "$dest_hash" ]]; then
  echo "Install verification failed: installed app.asar does not match the build." >&2
  exit 1
fi

echo "==> Installed successfully. Open Panda Code when ready."
