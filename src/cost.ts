import { object } from "./gateway/people.js";

/** Provider usage normalized to the three API-price categories. */
export interface Tokens {
  input: number;
  output: number;
  cached: number;
}
export interface Usage {
  tokens: Tokens;
  reportedUsd?: number;
}
/** USD per million tokens, including subscription-backed deliveries. */
export type Price = Tokens;

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cached: 0 });

/** Add normalized counts without conflating cached input with uncached input. */
export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached };
}

/** Subtract a model-switch baseline; a provider reset cannot become negative usage. */
export function usageDelta(total: Usage, baseline: Usage): Usage {
  const tokens = {
    input: total.tokens.input - baseline.tokens.input,
    output: total.tokens.output - baseline.tokens.output,
    cached: total.tokens.cached - baseline.tokens.cached,
  };
  if (Object.values(tokens).some((n) => n < 0)) {
    throw new Error("Provider usage decreased; cannot account for segment");
  }
  if (
    total.reportedUsd !== undefined &&
    baseline.reportedUsd !== undefined &&
    total.reportedUsd < baseline.reportedUsd
  ) {
    throw new Error("Provider reported cost decreased; cannot account for segment");
  }
  return {
    tokens,
    ...(total.reportedUsd === undefined || baseline.reportedUsd === undefined
      ? {}
      : { reportedUsd: total.reportedUsd - baseline.reportedUsd }),
  };
}

/** Calculate API-price USD; absent measurements or rates stay unknown. */
export function dollars(tokens: Tokens | undefined, price: Price | undefined): number | null {
  return tokens && price
    ? (tokens.input * price.input + tokens.output * price.output + tokens.cached * price.cached) /
        1_000_000
    : null;
}

/** Unknown measurements propagate rather than masquerading as free usage. */
export function sumUsd(values: readonly (number | null | undefined)[]): number | null {
  return values.some((value) => value == null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}

/** Format known USD for the board's per-PR text Cost field. */
export function boardCost(usd: number | null): string | null {
  return usd === null ? null : `$${usd.toFixed(2)}`;
}

/** Parse board Cost text; malformed values stay unknown. */
export function parseBoardCost(value: unknown): number | null {
  if (typeof value !== "string" || !/^\$\d+(?:\.\d{2})$/.test(value)) {
    return null;
  }
  const amount = Number(value.slice(1));
  return Number.isFinite(amount) ? amount : null;
}

/** Decode cumulative OpenCode totals, using full-history fallback only for absent categories. */
export function opencodeUsage(value: unknown, fallback?: Usage): Usage | undefined {
  const source = object(value);
  const tokens = object(source.tokens);
  const cache = object(tokens.cache);
  for (const value of [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    cache.write,
    cache.read,
    source.cost,
  ]) {
    if (value !== undefined) {
      count(value);
    }
  }
  const input =
    tokens.input === undefined || cache.write === undefined
      ? fallback?.tokens.input
      : count(tokens.input) + count(cache.write);
  const output =
    tokens.output === undefined || tokens.reasoning === undefined
      ? fallback?.tokens.output
      : count(tokens.output) + count(tokens.reasoning);
  const cached = cache.read === undefined ? fallback?.tokens.cached : count(cache.read);
  if (input === undefined || output === undefined || cached === undefined) {
    return;
  }
  return {
    tokens: { input, output, cached },
    ...(source.cost === undefined
      ? fallback?.reportedUsd === undefined
        ? {}
        : { reportedUsd: fallback.reportedUsd }
      : { reportedUsd: count(source.cost) }),
  };
}

/** Claude usage is per turn; reported cost is the latest cumulative value per session. */
export function claudeUsage(results: readonly unknown[]): Usage | undefined {
  let total: Usage | undefined;
  const reported = new Map<string, number | undefined>();
  for (const value of results) {
    const result = object(value);
    if (result.type !== "result" || result.usage === undefined) {
      continue;
    }
    const usage = object(result.usage);
    const tokens = {
      input: count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
      output: count(usage.output_tokens),
      cached: count(usage.cache_read_input_tokens),
    };
    reported.set(
      typeof result.session_id === "string" ? result.session_id : "",
      result.total_cost_usd === undefined ? undefined : count(result.total_cost_usd)
    );
    const reportedUsd = sumUsd([...reported.values()]);
    total = {
      tokens: addTokens(total?.tokens ?? zeroTokens(), tokens),
      ...(reportedUsd === null ? {} : { reportedUsd }),
    };
  }
  return total;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid provider usage count");
  }
  return value;
}
