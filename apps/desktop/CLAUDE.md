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
- **Check the `[relay]` line the build prints.** The relay URL is baked into the
  bundle at build time; a build without it disables phone pairing entirely and
  shows up as "Mac offline" on iOS with no error anywhere on the desktop. The
  build resolves it from `PANDA_CODE_RELAY_URL`, else from `CONVEX_URL` in the
  gitignored `convex-relay/.env.local`. If it prints `no relay URL` on a machine
  that pairs with a phone, stop and fix that before syncing — never hardcode the
  URL in tracked files.
- Sync with `rsync` (or `ditto`), never by deleting `/Applications/Panda Code.app`
  first — replacing in place avoids disturbing the running instance.
- Leave any open Panda Code window running; the user relaunches on their own schedule.
