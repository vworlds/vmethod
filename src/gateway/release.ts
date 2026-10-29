import { readFileSync } from "node:fs";
import { restPages } from "../github/pages.js";
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
  // Publish evidence is the green run plus the pushed tag and release; npm's
  // `next` dist-tag must agree when it is visible, but registry propagation
  // can lag the publish by minutes (rc.10 served `next: 1.0.0-rc.9` for about
  // four minutes on 2026-10-27), so the tag that names the released head
  // settles the version when npm does not.
  const npmNext = await nextVersion(deps, name, remote);
  let version: string;
  let tag: string;
  let warning: string;
  if (npmNext === undefined) {
    const pushed = await pushedTag(github(), repo, remote);
    version = pushed.version;
    tag = pushed.tag;
    warning = `npm next not visible yet (registry propagation); check later with npm view ${name} dist-tags`;
  } else {
    version = npmNext;
    tag = `v${version}`;
    warning = `npm next: ${version}`;
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
    warning,
    `git tag: ${tag}`,
    `release: ${releaseUrl}`,
    `run: ${url}`,
  ].join("\n");
}

const propagationBound = 600000;
const propagationInterval = 15000;
const versionShape = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
const tagName = /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

/** The published version named by `next`, once the registry carries this release.
 * Stale snapshots naming an older release are propagation, not evidence against
 * this one, so any non-matching state polls on (rc.10's 2026-10-27 lag); a
 * wrong gitHead is an integrity error only where the released version is
 * already visible to contradict the lag. Availability poll: every 15 s, up to
 * 10 minutes, before the tag and release become the authoritative version
 * evidence (#310). */
async function nextVersion(
  deps: Dependencies,
  name: string,
  remote: string
): Promise<string | undefined> {
  const deadline = deps.now() + propagationBound;
  for (;;) {
    let data: ObjectData | undefined;
    try {
      data = object(JSON.parse(await registry(deps, name)));
    } catch {
      // An unreadable registry is an availability lag; poll on within the bound.
    }
    if (data !== undefined) {
      const named = namedVersions(data, remote);
      if (named.length > 1) {
        throw new Error(
          `the registry names multiple published versions for ${remote.slice(0, 8)}; inspect npm`
        );
      }
      const version = named[0];
      if (version !== undefined) {
        const tags = object(data["dist-tags"]);
        const next = typeof tags.next === "string" ? tags.next : "";
        if (next === version) {
          return version;
        }
        // The released version is visible, so lag cannot explain the dist-tag:
        // report a head it does name, or its absence, as an integrity error.
        if (versionShape.test(next)) {
          const head = String(object(object(data.versions)[next]).gitHead ?? "");
          const from = /^[a-f\d]{40}$/i.test(head) ? head.slice(0, 8) : "<unknown>";
          throw new Error(
            `the npm next dist-tag publishes ${next} from ${from}, not ${remote.slice(0, 8)}; inspect the registry`
          );
        }
        throw new Error(`the npm next dist-tag does not name ${version}; inspect the registry`);
      }
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      return undefined;
    }
    await deps.sleep(Math.min(propagationInterval, remaining));
  }
}

/** Stable and release-candidate version names whose manifest records this head. */
function namedVersions(data: ObjectData, remote: string): string[] {
  const versions = object(data.versions);
  return Object.entries(versions)
    .map(([name, value]) => ({ name, head: String(object(value).gitHead) }))
    .filter(
      (entry) =>
        versionShape.test(entry.name) &&
        /^[a-f\d]{40}$/i.test(entry.head) &&
        entry.head.toLowerCase() === remote.toLowerCase()
    )
    .map((entry) => entry.name);
}

/** The single version tag the publish workflow pushed at the released commit
 * (lightweight tags point at the commit); used when npm stays invisible. */
async function pushedTag(
  github: GitHubClient,
  repo: string,
  remote: string
): Promise<{ tag: string; version: string }> {
  const listed = await github.rest(`/repos/${repo}/git/matching-refs/tags/v`);
  if (!Array.isArray(listed)) {
    throw new Error("Invalid version tag list");
  }
  const pushed = listed
    .map(object)
    .filter(
      (ref) =>
        tagName.test(String(ref.ref).replace(/^refs\/tags\//, "")) &&
        object(ref.object).type === "commit" &&
        /^[a-f\d]{40}$/i.test(String(object(ref.object).sha)) &&
        String(object(ref.object).sha).toLowerCase() === remote.toLowerCase()
    )
    .map((ref) => String(ref.ref).slice("refs/tags/".length));
  if (pushed.length !== 1) {
    throw new Error(
      `the publish run was green but ${pushed.length > 1 ? "ambiguous version tags name" : `no version tag for ${remote.slice(0, 8)} names`} the release; rerun the workflow to repair missing release metadata`
    );
  }
  return { tag: pushed[0], version: pushed[0].slice(1) };
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
  for await (const jobs of restPages(
    async (page) => {
      const result = object(
        await github.rest(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`)
      );
      return result.jobs;
    },
    { error: "Invalid publish run job list", size: 100, limit: jobPages }
  )) {
    for (const value of jobs) {
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
