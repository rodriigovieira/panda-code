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
