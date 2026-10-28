import type { GitHubClient } from "./client.js";
import { validateLearningPr } from "./learning-check.js";
import { object, type ObjectData, type PeopleFilter } from "./people.js";

const central = "vworlds/vmethod";
const org = "vworlds";
const checkRunPages = 30;

/**
 * Orchestrator-only squash merge of one authorized learning submission (#308).
 * Every refusal happens before the merge write: the PR must be open, carry the
 * `learning` label that central automation applies, pass the full add-only
 * check-pr validation against the pinned-base registry, and have the central
 * `check` job green on its exact head. The merge pins the validated head and
 * reports the squash commit.
 */
export async function mergeLearningPr(
  github: GitHubClient,
  filter: PeopleFilter,
  pr: number
): Promise<string> {
  const link = `https://github.com/${central}/pull/${pr}`;
  const metadata = object(await github.rest(`/repos/${central}/pulls/${pr}`));
  const head = object(metadata.head);
  const base = object(metadata.base);
  if (
    metadata.state !== "open" ||
    !/^[a-f\d]{40}$/i.test(String(head.sha)) ||
    !/^[a-f\d]{40}$/i.test(String(base.sha))
  ) {
    throw new Error(`Learning PR #${pr} is not an open PR with valid head/base metadata`);
  }
  if (
    !Array.isArray(metadata.labels) ||
    !metadata.labels.some((label) => object(label).name === "learning")
  ) {
    throw new Error(
      `Learning PR #${pr} carries no learning label; central automation labels authorized submissions`
    );
  }
  if (
    typeof metadata.title !== "string" ||
    !metadata.title.trim() ||
    /[\r\n]/.test(metadata.title)
  ) {
    throw new Error(`Learning PR #${pr} has no single-line title for the squash message`);
  }
  // The full add-only validation reads the pinned-base registry and rechecks
  // refs after the changed-file read; label=false never writes.
  await validateLearningPr(github, metadata, pr, false, true);
  await greenCheck(github, filter, pr, String(head.sha), link);
  const pin = object(await github.rest(`/repos/${central}/pulls/${pr}`));
  if (
    pin.state !== "open" ||
    object(pin.head).sha !== String(head.sha) ||
    object(pin.base).sha !== String(base.sha) ||
    object(pin.head).ref !== String(head.ref) ||
    pin.title !== metadata.title
  ) {
    throw new Error(`Learning PR #${pr} moved during validation; retry`);
  }
  const merged = object(
    await github.rest(
      `/repos/${central}/pulls/${pr}/merge`,
      "PUT",
      {
        sha: String(head.sha),
        merge_method: "squash",
        commit_title: `${metadata.title} (#${pr})`,
      },
      false
    )
  );
  if (merged.merged !== true || !/^[a-f\d]{40}$/.test(String(merged.sha))) {
    throw new Error("Learning merge was refused; re-run to reconcile state");
  }
  return `Merged learning PR #${pr} at ${String(merged.sha)}`;
}

/** The trusted `check` job must be green on exactly this head. */
async function greenCheck(
  github: GitHubClient,
  filter: PeopleFilter,
  pr: number,
  head: string,
  link: string
): Promise<void> {
  const latest = new Map<string, ObjectData>();
  for (let page = 1; ; page++) {
    const result = object(
      await github.rest(
        `/repos/${central}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`
      )
    );
    if (!Array.isArray(result.check_runs)) {
      throw new Error("Missing learning PR check runs");
    }
    for (const value of result.check_runs) {
      const run = object(value);
      // A conclusion from an application the registry does not pin is not evidence.
      if (run.head_sha !== head || filter.check(run, org, link) === undefined) {
        continue;
      }
      if (!Number.isSafeInteger(run.id) || Number(run.id) < 1 || typeof run.name !== "string") {
        throw new Error("Invalid learning PR check run");
      }
      const key = JSON.stringify([object(run.app).id, run.name]);
      if (!latest.has(key) || Number(latest.get(key)?.id) < Number(run.id)) {
        latest.set(key, run);
      }
    }
    if (result.check_runs.length < 100) {
      break;
    }
    if (page >= checkRunPages) {
      throw new Error("Learning PR check-run pagination limit reached");
    }
  }
  const check = [...latest.values()].find((run) => run.name === "check");
  if (check === undefined) {
    throw new Error(
      `Learning PR #${pr} has no trusted check verdict on ${head.slice(0, 8)}; run again`
    );
  }
  if (
    check.status !== "completed" ||
    !["success", "neutral", "skipped"].includes(String(check.conclusion))
  ) {
    throw new Error(
      `Learning PR #${pr} check job is not green on ${head.slice(0, 8)}: ${String(check.conclusion)}`
    );
  }
}
