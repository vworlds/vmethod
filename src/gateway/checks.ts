import type { Config } from "../config.js";
import { stripVTControlCharacters } from "node:util";
import { GitHubClient, type Dependencies } from "./client.js";
import { object, untrusted, type ObjectData, type PeopleFilter } from "./people.js";
import { reference, type ThreadRef } from "./refs.js";
import { taskBranch, validateBranch } from "./git.js";
import type { Operations, Verdict } from "./transport.js";
import { validateLearningPr } from "./learning-check.js";
import { liveBaseHead } from "./base-head.js";

export interface CiSnapshot {
  target: ThreadRef;
  head: string;
  branch: string;
  base: string;
  baseSha: string;
  conflict: boolean;
  runs: ObjectData[];
  green: boolean;
  stale: boolean;
}

/** REST-only CI analysis. Raw check/log text stays fenced as untrusted data. */
export class ChecksService {
  constructor(
    private config: Config,
    private github: GitHubClient,
    private filter: PeopleFilter,
    private deps: Dependencies
  ) {}

  async wait(input: Operations["waitChecks"]["input"]): Promise<Verdict> {
    const minutes = input.maxMinutes ?? 30;
    const grace = input.graceSeconds ?? 120;
    if (
      ![minutes, grace].every((n) => Number.isFinite(n) && n >= 0) ||
      minutes > 1440 ||
      grace > 86400
    ) {
      throw new Error("Invalid wait-checks time limit");
    }
    const started = this.deps.now();
    const deadline = started + minutes * 60000;
    let head = "";
    let reason: string;
    const noVerdict = (why: string): Verdict => ({
      code: 2,
      text: `checks: no verdict after ${Math.ceil((this.deps.now() - started) / 60000)} min (${why}; run again)`,
    });
    for (;;) {
      try {
        const pr = await this.pull(input.ref, true);
        if (head && head !== pr.head) {
          return noVerdict("the PR head changed while waiting");
        }
        head = pr.head;
        const runs = await this.runs(pr.target, head);
        if (!runs.length) {
          if (pr.conflict) {
            return conflict(pr.base);
          }
          reason = `no checks registered for ${head.slice(0, 8)} yet`;
          if (this.deps.now() - started >= grace * 1000) {
            return noVerdict(reason);
          }
        } else if (runs.every(completed) && (await this.suitesComplete(pr.target, runs))) {
          const current = await this.pull(input.ref, true);
          if (head !== current.head) {
            return noVerdict("the PR head changed while waiting");
          }
          return this.verdict(pr.target, runs, true);
        } else {
          reason = "checks are still pending";
        }
      } catch (error) {
        // Only transport failures are transient: malformed data and denied identities fail closed.
        if (!(error instanceof Error) || !/^(GitHub |BUDGET)/.test(error.message)) {
          throw error;
        }
        reason = "GitHub read failed";
        this.deps.report("wait-checks: GitHub read failed; retrying");
      }
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) {
        return noVerdict(reason);
      }
      await this.deps.sleep(Math.min(10000, remaining));
    }
  }

  async check(ref: string): Promise<Verdict> {
    const snapshot = await this.snapshot(ref);
    if (snapshot.conflict) {
      return conflict(snapshot.base);
    }
    const result = await this.verdict(snapshot.target, snapshot.runs, false);
    if (result.code !== 0) {
      return result;
    }
    return snapshot.stale
      ? {
          code: 2,
          text: "checks: green, but the base moved or CI base is unknown; run refresh-checks",
        }
      : { code: 0, text: "checks: green; CI tested the current base" };
  }

  /** Pin CI evidence to the live branch head, including a second read to detect movement. */
  async snapshot(ref: string): Promise<CiSnapshot> {
    const pr = await this.pull(ref);
    pr.baseSha = await liveBaseHead(pr.base, { github: this.github, repo: pr.target.repo });
    const runs = await this.runs(pr.target, pr.head);
    const green = runs.length > 0 && runs.every((run) => completed(run) && successful(run));
    // A commit's author/committer timestamp is not evidence of what CI checked out.
    // Resolve each suite's workflow run and compare its event's associated PR refs.
    let stale = !green;
    if (green) {
      stale = false;
      const suites = new Set(runs.map((run) => object(run.check_suite).id));
      for (const id of suites) {
        if (!Number.isSafeInteger(id) || Number(id) < 1) {
          stale = true;
          break;
        }
        const response = object(
          await this.github.rest(
            `/repos/${pr.target.repo}/actions/runs?check_suite_id=${id}&per_page=100`
          )
        );
        if (!Array.isArray(response.workflow_runs)) {
          throw new Error("Missing workflow runs");
        }
        const workflows = response.workflow_runs
          .map(object)
          .filter((run) => object(run.check_suite).id === id || run.check_suite_id === id);
        const latest = workflows.sort((a, b) => Number(b.id) - Number(a.id))[0];
        if (!latest || latest.head_sha !== pr.head || latest.conclusion !== "success") {
          stale = true;
          break;
        }
        // GitHub's PR event retains its associated head/base refs on the workflow run.
        // If unavailable, fail closed rather than trusting timestamps or today's synthetic merge.
        const associated = Array.isArray(latest.pull_requests)
          ? latest.pull_requests.map(object)
          : [];
        const tested = associated.find((value) => value.number === pr.target.number);
        if (object(tested?.base).sha !== pr.baseSha || object(tested?.head).sha !== pr.head) {
          stale = true;
          break;
        }
      }
    }
    const current = await this.pull(ref);
    const currentBase = await liveBaseHead(current.base, {
      github: this.github,
      repo: current.target.repo,
    });
    if (current.head !== pr.head || current.base !== pr.base || currentBase !== pr.baseSha) {
      return { ...pr, runs: [], green: false, stale: true };
    }
    return { ...pr, runs, green, stale };
  }

  /** Only read-only waiting may authorize a central learning submission's fork head. */
  async pull(
    ref: string,
    learningFork = false
  ): Promise<Omit<CiSnapshot, "runs" | "green" | "stale">> {
    const target = reference(ref, this.config);
    if (target.repo.toLowerCase() !== String(this.config.repo).toLowerCase()) {
      throw new Error("CI operations require the configured repository");
    }
    const pr = object(await this.github.rest(`/repos/${target.repo}/pulls/${target.number}`));
    const user = object(pr.user);
    if (!this.filter.identity({ login: user.login, databaseId: user.id, __typename: user.type })) {
      throw new Error("No accepted task PR");
    }
    if (pr.state !== "open") {
      throw new Error("Task PR is not open");
    }
    const head = object(pr.head);
    const base = object(pr.base);
    if (object(base.repo).full_name !== target.repo) {
      throw new Error("Task branch must belong to the configured repository");
    }
    if (object(head.repo).full_name !== target.repo) {
      if (
        !learningFork ||
        target.repo !== "vworlds/vmethod" ||
        (await validateLearningPr(this.github, pr, target.number, false, false)) !==
          `Learning PR #${target.number}: authorized`
      ) {
        throw new Error("Task branch must belong to the configured repository");
      }
      validateBranch(String(head.ref));
    } else {
      taskBranch(String(head.ref), this.config);
    }
    validateBranch(String(base.ref));
    if (
      ![head.sha, base.sha].every((sha) => typeof sha === "string" && /^[a-f\d]{40}$/i.test(sha))
    ) {
      throw new Error("Invalid PR SHA");
    }
    return {
      target,
      head: String(head.sha),
      branch: String(head.ref),
      base: String(base.ref),
      baseSha: String(base.sha),
      conflict: pr.mergeable === false && pr.mergeable_state === "dirty",
    };
  }

  private async runs(target: ThreadRef, head: string): Promise<ObjectData[]> {
    const latest = new Map<string, ObjectData>();
    for (let page = 1; ; page++) {
      const result = object(
        await this.github.rest(
          `/repos/${target.repo}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`
        )
      );
      if (!Array.isArray(result.check_runs)) {
        throw new Error("Missing check runs");
      }
      for (const value of result.check_runs) {
        const run = object(value);
        if (!this.filter.check(run, target.owner, target.link)) {
          continue;
        }
        if (
          run.head_sha !== head ||
          !Number.isSafeInteger(run.id) ||
          Number(run.id) < 1 ||
          typeof run.name !== "string"
        ) {
          throw new Error("Invalid check run");
        }
        const key = JSON.stringify([object(run.app).id, run.name]);
        if (!latest.has(key) || Number(latest.get(key)?.id) < Number(run.id)) {
          latest.set(key, run);
        }
      }
      if (result.check_runs.length < 100) {
        return [...latest.values()];
      }
    }
  }

  private async suitesComplete(target: ThreadRef, runs: ObjectData[]): Promise<boolean> {
    // A completed first job is not a completed workflow: later jobs may not have registered.
    for (const id of new Set(runs.map((run) => object(run.check_suite).id))) {
      if (id === undefined) {
        continue;
      }
      if (!Number.isSafeInteger(id) || Number(id) < 1) {
        throw new Error("Invalid check suite");
      }
      const suite = object(await this.github.rest(`/repos/${target.repo}/check-suites/${id}`));
      if (
        !this.filter.check(suite, target.owner, target.link) ||
        suite.head_sha !== runs[0].head_sha
      ) {
        throw new Error("Check suite identity mismatch");
      }
      if (suite.status !== "completed" || typeof suite.conclusion !== "string") {
        return false;
      }
      if (!successful(suite)) {
        // Billing/startup/workflow failures can leave no individually red job.
        runs.push({ ...suite, name: `CI suite ${id}`, details_url: undefined });
      }
    }
    return true;
  }

  private async verdict(target: ThreadRef, runs: ObjectData[], digest: boolean): Promise<Verdict> {
    if (!runs.length || !runs.every(completed)) {
      return { code: 2, text: "checks: no verdict (checks pending or not registered; run again)" };
    }
    const failed = runs.filter((run) => !successful(run));
    if (!failed.length) {
      return { code: 0, text: "checks: green" };
    }
    const output: string[] = [];
    if (digest) {
      for (const run of failed) {
        let detail = "its log could not be read: no trusted Actions job URL";
        const match = new RegExp(
          `^https://github\\.com/${target.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/actions/runs/([0-9]+)/job/([0-9]+)$`
        ).exec(String(run.details_url));
        if (match) {
          try {
            const job = object(
              await this.github.rest(`/repos/${target.repo}/actions/jobs/${match[2]}`)
            );
            if (job.run_id !== Number(match[1]) || job.head_sha !== run.head_sha) {
              throw new Error("Job identity mismatch");
            }
            const steps = Array.isArray(job.steps)
              ? job.steps
                  .map(object)
                  .filter((step) => !successful(step) && step.conclusion != null)
                  .map((step) => step.name)
                  .join(", ")
              : "";
            const log = await this.github.jobLog(
              `/repos/${target.repo}/actions/jobs/${match[2]}/logs`
            );
            if (!log.trim()) {
              throw new Error("Empty log response");
            }
            detail = `step: ${steps || "unavailable; no failed step reported"}\n${digestLog(log)}`;
          } catch (error) {
            const status =
              error instanceof Error ? error.message.match(/HTTP \d{3}/)?.[0] : undefined;
            detail = `its log could not be read${status ? ` (${status})` : ""}; ${String(run.details_url)}`;
          }
        }
        output.push(untrusted(`--- ${String(run.name)} failed (${detail})`));
      }
    }
    output.push(
      `checks: RED: ${failed.map((run) => JSON.stringify(String(run.name)).slice(1, -1)).join(", ")}`
    );
    return { code: 1, text: output.join("\n") };
  }
}

