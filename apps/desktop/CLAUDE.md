# Panda Code — Desktop app

## After finishing any change: package and sync to /Applications

Once a change is complete and verified, ALWAYS repackage the app and sync it into
`/Applications` so the installed build stays current — **without closing the running
instance**. Do not quit or kill Panda Code; just replace the bundle in place. The
running process keeps its open file handles, so the next launch picks up the new build.

```sh
cd apps/desktop
pnpm package:mac
# electron-builder writes to release/mac-arm64/Panda Code.app
rsync -a --delete "release/mac-arm64/Panda Code.app/" "/Applications/Panda Code.app/"
```

Notes:
- `package:mac` runs `pnpm build` (typecheck + electron-vite build) then
  `electron-builder --mac dir --arm64`, so it also serves as a full typecheck gate.
- Sync with `rsync` (or `ditto`), never by deleting `/Applications/Panda Code.app`
  first — replacing in place avoids disturbing the running instance.
- Leave any open Panda Code window running; the user relaunches on their own schedule.
