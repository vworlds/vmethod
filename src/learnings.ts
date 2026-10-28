import { Ajv } from "ajv";
import { sumUsd, type Tokens } from "./cost.js";
import schema from "../schema/model-log.schema.json" with { type: "json" };
import type { ExactMetrics, SwitchReason } from "./learning-metrics.js";

export interface ModelRecord {
  date: string;
  repo: string;
  pr: number;
  task: string;
  kind: string;
  segments: {
    family: string;
    model: string;
    rounds: number[];
    why: string;
    tokens?: Tokens | null;
    usd?: number | null;
    reportedUsd?: number;
    switchReason?: SwitchReason;
    metrics?: ExactMetrics;
    points_open?: number | null;
    points_final?: number | null;
    outcome?: string;
  }[];
  usd?: number | null;
  metrics?: ExactMetrics;
  tokens?: Tokens | null;
  costSource?: "backfill" | "backfill-partial";
  costBasis?: "api-list";
  costCoverage?: "complete" | "partial";
  points_open: number;
  points_final: number;
  rounds: number;
  round_causes: string[];
  outcome: string;
  prompt_defects: string[];
  stalls: { minutes: number; cause: string; detected_by: string }[];
  findings: { tag: string; caught_by: string; root_cause_by?: string }[];
  notes: string;
}

const validator = new Ajv({ allErrors: true, strict: true }).compile(schema);

/** The single validator used by grading, imports, submission and reports. */
export function modelRecord(value: unknown): ModelRecord {
  if (!validator(value)) {
    throw new Error(`Invalid model-log record: ${JSON.stringify(validator.errors)}`);
  }
  return value as unknown as ModelRecord;
}

/** Parse JSONL without treating a missing file or malformed line as an empty pass. */
export function modelRecords(text: string): ModelRecord[] {
  const records = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return modelRecord(JSON.parse(line));
      } catch (error) {
        throw new Error(`Model log line ${index + 1}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    });
  const keys = records.map((record) => `${record.repo.toLowerCase()}#${record.pr}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Duplicate model-log delivery");
  }
  return records;
}

/** Aggregates count a delivery once per participating family; segment rounds are never summed. */
export function learningReport(records: readonly ModelRecord[], family?: string, kind?: string) {
  const selected = records.filter(
    (record) =>
      (!family || record.segments.some((segment) => segment.family === family)) &&
      (!kind || record.kind === kind)
  );
  const group = (items: readonly ModelRecord[], familyName?: string) => {
    const points = items.reduce((sum, record) => sum + record.points_final, 0);
    const rounds = items.reduce((sum, record) => sum + record.rounds, 0);
    const usd = sumUsd(
      items.map((record) =>
        familyName
          ? sumUsd(
              record.segments
                .filter((segment) => segment.family === familyName)
                .map((segment) => segment.usd)
            )
          : record.usd
      )
    );
    const covered = items.flatMap((record) => {
      const cost = familyName
        ? sumUsd(
            record.segments
              .filter((segment) => segment.family === familyName)
              .map((segment) => segment.usd)
          )
        : record.usd;
      return cost == null ? [] : [{ cost, points: record.points_final }];
    });
    const coveredUsd = covered.reduce((sum, entry) => sum + entry.cost, 0);
    const coveredPoints = covered.reduce((sum, entry) => sum + entry.points, 0);
    const count: Record<string, number> = Object.create(null) as Record<string, number>;
    const caught: Record<string, number> = Object.create(null) as Record<string, number>;
    const outcomes: Record<string, number> = Object.create(null) as Record<string, number>;
    const switches: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const record of items) {
      for (const tag of new Set(record.findings.map((finding) => finding.tag))) {
        count[tag] = (count[tag] ?? 0) + 1;
      }
      for (const finding of record.findings) {
        caught[finding.caught_by] = (caught[finding.caught_by] ?? 0) + 1;
      }
      outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
      for (const segment of record.segments.slice(1)) {
        switches[segment.why] = (switches[segment.why] ?? 0) + 1;
      }
    }
    return {
      deliveries: items.length,
      costDeliveries: covered.length,
      points,
      rounds,
      roundsPerPoint: points ? rounds / points : null,
      usd,
      usdPerPoint: coveredPoints ? coveredUsd / coveredPoints : null,
      findingsRate: Object.fromEntries(
        Object.entries(count).map(([tag, n]) => [tag, n / items.length])
      ),
      caughtBy: caught,
      outcomes,
      switchReasons: switches,
    };
  };
  return {
    ...group(selected),
    byFamily: Object.fromEntries(
      [...new Set(selected.flatMap((record) => record.segments.map((segment) => segment.family)))]
        .filter((name) => !family || name === family)
        .sort()
        .map((name) => [
          name,
          group(
            selected.filter((record) => record.segments.some((segment) => segment.family === name)),
            name
          ),
        ])
    ),
    byKind: Object.fromEntries(
      [...new Set(selected.map((record) => record.kind))]
        .sort()
        .map((name) => [name, group(selected.filter((record) => record.kind === name))])
    ),
  };
}
