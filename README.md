# Panda Code

A macOS app for running [Claude Code](https://claude.com/claude-code) and Codex
sessions as persistent, threaded sections — with an optional phone companion for
when you step away from your desk.

**It runs entirely on your Mac.** No account, no sign-up, no server, nothing
uploaded. Your sessions live in your own filesystem and never leave it.

---

## Install

Download the latest build from [Releases](../../releases), or build from source:

```sh
git clone https://github.com/rodriigovieira/panda-code.git
cd panda-code
pnpm install
pnpm --dir apps/desktop package:mac
```

The app lands in `apps/desktop/release/mac-arm64/`. Drag it to `/Applications`.

### Requirements

- macOS on Apple Silicon
- Node 22+ and `pnpm` (to build from source)
- The [Claude Code](https://claude.com/claude-code) CLI (`claude`) and/or the
  Codex CLI (`codex`) installed and on your `PATH`. Panda Code runs them; it does
  not bundle them, and you use your own account with them.

### For Coding Agents

Agents should start with [AGENTS.md](AGENTS.md). The short version:

```sh
pnpm install
pnpm typecheck
pnpm test
```

Flutter is separate from the pnpm workspace:

```sh
cd apps/mobile
flutter pub get
flutter analyze
flutter test
```

---

## What it does

- Runs multiple Claude Code / Codex sessions at once, each as its own thread
- Keeps them alive in the background and surfaces the one that needs you
- Renders the transcript as structured conversation rather than raw terminal
  output — tool calls, diffs, approvals, and nested subagents as their own cards
- Tracks token spend per session and over time
- Stays out of the way in the menu bar

---

## The optional phone companion

If you want to check on a long-running session from your phone — approve a tool
call, send a follow-up, see what it did — there's a Flutter companion app.

This part needs a relay: a small server your Mac and phone both connect to. **You
run your own.** We don't operate one, and there's no hosted option.

The relay is a [Convex](https://convex.dev) deployment (free tier is far more than
enough) that acts as a dumb pipe. Your Mac and phone establish a shared key by
scanning a QR code; that key never reaches the relay, so everything carrying
content — prompts, output, session titles, working directories — is encrypted
before it's sent.

**What your relay can still see**, because it needs it to route messages and let
your phone render a session list without decrypting anything:

- Event timing and counts
- Coarse status: running, idle, errored, waiting on you
- Command *types* — that you approved something, never what
- Device names, platform, app version, and which phone is paired to which Mac
- Your push notification token, if you enable notifications

Since it's your deployment, all of that is visible only to you. That's the point
of self-hosting rather than trusting someone else's relay.

Setup walkthrough: **[docs/self-hosting.md](docs/self-hosting.md)**
Wire protocol and crypto details: **[docs/protocol.md](docs/protocol.md)**
Landing page: **[docs/index.html](docs/index.html)**

---

## Layout

| Path | Stack | Role |
|---|---|---|
| `apps/desktop` | Electron + TS | The app. Runs the CLIs, keeps sessions alive. |
| `apps/mobile` | Flutter | Optional phone companion. |
| `convex-relay` | Convex (TS) | Optional relay. Ciphertext only. |
| `packages/design-tokens` | JSON + codegen | Design tokens, shared by both UIs. |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

This repository is a mirror — development happens in a private monorepo and is
published here in snapshots. Pull requests are welcome and get applied upstream,
then appear in the next sync (possibly as part of a larger commit rather than
with your original hash — your authorship is preserved in the commit trailer).

## Licence

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

`apps/mobile/packages/convex_flutter` is a modified fork of
[convex_flutter](https://github.com/jkuldev/convex_flutter) (© 2024 jkuldev) and
keeps its original MIT licence.

Panda Code is an independent project. It runs the Claude Code and Codex CLIs as
external programs and is not affiliated with, endorsed by, or sponsored by
Anthropic or OpenAI.
