import { type WorktreeTask } from "../worktrees.js";
import { object, type ObjectData } from "../people.js";
import { repoOf, restActor } from "../../github/diagnostic.js";
import { workflowLabels } from "../../evidence/autopilot.js";
import { isTaskPrompt, taskHeader } from "../../tasks/markers.js";
import { type TaskMetadata } from "../workers.js";
import { reference } from "../refs.js";
import type { GatewayServices } from "../server.js";
import type { Handler } from "./types.js";

export const worker: Handler<"worker"> = async function ({ args }) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Invalid worker arguments");
  }
  if (args[0] === "worktrees") {
    if (args.length > 2 || (args[1] && args[1] !== "--prune")) {
      throw new Error("Usage: vmethod worktrees [--prune]");
    }
    return this.worktrees.list((branch) => this.worktreeTaskFor(branch), args[1] === "--prune");
  }
  if (args[0] === "stop" && args.length === 3 && args[2] === "--cleanup") {
    const pr = this.localNumber(args[1]);
    const task = await this.worktreeTask(pr);
    const stopped = await this.workers.command(args.slice(0, 2));
    const cleaned = await this.worktrees.cleanup(task);
    return `${typeof stopped === "string" ? stopped : stopped.text}\nWorktree cleanup ${cleaned ? "complete" : "skipped; see safety report"}`;
  }
  return this.workers.command(args);
};

export const grade: Handler<"grade"> = async function ({ ref, points }) {
  return this.workers.grade(this.localNumber(ref), points);
};

export const suggestModel: Handler<"suggestModel"> = async function ({ ref }) {
  const suggestion = await this.workers.suggest(this.localNumber(ref));
  const family = suggestion.split(":", 1)[0];
  return `${suggestion}\n${await this.learningService().show(family)}`;
};

export const limits: Handler<"limits"> = async function () {
  return this.workers.limits();
};

export async function worktreeTask(this: GatewayServices, pr: number): Promise<WorktreeTask> {
  const item = await this.flowThread(String(pr), "pr");
  if (
    object(item.headRepository).nameWithOwner !== this.config.repo ||
    !isTaskPrompt(String(item.body))
  ) {
    throw new Error("Cleanup requires a same-repository task PR");
  }
  return {
    pr,
    branch: String(item.headRefName),
    base: String(item.baseRefName),
    head: String(item.headRefOid),
    state: String(item.state),
  };
}

export async function worktreeTaskFor(
  this: GatewayServices,
  branch: string
): Promise<WorktreeTask | undefined> {
  const tasks: number[] = [];
  for (let page = 1; ; page++) {
    const data = await this.github.rest(
      `/repos/${this.config.repo}/pulls?state=all&head=${encodeURIComponent(`${this.config.repo.split("/")[0]}:${branch}`)}&per_page=100&page=${page}`
    );
    if (!Array.isArray(data)) {
      throw new Error("Missing worktree PR listing");
    }
    for (const value of data) {
      const item = object(value);
      // Do not read the bodies/threads of unaccepted authors or foreign heads.
      if (
        object(object(item.head).repo).full_name !== this.config.repo ||
        object(item.head).ref !== branch
      ) {
        continue;
      }
      // An open or unaccepted PR on this same branch makes old closed mappings unsafe.
      if (!this.filter.identity(restActor(item.user)) || item.state === "open") {
        return undefined;
      }
      if (isTaskPrompt(String(item.body)) && Number.isSafeInteger(item.number)) {
        tasks.push(Number(item.number));
      }
    }
    if (data.length < 100) {
      break;
    }
  }
  // Ambiguous branch reuse is never a deletion candidate.
  return tasks.length === 1 ? this.worktreeTask(tasks[0]) : undefined;
}

export function localNumber(this: GatewayServices, ref: string): number {
  const target = reference(ref, this.config);
  if (target.repo.toLowerCase() !== this.config.repo.toLowerCase()) {
    throw new Error("Worker operations require configured repository");
  }
  return target.number;
}

export function projectCard(this: GatewayServices, item: ObjectData): ObjectData {
  const nodes = object(item.projectItems).nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("Missing task project metadata");
  }
  return object(
    nodes.find(
      (value) =>
        object(object(value).project).number === this.config.board?.number &&
        String(object(object(object(value).project).owner).login).toLowerCase() ===
          this.config.board.owner.toLowerCase()
    )
  );
}

