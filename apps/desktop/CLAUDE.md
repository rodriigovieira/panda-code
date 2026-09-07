# Panda Code — Desktop app

> Finishing a backlog card means getting it to **Review with evidence on it**, not
> just writing the code. The recipes for capturing that evidence — for this app
> and for every other surface in the repo — are in the root `AGENTS.md`, under
> "Evidence: How To Prove It In This Repo". The packaging steps below are the
> first half of it for desktop work.

## After finishing any change: package; install only while the app is stopped

Once a change is complete and verified, ALWAYS repackage the app. Do not replace
`/Applications/Panda Code.app` while it is running. Electron can spawn renderer,
GPU, utility, and webview helpers later; replacing the bundle underneath the old
main process makes those helpers come from a different build and can crash them.

```sh
cd apps/desktop
pnpm package:mac
# After the user has quit Panda Code completely:
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
- `sync:mac` refuses to run while any installed-app process remains. Never bypass
  that check with a direct `rsync` or `ditto`.
- Leave an open Panda Code window running and report that the packaged update is
  waiting for a user-controlled quit/install/relaunch.
