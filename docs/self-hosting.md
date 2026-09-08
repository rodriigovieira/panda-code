# Self-hosting the Panda Code relay

**You do not need this to use Panda Code.** The desktop app is complete on its own:
it runs your `claude` and `codex` sessions locally, stores everything on your Mac,
and requires no Panda Code account or relay server. Model providers still receive
the prompts and context you send through their CLIs or the optional Groq runtime.

You need this page only if you want the **optional** extra: controlling your
sessions from your phone. That works by running a small relay of your own — a
Convex deployment that your Mac and your phone both connect to. It is yours; it is
free at this scale; and it never sees your session content in plaintext.

---

## What the relay actually does

```
 ┌──────────────┐    encrypted     ┌──────────────┐    encrypted    ┌──────────────┐
 │  your phone  │  ───commands───▶ │  your relay  │ ───commands───▶ │   your Mac   │
 │              │  ◀──snapshots─── │   (Convex)   │ ◀──events─────  │  (desktop)   │
 └──────────────┘                  └──────────────┘                 └──────────────┘
```

Your Mac and phone share a symmetric key established by scanning a QR code. That
key never touches the relay — it is exchanged out-of-band, inside the QR image
itself. Everything carrying content (prompts, output, titles, working directories)
is encrypted before it is sent, so the relay only ever moves opaque blobs.

**What the relay can still see**, because it needs it to route and to render your
session list without decrypting anything:

- Timing — when events happen and how many, at per-event resolution
- Coarse status — whether a session is running, idle, errored, or waiting on you
- Command *types* — that you approved or denied something, never *what*
- Device names, platform, app version, and which phone is paired to which Mac
- Your APNs push token, if you enable notifications

Since you own the deployment, this is all visible only to you. That is the entire
reason to self-host rather than use someone else's relay.

---

## Setup

### 1. Create your Convex deployment

Convex's free tier is far above what a personal relay uses.

```sh
git clone <this repo>
cd panda-code
pnpm install

cd convex-relay
pnpm exec convex dev
```

That command is interactive on first run. It will:

1. Open a browser to sign you in (GitHub or Google)
2. Ask you to create a project — name it anything, e.g. `panda-code-relay`
3. Push the schema and functions to your new deployment
4. Write your deployment URL into `convex-relay/.env.local`

When it finishes, grab your URL — it looks like
`https://<something>-<something>-123.convex.cloud`. You can always find it again
in the Convex dashboard, or in `convex-relay/.env.local`.

Leave `convex dev` running while you set up, or re-run `pnpm exec convex dev --once`
any time you pull changes that touch the relay.

### 2. Point the desktop app at it

Launch Panda Code and open Settings -> Phone. Paste your Convex deployment URL
into Relay URL:

```sh
https://your-deployment.convex.cloud
```

Downloaded builds, source builds, and packaged `.app` bundles all use the same
setting. You can set `PANDA_CODE_RELAY_URL` before `dev` or `package:mac` to seed
the field on first run, but the saved Settings value wins after launch.

> With the Relay URL empty, the app builds and runs in fully local mode. That is
> the default and it is a supported configuration, not a broken one — the pairing
> panel simply says phone pairing is off.

Before a new desktop can register, Settings shows an owner-enrollment command.
Run that exact `pairing:authorizeDevice` command from your authenticated Convex
CLI in `convex-relay`, using the fingerprint from **your own Mac**. Enrollment
expires after 15 minutes and is consumed once. Do not approve fingerprints sent
by strangers. The URL alone no longer permits new devices to register.

When upgrading a relay that previously allowed public registration, audit its
`devices` table in the owner dashboard. Existing registrations are preserved;
remove any you do not recognize. The enrollment gate prevents new unapproved
registrations but does not retroactively establish trust in old rows.

Upgrade the relay, Mac and phone together for the current command protocol.
Older phones cannot control an updated Mac. Revoking a phone immediately blocks
that phone and removes its command identity; other paired phones remain active.
Re-pair only the revoked phone if it should regain access. Local desktop data is
preserved.

### 3. Build the mobile app

This is the step with real friction, and it is unavoidable: Apple does not let you
install an iOS app on your own phone without an Apple Developer account and Xcode.
There is no prebuilt download, because a build signed by us could not talk to a
relay owned by you.

```sh
cd apps/mobile
flutter pub get
```

Set your signing identifiers (see `apps/mobile/scripts/testflight.sh` for the full
list) and build to your device from Xcode or `flutter run`.

### 4. Pair

1. Open the desktop app → Settings → the pairing panel
2. It shows a QR code, valid for 5 minutes, usable once
3. Scan it with the mobile app

The QR carries the relay URL, a one-time pairing code, and the encryption key. After
this, your phone and Mac share a key the relay does not have.

---

## Push notifications (optional, iOS only)

Notifications need an Apple Push Notification key, configured as environment
variables on **your** Convex deployment:

```sh
cd convex-relay
pnpm exec convex env set APNS_KEY_ID <your key id>
pnpm exec convex env set APNS_TEAM_ID <your team id>
pnpm exec convex env set APNS_BUNDLE_ID <your app bundle id>
pnpm exec convex env set APNS_PRIVATE_KEY "$(cat AuthKey_XXXXX.p8)"
```

Two failure modes here are silent, so check them first if notifications never arrive:

- **A truncated private key.** Use the `"$(cat ...)"` form above so the newlines
  survive. A key pasted without them fails to parse and the send is dropped.
- **Sandbox vs production token mismatch.** A development build registers a sandbox
  token, which the production APNs endpoint rejects. Make sure the build type and
  the endpoint agree.

Notification bodies are deliberately generic ("A session needs your attention")
because the relay cannot read your session content to say anything more specific.

---

## Costs

A personal relay running a handful of sessions sits inside Convex's free tier. The
protocol was built to keep it there — the desktop streams small encrypted deltas
against a sequence cursor rather than re-uploading conversation state, and the
per-tick fields live in tables the session-list query deliberately does not read.
See `docs/protocol.md` for the reasoning.

If you do want to watch usage, the Convex dashboard breaks down function calls and
database bandwidth per deployment.

---

## Turning it off

Delete the deployment in the Convex dashboard, then clear Settings -> Phone ->
Relay URL. The app returns to fully local mode with your sessions intact — they
live on your Mac and were never dependent on the relay.