export function projectValue(this: GatewayServices, item: ObjectData, field: string): unknown {
  const fields = object(this.projectCard(item).fieldValues);
  if (object(fields.pageInfo).hasNextPage === true) {
    throw new Error("Incomplete project field values");
  }
  const values = fields.nodes;
  if (!Array.isArray(values)) {
    return undefined;
  }
  const value = object(values.find((v) => object(object(v).field).name === field));
  return value.number ?? value.name ?? value.text;
}

export async function richThread(
  this: GatewayServices,
  ref: number,
  kind: "pr" | "issue"
): Promise<ObjectData> {
  const { item, person, link } = await this.thread(String(ref), kind);
  if (!person) {
    throw new Error("No accepted task thread");
  }
  const type = kind === "pr" ? "PullRequest" : "Issue";
  const fields = `title body state ${kind === "pr" ? "isDraft merged closedAt headRefOid baseRefOid changedFiles additions deletions headRefName baseRefName closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } }" : "labels(first: 100) { nodes { name } } blockedBy(first: 100) { nodes { state } pageInfo { hasNextPage } }"} projectItems(first: 100) { nodes { id isArchived project { number owner { ... on Organization { login } ... on User { login } } } fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }`;
  const result = await this.node(String(item.id), fields, type);
  if (!this.filter.accept(result, repoOf(result).owner, link)) {
    throw new Error("Task identity changed during read");
  }
  if (object(object(result.projectItems).pageInfo).hasNextPage === true) {
    throw new Error("Too many project memberships; refusing incomplete metadata");
  }
  return result;
}

export async function setWorkerField(
  this: GatewayServices,
  ref: number,
  kind: "pr" | "issue",
  field: "Estimate" | "Model" | "Cost",
  value: number | string | null
): Promise<string | undefined> {
  const item = await this.richThread(ref, kind);
  const card = this.projectCard(item);
  if (typeof card.id !== "string") {
    throw new Error("Task has no card on configured board");
  }
  if (card.isArchived === true) {
    // #267: GitHub refuses item writes on archived cards, so grade must never
    // attempt them: an unchanged value needs no item write (docs/board.md),
    // and a changed value goes through the verified unarchive, set and archive
    // sequence. The card stays archived and the value stays correct; grade
    // reports whichever outcome the card took.
    const cardName = kind === "pr" ? "PR" : "issue";
    if (this.projectValue(item, field) === value) {
      return value === null
        ? `${field} unchanged on the archived ${cardName} card`
        : `${field} unchanged on the archived ${cardName} card (already ${value})`;
    }
    await this.board.setArchivedCard({ itemId: card.id, field, value });
    return `${field} set on the archived ${cardName} card via unarchive/archive`;
  }
  if (field === "Cost" && this.projectValue(item, field) === value) {
    return;
  }
  await this.board.set({ itemId: card.id, field, value });
}

export async function workerIssue(
  this: GatewayServices,
  issue: number
): Promise<{ estimate?: number; kind: string }> {
  const item = await this.richThread(issue, "issue");
  const estimate = this.projectValue(item, "Estimate");
  const labels = object(item.labels).nodes;
  return {
    estimate: typeof estimate === "number" ? estimate : undefined,
    kind: Array.isArray(labels)
      ? labels
          .map((v) => String(object(v).name))
          .filter((name) => !workflowLabels.includes(name as (typeof workflowLabels)[number]))
          .join(", ") || "other"
      : "other",
  };
}

