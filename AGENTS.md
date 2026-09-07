# Panda Code Agent Setup

This repository is a squashed public mirror of the Panda Code monorepo. Keep
changes small, preserve the local-first desktop path, and do not introduce hosted
service assumptions unless the change is explicitly about the optional relay.

## Quick Start

```sh
pnpm install
pnpm typecheck
pnpm test
```

The Flutter app is managed outside the pnpm workspace:

```sh
cd apps/mobile
flutter pub get
flutter analyze
flutter test
```

## Surfaces

- `apps/desktop`: Electron app. This is the primary product and must run without
  a relay.
- `convex-relay`: optional self-hosted Convex relay. Tests run in-process with
  `convex-test`; do not require a live deployment for normal PR validation.
- `apps/mobile`: optional Flutter companion for a relay the user owns.
- `packages/design-tokens`: shared design token source and generated outputs.
- `docs/protocol.md`: pairing, crypto, and relay wire contract.
- `docs/self-hosting.md`: end-user relay setup.

## Local Desktop Development

```sh
pnpm --dir apps/desktop dev
```

This starts local-only mode. Leave `PANDA_CODE_RELAY_URL` unset unless you are
working on phone pairing.

To test relay pairing against your own Convex deployment:

```sh
PANDA_CODE_RELAY_URL=https://your-deployment.convex.cloud pnpm --dir apps/desktop dev
```

The URL is build-time configuration. Finder-launched macOS apps do not inherit
your shell environment, so package with the same variable when testing pairing in
a bundle.

## Relay Development

```sh
pnpm --dir convex-relay exec convex codegen
pnpm --dir convex-relay test
pnpm --dir convex-relay typecheck
```

The generated files in `convex-relay/convex/_generated/` are committed because
the relay will not typecheck from a fresh clone without them. Regenerate them
after changing `convex-relay/convex/schema.ts` or exported Convex functions.

Only run `pnpm --dir convex-relay exec convex dev` when you need a real
self-hosted deployment. Convex writes deployment details to
`convex-relay/.env.local`; never commit that file.

## Mobile Development

```sh
cd apps/mobile
flutter pub get
flutter run
```

The mobile app uses the checked-in `packages/convex_flutter` fork. Do not replace
it with the upstream pub package unless you are deliberately updating the fork and
its notice.

iOS device builds require local Apple signing configuration. Keep real team IDs,
bundle IDs, provisioning profiles, `.p8` keys, and App Store credentials out of
the repository.

## Security Rules

- Do not commit `.env`, `.env.local`, signing files, private keys, app-store keys,
  relay deployment URLs, access tokens, or machine-specific absolute paths.
- Keep examples generic: `https://your-deployment.convex.cloud`,
  `/Users/example/...`, and placeholder IDs only.
- Panda Code runs `claude` and `codex` as external CLIs. Do not vendor, wrap, or
  imply affiliation with Anthropic or OpenAI beyond factual compatibility.
- Any field carrying user content through the relay must remain encrypted. If a
  new plaintext relay field is needed for routing, document the trade-off in
  `docs/protocol.md` and `convex-relay/convex/schema.ts`.

## Shared Machine: One Heavy Check At A Time

Several agent sections work in this checkout at once, on one developer laptop.
The expensive commands here — `typecheck`, `build`, `test`, `package:mac` — each
fan out to a compiler per package, and two of them running together do not take
twice as long, they thrash: the machine swaps, every section slows down, and the
desktop app the sections are editing can stall or die.

So those scripts take a workspace-wide lock (`scripts/with-lock.sh`). You do not
have to do anything: run `pnpm typecheck` as normal. If another section is
already running one, yours waits its turn and says so — that wait is the feature,
not a hang, and total time is lower than racing.

Two habits still matter, because the lock makes checks serial, not free:

- **Scope the check to what you touched.** `pnpm --dir apps/desktop typecheck`
  instead of the whole workspace; `pnpm --dir convex-relay test` instead of
  `pnpm test`. Run the workspace-wide sweep only for shared contracts.
- **Look before you queue a big one.** `pnpm machine` prints who holds the lock
  and what the machine is doing — load average, free memory, swap, heaviest
  processes. If free memory is low or something big is mid-run, prefer the cheap
  scoped check, and leave `package:mac` for when the box is calmer.

Wrap any other long command in the same lock if you add one:

```sh
scripts/with-lock.sh <command>
```

## Before Submitting

Run the smallest relevant checks, then the broad checks if you touched shared
contracts:

```sh
pnpm typecheck
pnpm test
cd apps/mobile && flutter analyze && flutter test
```

For changes to the public mirror flow, also run:

```sh
scripts/publish-oss.sh --self-test
scripts/publish-oss.sh --worktree
```

## Evidence: How To Prove It In This Repo

Work on a backlog card is finished when it reaches **Review** with evidence on
it, not when the code is written. Panda Code enforces the bar itself — an agent
moving a card to Done with no `verificationNotes` and no attachments is rejected,
and Done is the user's move once they have looked. What Panda Code cannot know is
*how* to get that evidence here. That is this section.

Write what you actually ran and what it actually printed. Paste real output, not
a summary of it, and say plainly what you did **not** check.

**Desktop (`apps/desktop`)** — a change nobody has seen run is not verified.
Package it, then install only after Panda Code has fully quit:

```sh
pnpm --dir apps/desktop typecheck
cd apps/desktop && pnpm package:mac
pnpm sync:mac # refuses while Panda Code is running
```

Never replace the running app bundle or quit it from an agent section (see
`apps/desktop/CLAUDE.md`). Report that the packaged build awaits the user's
quit/install/relaunch. For a UI
change, attach a screenshot; `browser_screenshot` covers anything reachable in
the built-in browser, and for the Electron chrome itself a macOS screen capture
of the running app is the evidence. When you genuinely cannot get a picture — the
change is in the main process, or it only shows on a relaunch the user has not
done yet — grep the packaged release bundle for the strings you added and paste that:

```sh
grep -ac "someNewSymbol" "apps/desktop/release/mac-arm64/Panda Code.app/Contents/Resources/app.asar"
```

`-a` matters: without it grep treats the asar as binary and silently reports
nothing, which reads exactly like a failed build.

**Relay (`convex-relay`)** — the deployment is the proof, not the local types.
Ship with `convex dev --once` to the development deployment configured in
your local environment and then query it, pasting the command and its response:

```sh
pnpm --dir convex-relay test
npx convex run <module>:<function> '{"...": "..."}'
```

**Mobile (`apps/mobile`)** — `flutter` is not on `PATH`; the SDK lives at
`~/flutter/bin`. Analyzer and tests are the floor, a simulator screenshot is the
evidence for anything with pixels, and a TestFlight build number is what proves
it shipped:

```sh
export PATH="$HOME/flutter/bin:$PATH"
flutter analyze && flutter test
./apps/mobile/scripts/deploy.sh patch   # → TestFlight; note the version+build
```

`deploy.sh` takes no lock and races itself — never run two at once, and check the
exit code rather than trusting the "Uploaded" line.

**Anything shared (`apps/desktop/src/shared`, protocol, schema)** — the test run
is the evidence. Name which tests are new and paste the count:

```sh
pnpm --dir apps/desktop test
```

Claims that are not evidence, and get sent back: "it compiles", "tests pass"
with no output, "this should work", and a screenshot of code rather than of the
thing running.
