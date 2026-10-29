import {
  addTokens,
  requestCost,
  usageDelta,
  zeroTokens,
  type CostRequest,
  type Price,
  type PriceTier,
  type RequestCosts,
  type Usage,
} from "../cost.js";

interface UsageSegment {
  family: string;
  model: string;
  at: string;
  baseline?: Usage;
  usage?: Usage;
  usd?: number | null;
  lowerBound?: boolean;
  requests?: RequestCosts;
  compactionIds?: string[];
}

interface UsageRecord {
  segments: UsageSegment[];
  finalized?: boolean;
  costHistoryLoaded?: boolean;
}

interface UsageObservation {
  usage?: Usage;
  requests?: CostRequest[];
  compactions?: { id: string; created: number }[];
}

interface UsageModel {
  family: string;
  model: string;
  price?: Price;
  tiers?: PriceTier[];
}

/**
 * Account for one provider poll without mutating the record or doing I/O.
 * Returns an updated record to persist, or undefined for absent usage/finalized records.
 * Only the current segment changes: prior request ids and switch baselines bound its
 * history, cached request prices survive polls, and unknown prices remain null.
 */
export function accountUsage<T extends UsageRecord>(
  record: T,
  status: UsageObservation,
  models: readonly UsageModel[]
): (T & UsageRecord) | undefined {
  if (!status.usage || record.finalized) {
    return;
  }
  const segment = { ...record.segments.at(-1)! };
  if (segment.requests) {
    segment.requests = { ...segment.requests };
  }
  if (status.compactions) {
    segment.compactionIds = [
      ...new Set([
        ...(segment.compactionIds ?? []),
        ...status.compactions.filter((c) => c.created >= Date.parse(segment.at)).map((c) => c.id),
      ]),
    ];
  }
  segment.usage = usageDelta(
    status.usage,
    segment.baseline ?? { tokens: zeroTokens(), reportedUsd: 0 }
  );
  const priorIds = new Set(
    record.segments.slice(0, -1).flatMap((s) => Object.keys(s.requests ?? {}))
  );
  const model = models.find((m) => m.family === segment.family);
  const requests = (status.requests ?? []).filter((request) => {
    if (priorIds.has(request.id)) {
      return false;
    }
    if (record.segments.length === 1) {
      return true;
    }
    if (request.model && request.model !== segment.model) {
      return false;
    }
    // A unique model is sufficient even for adopted sessions predating `at`.
    // Missing/repeated models need the switch time, not an absent legacy cache.
    return request.model && !record.segments.slice(0, -1).some((s) => s.model === request.model)
      ? true
      : request.created !== undefined && request.created >= Date.parse(segment.at);
  });
  const cache = { ...segment.requests };
  for (const request of requests) {
    Object.defineProperty(cache, request.id, {
      value: { tokens: request.tokens },
      enumerable: true,
      configurable: true,
    });
  }
  const measured = Object.values(cache).reduce(
    (sum, entry) => addTokens(sum, entry.tokens),
    zeroTokens()
  );
  const exceedsTotal = (Object.keys(measured) as (keyof typeof measured)[]).some(
    (key) => measured[key] > segment.usage!.tokens[key]
  );
  // Inconsistent history cannot block grading or count another segment twice.
  // Discard its request cache and use only this segment's recorded totals.
  if (exceedsTotal) {
    segment.requests = {};
  }
  const cost = requestCost(
    segment.usage.tokens,
    exceedsTotal ? [] : requests,
    (request) =>
      request.model ? (models.find((m) => m.model === request.model) ?? {}) : (model ?? {}),
    model?.price,
    (segment.requests ??= {})
  );
  segment.usd = cost.usd;
  segment.lowerBound = cost.lowerBound;
  return {
    ...record,
    segments: [...record.segments.slice(0, -1), segment],
    ...(status.requests ? { costHistoryLoaded: true } : {}),
  };
}
