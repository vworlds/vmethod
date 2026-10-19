import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  boardCost,
  opencodeUsage,
  opencodeRequests,
  requestCost,
  sumUsd,
  type Price,
  type PriceTier,
} from "../cost.js";
import type { Config } from "../config.js";
import { modelRecords } from "../learnings.js";
import { object } from "./people.js";
import { workerWorktreePrefix } from "./worker-path.js";

export interface CostBackfillOptions {
  dryRun?: boolean;
  prs?: number[];
}

export interface CostBackfillDependencies {
  root: string;
  config: Config;
  env: NodeJS.ProcessEnv;
  models: { family: string; model: string; price?: Price; tiers?: PriceTier[] }[];
  readSession(id: string): Promise<unknown | undefined>;
  inspectCard?(pr: number): Promise<{ cost?: string | null; archived?: boolean }>;
  setCost(pr: number, value: string): Promise<void>;
  listPrs?(): Promise<number[]>;
  report?(message: string): void;
}

/** Recover known per-PR cost from recorded worker sessions without inventing zero usage. */
export async function backfillCosts(
  deps: CostBackfillDependencies,
  options: CostBackfillOptions = {}
): Promise<string> {
  const stateName = String(deps.config.stateName ?? String(deps.config.repo).replace("/", "-"));
  const stateRoot = deps.env.XDG_STATE_HOME ?? join(deps.env.HOME ?? ".", ".local/state");
  const workers = join(stateRoot, "vmethod", stateName, "workers");
  const stateRecords = readWorkerRecords(workers, deps.config.repo);
  const legacyRecords = readLegacyRecords(deps, stateRoot);
  const logPath = join(deps.root, ".vmethod/model-log.jsonl");
  const logRecords = existsSync(logPath) ? modelRecords(readFileSync(logPath, "utf8")) : [];
  const boardPrs = options.prs?.length ? [] : ((await deps.listPrs?.()) ?? []);
  const prs = options.prs?.length
    ? [...new Set(options.prs)]
    : [
        ...new Set([
          ...stateRecords.keys(),
          ...legacyRecords.keys(),
          ...boardPrs,
          ...logRecords
            .filter(
              (record) => record.repo.toLowerCase() === String(deps.config.repo).toLowerCase()
            )
            .map((record) => record.pr),
        ]),
      ].sort((a, b) => a - b);
  const lines: string[] = [];
  let known = 0;
  let total = 0;
  let totalLowerBound = false;
  let connectionReported = false;
  for (const pr of prs) {
    const state = stateRecords.get(pr);
    const stateIds = sessionIds(state);
    const legacyId = stateIds.length ? undefined : legacyRecords.get(pr);
    const ids = stateIds.length ? stateIds : legacyId ? [legacyId] : [];
    const logged = logRecords.find(
      (record) =>
        record.repo.toLowerCase() === String(deps.config.repo).toLowerCase() && record.pr === pr
    );
    if (!ids.length && logged?.usd !== undefined && logged.usd !== null) {
      const partial = logged.costCoverage === "partial" || logged.costSource === "backfill-partial";
      const value = `${partial ? "≥ " : ""}${boardCost(logged.usd)!}`;
      const card = await deps.inspectCard?.(pr);
      const archived =
        card?.archived === true ||
        (!options.dryRun && (await writeCost(deps, pr, value, card?.cost)));
      lines.push(
        `#${pr}: ${archived ? `archived; ${value} recorded in the model log only` : value} (${partial ? "model log, partial coverage" : "model log"})${options.dryRun ? " [dry run]" : ""}`
      );
      known++;
      total += logged.usd;
      totalLowerBound ||= partial;
      continue;
    }
    if (!ids.length) {
      lines.push(`#${pr}: unknown (no recoverable session)`);
      continue;
    }
    const prices: (number | null)[] = [];
    let lowerBound = Boolean(legacyId);
    const labels: string[] = [];
    for (const id of ids) {
      if (!id.startsWith("ses_") || object(state?.model).kind === "claude") {
        prices.push(null);
        labels.push("no OpenCode session (Claude cannot be looked up)");
        continue;
      }
      let response: unknown;
      let failure: string | undefined;
      try {
        response = await deps.readSession(id);
      } catch (error) {
        failure = "opencode unreachable";
        if (!connectionReported) {
          deps.report?.(
            `OpenCode unavailable; affected sessions are unknown (${(error as Error).message})`
          );
          connectionReported = true;
        }
      }
      if (!response) {
        prices.push(null);
        labels.push(failure ?? `session not found on server (${id})`);
        continue;
      }
      const envelope = object(response);
      const session = Object.hasOwn(envelope, "session") ? envelope.session : response;
      if (envelope.running === true) {
        prices.push(null);
        labels.push(`session still running (${id})`);
        continue;
      }
      const cumulative = opencodeUsage(session);
      const sessionModel = object(object(session).model);
      const sessionModelId = `${String(sessionModel.providerID ?? "")}/${String(sessionModel.id ?? "")}`;
      const sessionFamily = deps.models.find(
        (item) => item.model === sessionModelId || item.family === sessionModelId
      );
      if (!cumulative) {
        prices.push(null);
        labels.push(`no cumulative token totals (${id})`);
        continue;
      }
      const messages = Array.isArray(envelope.messages) ? envelope.messages : [];
      const requests = opencodeRequests(messages).filter((request) => request.model);
      const unpriced = requests.find(
        (request) => !deps.models.find((model) => model.model === request.model)?.price
      );
      if (unpriced) {
        prices.push(null);
        labels.push(`no price for ${unpriced.model}`);
        continue;
      }
      let cost: ReturnType<typeof requestCost>;
      try {
        cost = requestCost(
          cumulative.tokens,
          requests,
          (request) => deps.models.find((model) => model.model === request.model) ?? {},
          sessionFamily?.price
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Provider usage decreased")) {
          throw error;
        }
        prices.push(null);
        labels.push("message usage exceeds cumulative session totals");
        continue;
      }
      const usd = cost.usd;
      if (usd === null) {
        prices.push(null);
        labels.push(`no price for ${(sessionFamily?.family ?? sessionModelId) || "session model"}`);
        continue;
      }
      let familyLabel =
        [
          ...new Set(
            requests.map(
              (request) => deps.models.find((model) => model.model === request.model)!.family
            )
          ),
        ].join("+") ||
        sessionFamily?.family ||
        "";
      if (cost.lowerBound && requests.length) {
        familyLabel = `partial message history; remainder priced at ${sessionFamily?.family ?? "unknown"}`;
      } else if (!requests.length) {
        const stateSegments = object(state).segments;
        const families = Array.isArray(stateSegments)
          ? stateSegments.map((segment) => object(segment).family).filter(Boolean)
          : [];
        if (new Set(families).size > 1) {
          familyLabel = `mixed models, priced at ${sessionFamily?.family ?? "unknown"}`;
        }
      }
      lowerBound ||= cost.lowerBound;
      prices.push(usd);
      labels.push(`${familyLabel || "unknown model"}, session ${id}`);
    }
    const usd = sumUsd(prices);
    if (usd === null) {
      lines.push(`#${pr}: unknown (${labels.join("; ")})`);
      continue;
    }
    const value = boardCost(usd, lowerBound)!;
    const logRecordNeedsBackfill = logged !== undefined && logged.usd == null;
    const logWritten =
      !options.dryRun &&
      updateLog(
        logPath,
        logRecords,
        deps.config.repo,
        pr,
        usd,
        lowerBound ? "partial" : "complete",
        lowerBound ? "backfill-partial" : "backfill"
      );
    const card = await deps.inspectCard?.(pr);
    const archived =
      card?.archived === true ||
      (!options.dryRun && (await writeCost(deps, pr, value, card?.cost)));
    const coverage = legacyId ? "; legacy record, last session only" : "";
    const result = archived
      ? logWritten || (options.dryRun && logRecordNeedsBackfill)
        ? `archived; ${value} recorded in the model log only`
        : `archived; Cost not updated${logged?.usd == null ? " (no model-log record to backfill)" : `; model log retains ${boardCost(logged.usd)}`}`
      : value;
    const details = legacyId ? "legacy record, last session only" : labels.join(", ");
    lines.push(
      `#${pr}: ${result} (${details}${coverage && !legacyId ? coverage : ""})${options.dryRun ? " [dry run]" : ""}`
    );
    known++;
    total += usd;
    totalLowerBound ||= lowerBound;
  }
  lines.push(
    `Total: ${known} priced PR(s), ${boardCost(total, totalLowerBound)}; ${prs.length - known} unknown`
  );
  return lines.join("\n");
}

