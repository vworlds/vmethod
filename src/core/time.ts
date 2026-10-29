/** Bounds id-less journal write correlation by server-observation time (#55, #69; J2). */
export const JOURNAL_MATCH_MS = 2 * 60_000;
/** Keeps multi-field handoffs quiet while their operation records are in flight (#199; B3). */
export const OPERATION_INFLIGHT_MS = 2 * 60_000;
/** Extends cursor-marker retention beyond the comment overlap so deduplication survives it (A3). */
export const MARKER_MARGIN_MS = 2 * 60_000;
/** Bounds how long a recent task-hold marker suppresses watcher activity. */
export const HOLD_MAX_AGE_MS = 2 * 60_000;
/** Gives a dispatched conflict turn time to start before an unchanged head is judged (#148). */
export const CONFLICT_START_GRACE_MS = 2 * 60_000;

/** Delays repeated button-merge follow-up notices, including same-account writes (#115, #142; A7). */
export const BUTTON_RETRY_MS = 10 * 60_000;
/** Re-reads comments before the cursor without advancing it after a failed poll (#69; A4). */
export const CURSOR_OVERLAP_MS = 10 * 60_000;
/** Bounds npm propagation polling before tag/release evidence takes precedence (#310). */
export const RELEASE_PROPAGATION_MS = 10 * 60_000;

/** Bounds how long a review can wait without a worker reply before a STALE notice. */
export const WORKER_STALE_MS = 30 * 60_000;
/** Limits chat-rule reminders on nonempty deliveries; reminders remain metadata (section 7.27). */
export const CHAT_REMINDER_EVERY_MS = 30 * 60_000;
/** Delays the first reminder for an ordinary waiting orchestrator turn. */
export const TURN_WAIT_MS = 30 * 60_000;
/** Spaces repeat reminders for unhandled worker protocol, in minutes at the caller. */
export const UNHANDLED_TURN_REMINDER_MINUTES = 30;
/** Bounds the dispatched publication workflow wait, in minutes (#308). */
export const RELEASE_WAIT_MINUTES = 30;
/** Supplies the default bounded CI wait, in minutes. */
export const CHECKS_WAIT_MINUTES = 30;

/** Bounds the migration stamp that suppresses ordinary board-move reporting (B12). */
export const MIGRATION_WINDOW_MS = 60 * 60_000;
/** Spaces reminders of an identical watcher failure (#91; A6). */
export const FAILURE_REMINDER_MS = 60 * 60_000;
/** Bounds conflict resolution unless explicitly retrying a recorded verify failure (#148, #274; C9). */
export const CONFLICT_RESOLUTION_MS = 60 * 60_000;
/** Bounds a migration lock's live-holder age alongside holder identity checks (#252; J3). */
export const MIGRATION_LOCK_MAX_AGE_MS = 60 * 60_000;
/** Spaces repeat reminders for ordinary waiting orchestrator turns, in minutes. */
export const WAITING_TURN_REMINDER_MINUTES = 60;
