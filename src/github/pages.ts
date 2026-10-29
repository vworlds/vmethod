import { object, type ObjectData } from "../gateway/people.js";

/** Preserve a reader's wire contract and error vocabulary while paging a connection. */
export interface PageOptions {
  connectionError: string;
  cursorError: string;
  direction?: "forward" | "backward";
  nonempty?: boolean;
  repeats?: "all" | "previous";
  limit?: number;
  limitError?: string;
  /** Some readers validate cursors before processing a page, rather than after it. */
  validateFirst?: boolean;
  pageInfoError?: string;
  /** Inspect metadata before connection decoding; an explicit stop is not a missing page. */
  stop?: (payload: ObjectData) => boolean;
  connection?: (payload: ObjectData) => unknown;
}

/** Yield pages in request order. Early consumer return deliberately skips cursor validation. */
export async function* pages(
  read: (cursor: string | null) => Promise<unknown>,
  options: PageOptions
): AsyncGenerator<ObjectData & { nodes: unknown[] }> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    const payload = object(await read(cursor));
    if (options.stop?.(payload)) {
      return;
    }
    const connection = options.connection ? options.connection(payload) : payload;
    assertConnection(connection, options.connectionError);
    if (
      options.pageInfoError &&
      typeof object(object(connection).pageInfo)[
        options.direction === "backward" ? "hasPreviousPage" : "hasNextPage"
      ] !== "boolean"
    ) {
      throw new Error(options.pageInfoError);
    }
    let next: string | null = null;
    if (options.validateFirst) {
      next = pageCursor(connection, seen, options, cursor);
    }
    yield connection;
    if (!options.validateFirst) {
      next = pageCursor(connection, seen, options, cursor);
    }
    if (next === null) {
      return;
    }
    if (page + 1 === options.limit) {
      throw new Error(options.limitError);
    }
    cursor = next;
  }
}

/** Shared cursor validation for ordinary pages and call-site-scheduled alias batches.
 * Each alias owns its own seen set; previous-only readers retain their historical check. */
export function pageCursor(
  connection: unknown,
  seen: Set<string>,
  options: Pick<PageOptions, "cursorError" | "direction" | "nonempty" | "repeats">,
  previous: string | null = null
): string | null {
  const info = object(object(connection).pageInfo);
  const backward = options.direction === "backward";
  const more = info[backward ? "hasPreviousPage" : "hasNextPage"];
  const cursor = info[backward ? "startCursor" : "endCursor"];
  if (more === false) {
    return null;
  }
  if (
    more !== true ||
    typeof cursor !== "string" ||
    (options.nonempty && !cursor) ||
    (options.repeats === "previous" ? cursor === previous : seen.has(cursor))
  ) {
    throw new Error(options.cursorError);
  }
  seen.add(cursor);
  return cursor;
}

/** Numbered REST pages preserve per-site page size and truncation/limit policy. */
export async function* restPages<T = unknown>(
  read: (page: number) => Promise<unknown>,
  options: { error: string; size: number; limit?: number; limitError?: string }
): AsyncGenerator<T[]> {
  for (let page = 1; ; page++) {
    const values = await read(page);
    if (!Array.isArray(values)) {
      throw new Error(options.error);
    }
    yield values as T[];
    if (values.length < options.size) {
      return;
    }
    if (page === options.limit) {
      if (options.limitError) {
        throw new Error(options.limitError);
      }
      return;
    }
  }
}

/** Schedule alias pages without changing batch boundaries or request order.
 * The reader updates each entry's cursor after its identity checks and decoding.
 * Rounds visit all pending aliases before retrying; drain retries the first batch. */
export async function batchPages<T extends { cursor: string | null }>(
  entries: T[],
  read: (batch: T[]) => Promise<void>,
  options: { size: number; strategy: "rounds" | "drain"; initial?: "pending" }
): Promise<void> {
  let pending =
    options.initial === "pending" ? entries.filter((entry) => entry.cursor !== null) : entries;
  while (pending.length) {
    if (options.strategy === "drain") {
      await read(pending.slice(0, options.size));
      pending = [
        ...pending.slice(0, options.size).filter((entry) => entry.cursor !== null),
        ...pending.slice(options.size),
      ];
    } else {
      for (let start = 0; start < pending.length; start += options.size) {
        await read(pending.slice(start, start + options.size));
      }
      pending = pending.filter((entry) => entry.cursor !== null);
    }
  }
}

/** Never silently turn a missing/non-object connection into an empty page. */
function assertConnection(
  connection: unknown,
  error: string
): asserts connection is ObjectData & { nodes: unknown[] } {
  if (!Array.isArray(object(connection).nodes)) {
    throw new Error(error);
  }
}
