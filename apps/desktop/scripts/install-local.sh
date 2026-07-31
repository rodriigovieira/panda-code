#!/usr/bin/env bash
set -euo pipefail

# Swap the freshly packaged app into /Applications and relaunch it.
#
# Separate from `package:mac` on purpose: this quits the running Panda Code,
# which kills every session it is hosting (including any agent that would be
# running this script). Build first, then run this by hand.

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/release/mac-arm64/Panda Code.app"
DEST="/Applications/Panda Code.app"

[[ -d "$SRC" ]] || { echo "No build at $SRC — run pnpm --dir apps/desktop package:mac first." >&2; exit 1; }

echo "==> Quitting Panda Code"
osascript -e 'quit app "Panda Code"' 2>/dev/null || true
for _ in $(seq 1 20); do
  pgrep -f "/Applications/Panda Code.app/Contents/" >/dev/null || break
  sleep 0.5
done

if pgrep -f "/Applications/Panda Code.app/Contents/" >/dev/null; then
  echo "Panda Code is still running. Quit it fully, then rerun this script." >&2
  exit 1
fi

echo "==> Installing $SRC -> $DEST"
rm -rf "$DEST"
ditto "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

src_hash="$(shasum -a 256 "$SRC/Contents/Resources/app.asar" | awk '{print $1}')"
dest_hash="$(shasum -a 256 "$DEST/Contents/Resources/app.asar" | awk '{print $1}')"
if [[ "$src_hash" != "$dest_hash" ]]; then
  echo "Install verification failed: installed app.asar does not match the build." >&2
  echo "source: $src_hash" >&2
  echo "dest:   $dest_hash" >&2
  exit 1
fi

echo "==> Relaunching"
open "$DEST"