function completed(run: ObjectData): boolean {
  return run.status === "completed" && typeof run.conclusion === "string";
}
function successful(run: ObjectData): boolean {
  return ["success", "neutral", "skipped"].includes(String(run.conclusion));
}
function conflict(base: string): Verdict {
  return { code: 3, text: `checks: CONFLICT with ${base}: merge origin/${base}, push, run again` };
}

/** Keep the failing step, useful errors and test totals within a short digest. */
function digestLog(log: string): string {
  const lines = stripVTControlCharacters(log)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\dT:.Z-]{20,} /, "").replace(/^#\d+ [\d.]+ /, ""));
  let part: string[] = [];
  for (const line of lines) {
    if (/^##\[group\]Run /.test(line)) {
      part = [];
    }
    part.push(line);
    if (/##\[error\]Process completed with exit code/.test(line)) {
      break;
    }
  }
  let context = 0;
  const selected = part.filter((line) => {
    if (/^\s*FAIL /.test(line)) {
      context = 12;
    }
    if (/Test Files|^\s*Tests +/.test(line)) {
      return false;
    }
    if (context > 0) {
      context--;
      return true;
    }
    return /error TS\d+|\d+:\d+ +error |\[warn\]|^ERROR: |^Error: |^##\[error\]|^\/.*\.(ts|tsx|js|mjs|cjs)$/.test(
      line
    );
  });
  const totals = part.filter((line) => /Test Files|^\s*Tests +/.test(line)).slice(-4);
  return [...(selected.length ? selected : part.slice(-25)).slice(0, 50), ...totals]
    .map((line) => line.slice(0, 220))
    .join("\n");
}
