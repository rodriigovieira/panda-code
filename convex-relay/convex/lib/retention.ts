export const OFFLINE_AFTER_MS = 30_000;
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const CLOSED_COMMAND_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const PENDING_COMMAND_TTL_MS = 2 * 60_000;
export const COMMAND_RATE_LIMIT_WINDOW_MS = 60_000;
export const COMMAND_RATE_LIMIT_MAX = 30;

/**
 * How much of a phone's own command history `commands:watchMine` subscribes to.
 * That query re-fires on every status transition of every row in its read set
 * (pending → claimed → done is three re-fires per command), so the window is
 * kept to what the UI actually renders: the outcome of commands issued a moment
 * ago, explaining a `start` the desktop rejected. Older rows are history nobody
 * looks at, and each one would be re-read on every subsequent transition.
 */
export const COMMAND_WATCH_LIMIT = 10;
export const COMMAND_WATCH_WINDOW_MS = 10 * 60_000;

/**
 * EVENT WRITE BUDGET — per device, per rolling window.
 *
 * These are ABUSE CEILINGS, not quotas: they sit orders of magnitude above real
 * usage and exist so an unauthenticated `registerDevice` can't turn the relay
 * into an unbounded blob store. `appendEvents` is the only unmetered write path
 * on the relay, and its payloads are ciphertext by construction — abuse looks
 * exactly like use, so there is nothing to inspect after the fact. The ceiling
 * is the control.
 *
 * Sizing, against the desktop's actual flush behaviour (relayBridge.ts):
 * one flush per session per `EVENT_FLUSH_MS` (1s), serialized per session, each
 * carrying the items *touched* in that second (a coalescing map keyed by itemId,
 * not an append log). A pathological-but-legitimate device — ~10 sessions all
 * streaming large assistant messages at once — lands near 600 calls/min and a
 * few MB. The limits below leave roughly an order of magnitude of headroom on
 * top of that, so a real user should never see one.
 */
export const EVENT_RATE_LIMIT_WINDOW_MS = 60_000;
export const EVENT_RATE_LIMIT_MAX_EVENTS = 20_000;
export const EVENT_RATE_LIMIT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-call caps, checked synchronously before any database work so a hostile
 * payload is rejected without costing a read. These bound the damage of a single
 * call; the window budget above bounds it over time.
 */
export const MAX_EVENTS_PER_APPEND = 512;
export const MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024;

/** Abandoned write-budget rows are swept once they can no longer affect a decision. */
export const WRITE_BUDGET_RETENTION_MS = 24 * 60 * 60_000;
export const WRITE_BUDGET_PRUNE_BATCH = 200;

export const PAIRING_PRUNE_BATCH = 200;
export const DEVICE_PRUNE_BATCH = 200;
export const EVENT_PRUNE_BATCH = 500;
export const COMMAND_PRUNE_BATCH = 250;