export async function workerMetadata(this: GatewayServices, pr: number): Promise<TaskMetadata> {
  await this.task({ ref: String(pr) }, { role: "orchestrator" }).catch((error: Error) => {
    // Closed deliveries are valid grading targets; all other task guards remain mandatory.
    if (error.message !== "Task PR is not open") {
      throw error;
    }
  });
  const item = await this.richThread(pr, "pr");
  // Refuse incomplete metadata rather than rendering "undefined" in prompts.
  if (typeof item.baseRefName !== "string" || !item.baseRefName) {
    throw new Error("Missing PR base branch");
  }
  const links = object(item.closingIssuesReferences);
  if (object(links.pageInfo).hasNextPage === true) {
    throw new Error("Too many linked issues");
  }
  const numbers = new Set<number>();
  if (Array.isArray(links.nodes)) {
    for (const value of links.nodes) {
      const issue = object(value);
      if (object(issue.repository).nameWithOwner !== this.config.repo) {
        throw new Error("Linked issue belongs to another repository");
      }
      numbers.add(Number(issue.number));
    }
  }
  // Draft task prompts deliberately avoid closing keywords, so also accept the explicit task issue header.
  const body = String(item.body ?? "");
  // The metadata reader's historical acceptance: any line, a lazy title, no line-end bound.
  const header = taskHeader(body, { anchor: "any line", title: "any text", end: "anywhere" });
  if (header) {
    numbers.add(header.issue);
  }
  if (numbers.size > 1) {
    throw new Error("Task PR has ambiguous linked issues");
  }
  const issue = [...numbers][0];
  let estimate: number | undefined,
    kind = "other",
    blocked = false,
    ownerPaused = false;
  if (issue) {
    const linked = await this.richThread(issue, "issue");
    ownerPaused =
      this.projectValue(linked, "Status") === "Executing" &&
      /^👤(?:❓|🔍)/u.test(String(this.projectValue(linked, "Progress") ?? ""));
    const n = this.projectValue(linked, "Estimate");
    estimate = typeof n === "number" ? n : undefined;
    const blockers = object(linked.blockedBy);
    if (!Array.isArray(blockers.nodes) || object(blockers.pageInfo).hasNextPage !== false) {
      throw new Error("Missing or incomplete blocked-by metadata");
    }
    blocked = blockers.nodes.some((v) => object(v).state === "OPEN");
    const labels = object(linked.labels).nodes;
    kind = Array.isArray(labels)
      ? labels
          .map((v) => String(object(v).name))
          .filter((name) => !workflowLabels.includes(name as (typeof workflowLabels)[number]))
          .join(", ") || "other"
      : "other";
  }
  const comments: TaskMetadata["comments"] = [];
  for (const meta of await this.collection(String(item.id), "PullRequest", "comments")) {
    if (
      !this.filter.accept(
        meta,
        repoOf(meta).owner,
        `https://github.com/${this.config.repo}/pull/${pr}`
      )
    ) {
      continue;
    }
    const comment = await this.node(String(meta.id), "body createdAt url", "IssueComment");
    const author = this.filter.accept(
      comment,
      repoOf(comment).owner,
      `https://github.com/${this.config.repo}/pull/${pr}`
    );
    if (!author || this.filter.identity(comment.author)?.role !== author.role) {
      continue;
    }
    const date = String(comment.lastEditedAt ?? comment.createdAt);
    if (Number.isFinite(Date.parse(date)) && typeof comment.body === "string") {
      comments.push({
        body: comment.body,
        role: this.learningRole(author),
        date,
        url: typeof comment.url === "string" ? comment.url : undefined,
      });
    }
  }
  const snapshot =
    /<!--\s*points_open:\s*(\d+(?:\.\d+)?)\s*-->/.exec(body) ??
    /\*\*Estimate:\*\*\s*(\d+(?:\.\d+)?)/.exec(body);
  const model = this.projectValue(item, "Model");
  const progress = this.projectValue(item, "Progress");
  return {
    pr,
    issue,
    base: item.baseRefName,
    branch: String(item.headRefName),
    title: String(item.title),
    body,
    state: String(item.state),
    draft: item.isDraft === true,
    blocked,
    ownerPaused:
      ownerPaused ||
      (this.projectValue(item, "Status") === "Executing" &&
        /^👤(?:❓|🔍)/u.test(String(progress ?? ""))),
    progress: typeof progress === "string" ? progress : undefined,
    estimate,
    pointsOpen: snapshot ? Number(snapshot[1]) : undefined,
    model: typeof model === "string" ? model : undefined,
    kind,
    merged: item.merged === true,
    closedAt: typeof item.closedAt === "string" ? item.closedAt : undefined,
    headOid: typeof item.headRefOid === "string" ? item.headRefOid : undefined,
    baseOid: typeof item.baseRefOid === "string" ? item.baseRefOid : undefined,
    diff: [item.changedFiles, item.additions, item.deletions].every(
      (n) => Number.isSafeInteger(n) && Number(n) >= 0
    )
      ? {
          files: Number(item.changedFiles),
          additions: Number(item.additions),
          deletions: Number(item.deletions),
        }
      : null,
    comments,
  };
}
