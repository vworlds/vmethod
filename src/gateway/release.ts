import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { liveBaseHead } from "./base-head.js";
import { GitHubHttpError, type Dependencies, type GitHubClient } from "./client.js";
import { GitTransport, validateBranch } from "./git.js";
import { object, type ObjectData } from "./people.js";

const workflow = "publish.yml";
const boundMinutes = 30;
const jobPages = 10;
const success = ["success", "neutral", "skipped"];

/**
 * Orchestrator-only release publication (#308). Refuses before any write unless
 * the checkout sits on `baseBranch` with its local head at the remote head,
 * then dispatches the publish workflow on that branch, waits for the dispatched
 * run with a bound, and reports the published version, the npm `next` dist-tag,
 * the git tag and the GitHub release URL. A red run reports its failed step and
 * the run URL. The owner's go for a release stays a separate decision.
 */
export async function releaseNext(
  root: string,
  config: Config,
  env: NodeJS.ProcessEnv,
  deps: Dependencies,
  github: () => GitHubClient
): Promise<string> {
  const repo = String(config.repo);
  const base = String(config.baseBranch);
  validateBranch(base);
  const git = new GitTransport(config, env, deps, root);
  const branch = (await git.run("rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (branch !== base) {
    throw new Error(`release next requires the checkout on ${base}; it is on ${branch}`);
  }
  const local = commit((await git.run("rev-parse", "HEAD")).trim());
  // The remote read is authoritative; a stale origin/<base> in the checkout is
  // a divergence, not an acceptable match.
  const remote = await liveBaseHead(base, { github: github(), repo });
  if (local !== remote) {
    throw new Error(
      `local ${base} head ${local.slice(0, 8)} differs from remote ${remote.slice(0, 8)}; fetch, merge or push first`
    );
  }
  const before = await runBaseline(github(), repo);
  await dispatch(github(), repo, base);
  const run = await dispatchedRun(deps, github, repo, base, remote, before);
  const url = runUrl(repo, run);
  if (run.conclusion !== "success") {
    const failed = await failedSteps(github(), repo, Number(run.id));
    throw new Error(
      `release next: RED: ${failed.join(", ") || "no failed step reported"}; run: ${url}`
    );
  }
  const name = packageName(root);
  const data = object(JSON.parse(await registry(deps, name)));
  const tags = object(data["dist-tags"]);
  const version = typeof tags.next === "string" ? tags.next : "";
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) {
    throw new Error(`the registry has no stable or RC next dist-tag for ${name}; inspect npm`);
  }
  const gitHead = String(object(object(data.versions)[version]).gitHead ?? "");
  if (gitHead !== remote) {
    throw new Error(
      `the npm next dist-tag publishes ${version} from ${gitHead ? gitHead.slice(0, 8) : "<unknown>"}, not ${remote.slice(0, 8)}; inspect the registry`
    );
  }
  const tag = `v${version}`;
  try {
    const ref = object(
      await github().rest(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`)
    );
    if (String(ref.ref) !== `refs/tags/${tag}` || !object(ref.object).sha) {
      throw new Error(`the git tag response does not name ${tag}; inspect the repository`);
    }
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) {
      throw new Error(
        `the publish run was green but the git tag ${tag} is missing; rerun the workflow to repair missing release metadata`,
        { cause: error }
      );
    }
    throw error;
  }
  let releaseUrl: string;
  try {
    const release = object(
      await github().rest(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
    );
    releaseUrl = String(release.html_url);
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) {
      throw new Error(
        `the publish run was green but the GitHub release for ${tag} is missing; rerun the workflow to repair missing release metadata`,
        { cause: error }
      );
    }
    throw error;
  }
  if (!releaseUrl.startsWith(`https://github.com/${repo}/releases/tag/`)) {
    throw new Error(`the GitHub release URL ${releaseUrl} does not match the tag ${tag}`);
  }
  return [
    `Published ${name}@${version}`,
    `npm next: ${version}`,
    `git tag: ${tag}`,
    `release: ${releaseUrl}`,
    `run: ${url}`,
  ].join("\n");
}

async function dispatch(github: GitHubClient, repo: string, base: string): Promise<void> {
  await github.rest(
    `/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    "POST",
    { ref: base },
    false
  );
}

const runsPath = (repo: string) => `/repos/${repo}/actions/workflows/${workflow}/runs`;

/** The newest publish run id known before the dispatch. */
async function runBaseline(github: GitHubClient, repo: string): Promise<number> {
  const known = (await listRuns(github, repo))
    .map((run) => Number(run.id))
    .filter((id) => Number.isSafeInteger(id) && id >= 1);
  return known.length ? Math.max(...known) : 0;
}

async function listRuns(github: GitHubClient, repo: string): Promise<ObjectData[]> {
  const listed = object(
    await github.rest(`${runsPath(repo)}?event=workflow_dispatch&per_page=100&page=1`)
  );
  if (!Array.isArray(listed.workflow_runs)) {
    throw new Error("Invalid publish workflow run list");
  }
  return listed.workflow_runs.map(object);
}

/** The first publish run created after the dispatch, completed or red-flagged. */
async function dispatchedRun(
  deps: Dependencies,
  github: () => GitHubClient,
  repo: string,
  base: string,
  remote: string,
  before: number
): Promise<ObjectData> {
  const started = deps.now();
  const deadline = started + boundMinutes * 60000;
  let run: ObjectData | undefined;
  let reason = "the dispatched run is not registered yet";
  for (;;) {
    const newer = (await listRuns(github(), repo))
      .filter(
        (entry) =>
          Number.isSafeInteger(Number(entry.id)) &&
          Number(entry.id) > before &&
          entry.event === "workflow_dispatch" &&
          entry.head_branch === base
      )
      .sort((a, b) => Number(a.id) - Number(b.id));
    run = newer[0];
    if (run !== undefined) {
      const url = runUrl(repo, run);
      const head = commit(String(run.head_sha ?? ""));
      if (head !== remote) {
        throw new Error(
          `the publish run ${url} was created on head ${head.slice(0, 8)}, not ${remote.slice(0, 8)}; a push raced the dispatch, inspect the run before retrying`
        );
      }
      if (run.status === "completed") {
        return run;
      }
      reason = "the dispatched run is still publishing";
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(
        `the publish run did not complete within ${boundMinutes} minutes (${reason}); run: ${run ? runUrl(repo, run) : "(not registered)"} and run release next again`
      );
    }
    await deps.sleep(Math.min(10000, remaining));
  }
}

function commit(value: string): string {
  if (!/^[a-f\d]{40}$/i.test(value)) {
    throw new Error("Missing Git object SHA");
  }
  return value;
}

function runUrl(repo: string, run: ObjectData): string {
  const url = String(run.html_url ?? "");
  if (!url.startsWith(`https://github.com/${repo}/actions/runs/`)) {
    throw new Error("Invalid publish run URL");
  }
  return url;
}

/** Failed step names per job, bounded; a failed job without steps names itself. */
async function failedSteps(github: GitHubClient, repo: string, runId: number): Promise<string[]> {
  const output: string[] = [];
  for (let page = 1; ; page++) {
    const result = object(
      await github.rest(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`)
    );
    if (!Array.isArray(result.jobs)) {
      throw new Error("Invalid publish run job list");
    }
    for (const value of result.jobs) {
      const job = object(value);
      if (!Number.isSafeInteger(job.id) || Number(job.id) < 1 || typeof job.name !== "string") {
        throw new Error("Invalid publish run job");
      }
      if (success.includes(String(job.conclusion))) {
        continue;
      }
      const steps = (Array.isArray(job.steps) ? job.steps.map(object) : [])
        .filter((step) => step.conclusion != null && !success.includes(String(step.conclusion)))
        .map((step) => `${job.name} / ${step.name}`.slice(0, 200));
      output.push(...(steps.length ? steps : [`${job.name} / no failed step reported`]));
    }
    if (result.jobs.length < 100 || page >= jobPages) {
      break;
    }
  }
  return output;
}

function packageName(root: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("release next requires the checkout root package.json", { cause: error });
    }
    throw error;
  }
  const name = String(object(parsed).name ?? "");
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name)) {
    throw new Error("release next requires the checkout's npm package name in package.json");
  }
  return name;
}

async function registry(deps: Dependencies, name: string): Promise<string> {
  const response = await deps.fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Registry HTTP ${response.status}`);
  }
  return response.text();
}
