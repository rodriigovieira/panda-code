# Section notification channels

Each section has three independent delivery choices:

- **Desktop notifications:** operating-system notification banners on the Mac.
- **Mobile notifications:** push notifications on a paired phone. Mobile changes
  its own subscription; the desktop's Mobile switch changes all paired phones.
- **Agent attention:** the desktop attention dialog, five-second sound, and
  foreground focus. This does not require desktop banners to be enabled.

All three can be disabled. Global pauses, phone event preferences, and OS
permissions continue to apply to automatic delivery. Agent attention is a
Mac-only delivery mechanism even when its setting is changed from mobile.

## Persistence and cross-device changes

Desktop defaults and per-section desktop/agent overrides live in the main
process's `AppPreferences.notificationChannels`. On the first renderer load,
legacy window-local defaults and overrides are migrated if the shared config is
absent. Existing config is not overwritten by that migration on later launches.
The main process persists each update and broadcasts it to desktop windows.

Mobile reads or updates desktop channels through `notification-settings`, using
its ordinary authenticated, encrypted command envelope. The inner payload is
`{ op: "get" }` or `{ op: "set", desktop?: boolean, agent?: boolean }`, with the
section ID bound by the envelope's routing. The encrypted result is
`{ settings: { desktop: boolean, agent: boolean } }`. A patch changes only named
channels, preserving other overrides. The Mac must be online for these commands;
the sheet reports failures and has a refresh action. Phone subscriptions retain
the existing relay routing-preference API and remain editable while the Mac is
offline.

## Explicit agent attention

Unsolicited agent attention follows the section's Agent attention setting and
global pause. An explicit user request to use agent attention is allowed even
when these are disabled. The agent expresses that exception through
`request_attention` with `userRequested: true`, or `panda-peers attention` with
`--user-requested`. The injected agent instructions reserve the exception for
an actual user request; ordinary task completion does not imply permission.
The flag affects notification delivery only and grants no authority to perform
other actions. Existing source/workspace validation and attention rate limits
still apply.
