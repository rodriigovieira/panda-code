# Security

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

- **GitHub:** use [Report a vulnerability](../../security/advisories/new)

Please include what you found, how to reproduce it, and what an attacker could do
with it. A proof of concept helps a lot.

**What to expect:** an acknowledgement within a few days, and an honest answer
about whether and when it will be fixed. This is a small project maintained by one
person — there is no bounty programme and no formal SLA. Valid findings get credit
in the release notes unless you'd rather stay anonymous.

Please give a reasonable window to ship a fix before disclosing publicly.

## Threat model

Panda Code runs an AI coding agent on your machine with your permissions, and
optionally relays that session to your phone. Two things follow from that.

### The desktop app

By default the app is **local-only** — no relay is configured, nothing leaves your
Mac, and there is no account or server involved. In that mode the security surface
is the same as any local developer tool: it can read and write what your user can,
and it runs the `claude` / `codex` CLIs with the permissions you grant them.

The app does make one outbound request in normal use, to
`api.anthropic.com` for plan usage figures, authenticated with the credentials the
Claude CLI already stores locally. Nothing else phones home.

### The relay (optional, self-hosted)

The relay is designed to be **untrusted**. It is a Convex deployment you own,
carrying end-to-end encrypted traffic between your Mac and your phone.

- The symmetric key is exchanged out-of-band, inside the pairing QR code, and is
  never transmitted to or stored by the relay
- Every field carrying user content is a ciphertext blob (`*Cipher`)
- Bearer tokens are stored as salted PBKDF2-SHA256 digests, never in the clear
- Reads are scoped by device: a client can only ever see its own device's data
- Pairing codes are single-use, high-entropy, and expire after five minutes

**Routing metadata is deliberately in the clear** so the phone can render a
session list without decrypting: event timing and counts, coarse session status,
command types, device names, and push tokens. This is a documented trade-off, not
an oversight — see the schema comments in `convex-relay/convex/schema.ts`. Since
you own the deployment, this metadata is visible only to you.

### Things we already know

Reports on these are still welcome — especially if you can show impact beyond what
is described — but they are known and intentional:

- **Metadata visible to the relay operator**, as above.
- **`pairing:registerDevice` is unauthenticated.** Any caller can create a device
  row. This is correct for a self-hosted single-user relay. It cannot read
  anyone's data; the cost exposure it created is bounded by the per-device write
  budget on `sessions:appendEvents`.
- **The app runs arbitrary code you asked it to run.** Panda Code drives coding
  agents that edit files and run commands. That is the product, not a bug.

## Scope

In scope: this repository's code — the desktop app, the relay functions, the
mobile client, and the pairing/crypto protocol.

Out of scope: vulnerabilities in Claude Code, Codex, Convex, Electron, or Flutter
themselves (report those upstream), and anything requiring physical access to an
already-unlocked machine.
