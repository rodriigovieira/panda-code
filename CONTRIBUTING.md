# Contributing

Thanks for looking. A few things worth knowing before you spend time.

## This repo is a mirror

Development happens in a private monorepo and is published here in snapshots. That
has two consequences:

- **Commit history here is squashed**, so this repo's history won't match what you
  see in a `git log` upstream.
- **Merged PRs get applied upstream and appear in the next sync**, possibly folded
  into a larger commit rather than preserved as your original hash. Your authorship
  is preserved in the commit trailer, but don't be alarmed if your commit SHA
  doesn't survive.

If that model doesn't work for you, that's completely fair — please still open an
issue describing the problem, and it'll get fixed upstream.

## Before you build something big

Open an issue first. This is a small, opinionated project with a specific idea of
what it wants to be, and it would be a waste of your evening to write a feature
that gets declined on scope. Bug fixes and small improvements need no
pre-discussion — just send them.

## Developer Certificate of Origin

Contributions are accepted under the [DCO](https://developercertificate.org/): a
statement that you wrote the patch, or otherwise have the right to submit it under
this project's licence. Sign off your commits with:

```sh
git commit -s -m "your message"
```

which appends a `Signed-off-by:` trailer. That's all — there's no CLA to sign and
no copyright assignment.

Contributions are licensed under Apache-2.0, the same as the rest of the project.

## Setup

```sh
pnpm install
pnpm typecheck
pnpm test
```

Per-surface:

```sh
pnpm --dir apps/desktop dev          # the Electron app, local-only mode
pnpm --dir convex-relay exec vitest  # relay function tests, fully in-process
cd apps/mobile && flutter run        # the phone companion
```

Note that the desktop app runs **without a relay by default** — that's the
supported configuration for most development. You only need a Convex deployment if
you're working on the phone companion or the relay itself; see
[docs/self-hosting.md](docs/self-hosting.md).

## Conventions

- **Match the surrounding code.** This codebase is heavily commented, and the
  comments explain *why*, not *what*. If you change something with a non-obvious
  reason behind it, say what the reason is.
- **The relay's cost model is load-bearing.** Several structural decisions in
  `convex-relay` exist to keep reactive queries from re-firing on the streaming
  hot path — the table splits are not arbitrary. The schema comments explain each
  one. Please read them before adding a field or a query.
- **Tests** live next to what they test. The relay has a full in-process suite
  (`convex-test`), so relay changes should come with coverage.
- Typecheck and tests should pass before you open the PR.

## Reporting bugs

Include your macOS version, whether a relay is configured, and the relevant part
of the debug log (Settings → open debug log). If it involves a session, note which
CLI (`claude` or `codex`) and roughly what it was doing.

Security issues go to [SECURITY.md](SECURITY.md), not the issue tracker.
