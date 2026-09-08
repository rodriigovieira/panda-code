---
name: review-evidence
description: Capture scenario-based review evidence for Panda Code backlog cards, including honest environment, outcome, evidence links, and coverage gaps. Use when handing implementation work to Review.
---

# Review Evidence

Use the project’s own `AGENTS.md` or `CLAUDE.md` for commands, devices, credentials, and build setup. This skill defines the reusable evidence shape, not project-specific execution.

## Build the scenario

Record one scenario for each materially different behavior. Include:

- Setup: environment, relevant configuration, build or revision.
- Actions: what was executed, including save/reload or cancel/reopen where persistence matters.
- Expected outcome.
- Actual outcome: `passed`, `failed`, `blocked`, or `not_run`.
- Verification type: `live_e2e`, `mocked`, `renderer_only`, `installed_app`, `api`, `unit`, or another precise label.
- Evidence: existing card attachment IDs or actual command/request output.
- Coverage limits: what this attempt does not establish.

Append attempts; do not overwrite history. The latest attempt is the current result, while older failures and blocked runs remain useful context.

## Choose evidence that proves the behavior

- User-facing flow: execute it in the real surface when authorized, capture a short recording, and add screenshots for state that is hard to inspect in motion.
- Static visual change: capture the relevant sizes and themes.
- Backend/API: include the executed request or test output and inspect the resulting state.
- Pure logic: run targeted behavioral tests and include their actual output.
- Blocked: name the specific blocker and state exactly what remains unverified.

A video shows that actions occurred; it does not by itself establish correctness. An attachment is an artifact until a scenario or verification note says what it demonstrates. Never present mocked, renderer-only, or unit coverage as live E2E.

## Hand off

Move the card to Review, not Done. Add the scenario with `backlog_verify` or `panda-peers backlog verify`, attach files to the originating card, and link Epic-level summaries back to those cards instead of copying their attachments or verification prose.

For a substantial visual change, a UI/UX reviewer subthread is optional. Give it the concrete flow and acceptance criteria. The implementing section still owns evidence, and an unavailable reviewer is recorded as a gap rather than blocking an honest Review handoff.
