import { heading } from "../../core/protocol.js";
import { object, type ObjectData } from "../people.js";
import { repoOf, restActor } from "../../github/diagnostic.js";
import { inheritAutopilot } from "../../evidence/autopilot.js";
import { isTaskPrompt, taskIssueNumbers } from "../../tasks/markers.js";
import { GitTransport, taskBranch, validateBranch } from "../git.js";
import { reference } from "../refs.js";
import type { GatewayServices } from "../server.js";
import type { Handler } from "./types.js";

/** Stop delegation on an accepted local thread; watcher reconciles its task turn. */
export const autopilotStop: Handler<"autopilotStop"> = async function ({ ref, kind }) {
  if (kind !== "issue" && kind !== "pr") {
    throw new Error("Expected issue or pr");
  }
  const number = this.localNumber(ref);
  const item = await this.flowThread(String(number), kind);
  if ((object(item.labels).nodes as ObjectData[]).some((label) => label.name === "autopilot")) {
    await this.github.rest(
      `/repos/${this.config.repo}/issues/${number}/labels/autopilot`,
      "DELETE"
    );
    await this.github.rest(
      `/repos/${this.config.repo}/issues/${number}/comments`,
      "POST",
      {
        body: `${heading("AUTOPILOT")}\n\nStopped autopilot; control returns to the owner at the current step. Completed work is not reverted.`,
      },
      false
    );
  }
  return `Autopilot stopped on #${number}`;
};

/** Re-run open-task's authenticated grant copy on an accepted task PR (#249): a
 * watcher cleanup or a failed first inheritance is repaired by a live issue grant. */
export const autopilotInherit: Handler<"autopilotInherit"> = async function ({ ref }) {
  const number = this.localNumber(ref);
  const pr = await this.flowThread(String(number), "pr");
  const issues = taskIssueNumbers(String(pr.body)) ?? [];
  if (!issues.length) {
    throw new Error(`No linked task issue to inherit the autopilot grant from on #${number}`);
  }
  for (const issue of issues) {
    const item = await this.flowThread(String(issue), "issue");
    if (
      await inheritAutopilot(
        this.github,
        this.filter,
        this.config,
        item,
        pr,
        `${heading("AUTOPILOT")}\n\nCopied the task issue's owner-authorized autopilot grant onto this PR.`
      )
    ) {
      return `Autopilot grant copied from #${issue} to #${number}`;
    }
  }
  throw new Error(`No live autopilot grant on the task's linked issues: ${issues.join(", ")}`);
};

export const openTask: Handler<"openTask"> = async function (input) {
  return this.flow.open(input);
};

export const prOpen: Handler<"prOpen"> = async function (input) {
  return this.flow.openPr(input);
};

export const prMerge: Handler<"prMerge"> = async function (input) {
  return this.flow.mergePr(input.ref);
};

export const reviewTask: Handler<"reviewTask"> = async function (input) {
  return this.flow.review(input);
};

export const askIssue: Handler<"askIssue"> = async function (input) {
  return this.flow.ask(input.ref, input.file);
};

export const mergeTask: Handler<"mergeTask"> = async function (input) {
  return this.flow.merge(input.ref, input.mergeCommit, input.carryApproval);
};

export const closeTask: Handler<"closeTask"> = async function (input) {
  return this.flow.close(input.ref, input.comment);
};

export const linkTask: Handler<"linkTask"> = async function (input) {
  return this.flow.link(input.ref, input.complete, input.unlink);
};

export const releaseHold: Handler<"releaseHold"> = async function (input) {
  return this.flow.release(input.ref);
};

export const workerStatus: Handler<"workerStatus"> = async function (input) {
  await this.flowThread(input.ref, "pr");
  return this.flow.status(input.ref);
};

export const resolveTask: Handler<"resolveTask"> = async function ({ branch }) {
  validateBranch(branch);
  const repo = this.config.repo ?? "undefined";
  const owner = repo.split("/")[0];
  const listed = await this.github.rest(
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`
  );
  if (!Array.isArray(listed)) {
    throw new Error("Missing pull request list");
  }
  // Do not guess between several results, even if only one would pass identity filtering.
  if (listed.length !== 1) {
    return null;
  }
  const candidate = object(listed[0]);
  const head = object(candidate.head);
  if (
    candidate.state !== "open" ||
    head.ref !== branch ||
    String(object(head.repo).full_name).toLowerCase() !== repo.toLowerCase() ||
    !Number.isSafeInteger(candidate.number) ||
    Number(candidate.number) < 1
  ) {
    return null;
  }
  const ref = String(candidate.number);
  const link = reference(ref, this.config).link;
  if (!this.filter.accept({ author: restActor(candidate.user) }, owner, link)) {
    return null;
  }
  const meta = await this.thread(ref, "pr");
  if (!meta.person) {
    return null;
  }
  const current = await this.node(
    String(meta.item.id),
    "body state headRefName headRepository { nameWithOwner }",
    "PullRequest"
  );
  if (
    !this.filter.accept(current, repoOf(current).owner, link) ||
    current.state !== "OPEN" ||
    current.headRefName !== branch ||
    String(object(current.headRepository).nameWithOwner).toLowerCase() !== repo.toLowerCase()
  ) {
    return null;
  }
  const body = String(current.body ?? "");
  if (!isTaskPrompt(body)) {
    return null;
  }
  return Number(ref);
};

export const task: Handler<"task"> = async function ({ ref, fetch }) {
  const { branch, base } = await this.checkedTask(ref);
  if (fetch) {
    if (
      !(await new GitTransport(this.config, this.env, this.deps, this.root).transferOk("fetch", [
        `+refs/heads/${base}:refs/remotes/origin/${base}`,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]))
    ) {
      throw new Error("error: fetch failed");
    }
  }
  return { branch, base };
};

export async function checkedTask(this: GatewayServices, ref: string, requirePrompt = false) {
  const { item: meta, person } = await this.thread(ref, "pr");
  if (!person) {
    throw new Error("No accepted task PR");
  }
  const item = requirePrompt
    ? await this.node(
        String(meta.id),
        "body state headRefOid headRefName baseRefName headRepository { nameWithOwner }",
        "PullRequest"
      )
    : meta;
  if (
    requirePrompt &&
    (!this.filter.accept(item, repoOf(item).owner, reference(ref, this.config).link) ||
      !isTaskPrompt(String(item.body ?? "")))
  ) {
    throw new Error("Push requires an open task PR");
  }
  const branch = String(item.headRefName ?? "");
  const base = String(item.baseRefName ?? "");
  taskBranch(branch, this.config);
  validateBranch(base);
  if (
    String(object(item.headRepository).nameWithOwner).toLowerCase() !==
    (this.config.repo ?? "undefined").toLowerCase()
  ) {
    throw new Error("Task branch must belong to the configured repository");
  }
  if (item.state !== "OPEN") {
    throw new Error("Task PR is not open");
  }
  return { branch, base, item };
}
