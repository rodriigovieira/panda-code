# apps/desktop — Panda Code (Electron executor)

The Panda Code Electron executor runs local Claude Code sessions and — when a
relay is configured — mirrors encrypted structured session updates to it.

## Running it

By default this is a **fully local app**: no relay, no account, nothing uploaded.

```sh
pnpm install
pnpm --dir apps/desktop dev
```

The relay is opt-in. To enable phone pairing, open Settings -> Phone and paste
the Convex deployment URL for a relay you own (see
[docs/self-hosting.md](../../docs/self-hosting.md)):

You can still set `PANDA_CODE_RELAY_URL` before `dev` or `package:mac` to seed
that field on first run. After launch, the saved Settings value wins, including
when it is empty. Open Settings -> Phone to scan or refresh the five-minute
pairing QR.
Device credentials and the 32-byte E2E key are stored as generic passwords in
macOS Keychain.

The `src/main/remote/` module:

- opens a long-lived headless Convex client against `convex-relay`,
- subscribes to `commands.pending` and dispatches into the existing session logic,
- taps the `sendToLiveWindows()` choke point (`src/main/index.ts:195`) to mirror
  encrypted deltas up via `sessions.appendEvents` / `sessions.upsertSession`,
- heartbeats + registers the device + renders the pairing QR.

The one prerequisite refactor: extract the bodies of the `ipcMain.handle(...)`
session handlers into a plain `sessionService` so the IPC layer AND the remote
bridge call the same code. See the root README and `docs/protocol.md`.

## Checks

```sh
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop test
pnpm --dir apps/desktop package:mac
```