function readWorkerRecords(directory: string, repo: unknown): Map<number, Record<string, unknown>> {
  const records = new Map<number, Record<string, unknown>>();
  if (!existsSync(directory)) {
    return records;
  }
  for (const name of readdirSync(directory).sort()) {
    const match = /^([1-9]\d*)\.json$/.exec(name);
    if (!match) {
      continue;
    }
    const pr = Number(match[1]);
    const record = object(JSON.parse(readFileSync(join(directory, name), "utf8")));
    if (record.pr === pr && (record.repo === undefined || record.repo === repo)) {
      records.set(pr, record);
    }
  }
  return records;
}

function sessionIds(record?: Record<string, unknown>): string[] {
  if (!record) {
    return [];
  }
  const ids = Array.isArray(record.sessionIds)
    ? record.sessionIds
    : Array.isArray(record.ids)
      ? record.ids
      : Array.isArray(record.sessions)
        ? record.sessions.map((session) =>
            typeof session === "string" ? session : object(session).id
          )
        : [record.sessionId ?? record.id];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function readLegacyRecords(deps: CostBackfillDependencies, stateRoot: string): Map<number, string> {
  const records = new Map<number, string>();
  const latest = new Map<number, number>();
  const names = Array.isArray(deps.config.legacyWorkers) ? deps.config.legacyWorkers : [];
  for (const value of names) {
    const name = String(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(name)) {
      throw new Error("Invalid legacyWorkers relative directory path");
    }
    if (name.split("/").at(-1) === "claude-workers") {
      continue;
    }
    const directory = join(
      stateRoot,
      `${name}${deps.config.track ? `-${String(deps.config.track)}` : ""}`
    );
    if (!existsSync(directory)) {
      continue;
    }
    for (const file of readdirSync(directory).sort()) {
      const marker = file.lastIndexOf(".worktrees_");
      if (marker < 0) {
        continue;
      }
      const basename = file.slice(marker + ".worktrees_".length);
      const prefix = workerWorktreePrefix(deps.config);
      const task = basename.startsWith(prefix)
        ? /^([1-9]\d*)-/.exec(basename.slice(prefix.length))
        : null;
      if (!task) {
        continue;
      }
      const path = join(directory, file);
      const relativePath = relative(realpathSync(stateRoot), realpathSync(path));
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
        throw new Error("Legacy path escapes the state root");
      }
      const id = readFileSync(path, "utf8").trim();
      const pr = Number(task[1]);
      const modified = statSync(path).mtimeMs;
      if (/^ses_[\w-]+$/.test(id) && modified >= (latest.get(pr) ?? -1)) {
        records.set(pr, id);
        latest.set(pr, modified);
      }
    }
  }
  return records;
}

async function writeCost(
  deps: CostBackfillDependencies,
  pr: number,
  value: string,
  current?: string | null
): Promise<boolean> {
  if (current === value) {
    return false;
  }
  try {
    await deps.setCost(pr, value);
    return false;
  } catch (error) {
    if (/archived|archived Done/i.test((error as Error).message)) {
      return true;
    }
    throw error;
  }
}

function updateLog(
  path: string,
  records: ReturnType<typeof modelRecords>,
  repo: unknown,
  pr: number,
  usd: number,
  coverage: string,
  source: "backfill" | "backfill-partial"
): boolean {
  const record = records.find(
    (item) => item.repo.toLowerCase() === String(repo).toLowerCase() && item.pr === pr
  );
  if (!record || (record.usd !== undefined && record.usd !== null)) {
    return false;
  }
  const updated = {
    ...record,
    usd,
    costSource: source,
    costBasis: "api-list",
    costCoverage: coverage,
  };
  Object.assign(record, updated);
  const next = records.map((item) => JSON.stringify(item)).join("\n") + "\n";
  modelRecords(next);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, path);
  return true;
}
