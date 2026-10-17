import type { Config } from "../config.js";

export interface SessionInput {
  track?: string;
  only?: number[];
  skip?: number[];
}

export interface ResolvedSession {
  stateName: string;
  track: string | null;
  only: number[] | null;
  skip: number[] | null;
}

/** One canonical scope name for watcher state and gateway write attribution. */
export function resolveSession(config: Config, input: SessionInput): ResolvedSession {
  const track =
    input.track ?? (typeof config.track === "string" && config.track ? config.track : null);
  if (track !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(track)) {
    throw new Error("Invalid track name");
  }
  const only = normalizeNumbers(input.only);
  const skip = normalizeNumbers(input.skip);
  if ([track !== null, only !== null, skip !== null].filter(Boolean).length > 1) {
    throw new Error("Choose one session: --track, --only or --skip");
  }
  const base = String(config.stateName ?? String(config.repo).replace("/", "-"));
  const suffix =
    track !== null
      ? `-${track}`
      : only !== null
        ? `-only-${only.join("-")}`
        : skip !== null
          ? `-skip-${skip.join("-")}`
          : "";
  return { stateName: `${base}${suffix}`, track, only, skip };
}

/** Writing commands use the same existing environment selectors as watch. */
export function writeSession(config: Config, env: NodeJS.ProcessEnv): ResolvedSession {
  const input: SessionInput = {};
  if (env.WATCH_ONLY) {
    input.only = env.WATCH_ONLY.trim()
      .split(/[\s,]+/)
      .map(Number);
  }
  if (env.WATCH_SKIP) {
    input.skip = env.WATCH_SKIP.trim()
      .split(/[\s,]+/)
      .map(Number);
  }
  return resolveSession(config, input);
}

function normalizeNumbers(value: unknown): number[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || !value.length) {
    throw new Error("Expected a nonempty list of item numbers");
  }
  const numbers = value.map((entry) => {
    const parsed = Number(entry);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error("Expected positive item numbers");
    }
    return parsed;
  });
  return [...new Set(numbers)].sort((a, b) => a - b);
}
