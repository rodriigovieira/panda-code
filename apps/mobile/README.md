# apps/mobile — Panda Code companion (Flutter)

Cross-platform companion. Pairs with your Mac, triggers Claude Code / Codex
sessions, and renders live encrypted state pulled from a relay you own.

## Setup

The app is checked in with its iOS and Android project files. From the repo root,
install the JS workspace first if you plan to run the relay or desktop too:

```sh
pnpm install
```

Then install Flutter packages and run the app:

```sh
cd apps/mobile
flutter pub get
flutter run
```

The mobile app uses the checked-in `packages/convex_flutter` fork. Do not replace
it with the upstream pub package unless you are deliberately updating that fork.
Its upstream MIT license is retained in `packages/convex_flutter/LICENSE` and
called out in the root `NOTICE`.

## Relay Configuration

The phone companion only works with a self-hosted relay. Follow
`docs/self-hosting.md` from the repo root to create a Convex deployment, build the
desktop app with `PANDA_CODE_RELAY_URL`, and pair by scanning the desktop QR code.

The relay URL and encryption key are learned during pairing; do not hard-code
private deployment URLs in the mobile source.

## iOS Signing

Local device builds require your own Apple signing setup. Keep real team IDs,
bundle IDs, provisioning profiles, App Store API keys, `.p8` files, and
`apps/mobile/.env.local` out of git.

The checked-in Xcode config carries empty placeholders:

```text
PANDA_TEAM_ID =
PANDA_BUNDLE_ID =
```

Set your real values locally through Xcode or a gitignored signing config.

## Checks

```sh
cd apps/mobile
flutter analyze
flutter test
```

## Structure to build (see docs/protocol.md)

- `lib/relay/` — Convex client wiring (deployment URL, mobile token), typed calls
  to `pairing.claimCode`, `commands.enqueue`, `sessions.list/tail`, `devices.status`.
- `lib/crypto/` — the E2E envelope (`pinenacl`, XSalsa20-Poly1305). MUST pass the
  cross-language interop test in docs/protocol.md §3.
- `lib/pairing/` — QR scan (`mobile_scanner`) → extract `{url, deviceId, code, k}`,
  claim, persist `k` in `flutter_secure_storage`.
- `lib/sessions/` — list, session view, tail subscription with a seq cursor,
  conversation rendering (`flutter_markdown`), prompt input + stop.
