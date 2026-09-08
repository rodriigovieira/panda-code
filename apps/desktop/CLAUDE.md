# Panda Code — Desktop app

> Finishing a backlog card means getting it to **Review with evidence on it**, not
> just writing the code. The recipes for capturing that evidence — for this app
> and for every other surface in the repo — are in the root `AGENTS.md`, under
> "Evidence: How To Prove It In This Repo". The packaging steps below are the
> first half of it for desktop work.

## After finishing any change: package; stage safely, install only while stopped

Once a change is complete and verified, ALWAYS repackage the app. Do not replace
`/Applications/Panda Code.app` while it is running. Electron can spawn renderer,
GPU, utility, and webview helpers later; replacing the bundle underneath the old
main process makes those helpers come from a different build and can crash them.

```sh
cd apps/desktop
pnpm package:mac
# Safe while Panda Code is open: stages now and installs after every process exits.
pnpm sync:mac
```

Notes:
- **This is the most expensive command in the repo, and several sections reach it
  at once.** It takes the workspace lock (`scripts/with-lock.sh`), so a second
  section waits rather than thrashing an 8 GB machine — if it says it is waiting,
  let it wait. Run `pnpm machine` first to see the load and who holds the lock.
  And note that packaging builds the *working tree*, not just your change: if a
  peer section packaged after your edits landed, the release bundle already has
  them and you can skip your own run.
- `package:mac` runs `pnpm build` (typecheck + electron-vite build) then
  `electron-builder --mac dir --arm64`, so it also serves as a full typecheck gate.
- **Check the `[relay]` line the build prints.** The relay URL is only a first-run
  seed now; Settings -> Phone -> Relay URL is authoritative after launch. The
  build seed resolves only from explicit `PANDA_CODE_RELAY_URL`. If it prints
  `no relay URL seed`, the app still works and can be pointed at a relay from
  Settings — never hardcode the URL in tracked files.
- `sync:mac` never writes into the live bundle. While Panda Code is open it
  copies the build to a separate verified staging bundle and registers a
  per-user installer that waits for every installed-app process to exit before
  swapping it into place. When Panda Code is already closed, it performs the
  same verified swap immediately. Never bypass this with a direct `rsync` or
  `ditto` into `/Applications/Panda Code.app`.
- Leave an open Panda Code window running and report that the staged update will
  install after the user's quit, before their next relaunch.
