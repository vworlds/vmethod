import { describe, expect, it } from "vitest";
import * as windows from "../../src/core/time.js";

describe("named time windows", () => {
  const values: Record<keyof typeof windows, number> = {
    JOURNAL_MATCH_MS: 120_000,
    OPERATION_INFLIGHT_MS: 120_000,
    MARKER_MARGIN_MS: 120_000,
    HOLD_MAX_AGE_MS: 120_000,
    CONFLICT_START_GRACE_MS: 120_000,
    BUTTON_RETRY_MS: 600_000,
    CURSOR_OVERLAP_MS: 600_000,
    RELEASE_PROPAGATION_MS: 600_000,
    WORKER_STALE_MS: 1_800_000,
    CHAT_REMINDER_EVERY_MS: 1_800_000,
    TURN_WAIT_MS: 1_800_000,
    UNHANDLED_TURN_REMINDER_MINUTES: 30,
    RELEASE_WAIT_MINUTES: 30,
    CHECKS_WAIT_MINUTES: 30,
    MIGRATION_WINDOW_MS: 3_600_000,
    FAILURE_REMINDER_MS: 3_600_000,
    CONFLICT_RESOLUTION_MS: 3_600_000,
    MIGRATION_LOCK_MAX_AGE_MS: 3_600_000,
    WAITING_TURN_REMINDER_MINUTES: 60,
  };

  it.each(Object.entries(values))("%s retains its value and unit", (name, value) => {
    expect(windows[name as keyof typeof windows]).toBe(value);
  });
});
