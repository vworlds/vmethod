import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { assertEstimate } from "../board/estimate.js";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadYaml, type Config } from "../config.js";
import { type Dependencies, type GitHubClient } from "./client.js";
import { type BoardService } from "./board.js";
import { object, type ObjectData, type Person } from "./people.js";
import { checkMarkdown, guardClosingKeywords } from "./markdown.js";
import { GitTransport, taskBranch, validateBranch } from "./git.js";
import { cleanBaseMerges } from "./clean-base.js";
import { liveBaseHead } from "./base-head.js";
import { approvalCarryFiles } from "./carry-approval.js";
import type { OpenTaskInput, ReviewInput } from "./task-flow-types.js";
import { taskIssueNumbers, taskRelation } from "./task-flow-types.js";
import { setTurn, turnAssignees } from "./turn.js";
import { holdBanner, taskHeld, withoutHold } from "./task-hold.js";
import { runVerifyHook } from "./verify-hook.js";
import { WorktreeService } from "./worktrees.js";

interface Host {
  thread(ref: string, kind: "pr" | "issue"): Promise<ObjectData>;
  comments(id: string): Promise<ObjectData[]>;
  approved(ref: string, historical?: string): Promise<boolean | "unknown">;
  candidates(ref: string): Promise<string[]>;
  issueApproved(item: ObjectData): Promise<boolean | "unknown">;
  github: GitHubClient;
  board: () => Pick<BoardService, "ensure" | "set" | "capDone" | "snapshot" | "cards">;
  people: Person[];
}
interface Journal {
  head: string;
  base: string;
  branch: string;
  issues: number[];
  done: string[];
  checkout?: { old: string; target: string; trigger: string };
  install?: boolean;
}
const sha = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f\d]{40}$/i.test(value)) {
    throw new Error("Invalid commit SHA");
  }
  return value;
};
export function conformingTitle(title: string): boolean {
  return /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|BREAKING CHANGE): \S[^\r\n]*$/.test(
    title
  );
}

/** Decode pre-adoption Agent task for / Closes header relations, never branch numbers. */
export function legacyIssueHeaders(body: string): number[] {
  const numbers = [
    ...body.matchAll(/^[\t ]*(?:>[\t ]*)?(?:\*\*)?(?:Closes|Agent task for)\s+#([1-9]\d*)\b/gim),
  ].map((match) => Number(match[1]));
  if (numbers.some((number) => !Number.isSafeInteger(number))) {
    throw new Error("Invalid legacy issue link");
  }
  return numbers;
}
const roundText = (round: number) =>
  String(round).replace(/\d/g, (digit) => `${digit}\uFE0F\u20E3`);

/** Named workflow operations; no raw responses or credentials are returned to clients. */
export class TaskFlow {
  constructor(
    private root: string,
    private env: NodeJS.ProcessEnv,
    private config: Config,
    private deps: Dependencies,
    private host: Host
  ) {}

  private number(ref: string): number {
    if (!/^[1-9]\d*$/.test(ref) || !Number.isSafeInteger(Number(ref))) {
      throw new Error("Expected own-repository PR/issue number");
    }
    return Number(ref);
  }
  private get repo(): string {
    return String(this.config.repo);
  }
  private get mainBase(): string {
    return String(object(loadYaml(this.root, "vmethod")).baseBranch);
  }
  private path(ref: string, kind = "issues"): string {
    return `/repos/${this.repo}/${kind}/${this.number(ref)}`;
  }
  private git(cwd = this.root): GitTransport {
    return new GitTransport(this.config, this.env, this.deps, cwd);
  }
  private async pr(ref: string): Promise<ObjectData> {
    this.number(ref);
    const item = await this.host.thread(ref, "pr");
    const branch = String(item.headRefName);
    taskBranch(branch, this.config);
    validateBranch(String(item.baseRefName));
    if (object(item.headRepository).nameWithOwner !== this.repo) {
      throw new Error("Refusing fork task branch");
    }
    this.track(item);
    return { ...item, number: this.number(ref) };
  }
  private track(item: ObjectData): void {
    const labels = object(item.labels).nodes;
    if (!Array.isArray(labels)) {
      throw new Error("Missing task labels");
    }
    const tracks = labels
      .map((label) => String(object(label).name))
      .filter((name) => name.startsWith("track:"));
    const expected = this.config.track ? [`track:${String(this.config.track)}`] : [];
    if (JSON.stringify(tracks.sort()) !== JSON.stringify(expected)) {
      throw new Error("Task belongs to another track");
    }
  }
  private async post(ref: string, body: string): Promise<void> {
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    await this.host.github.rest(`${this.path(ref)}/comments`, "POST", { body }, false);
  }
  private async card(
    item: ObjectData,
    status: string | undefined,
    progress: string | null,
    model?: string
  ): Promise<void> {
    if (object(this.config.board).enabled === false) {
      return;
    }
    const board = this.host.board();
    const id = await board.ensure(String(item.id));
    if (status) {
      await board.set({ itemId: id, field: "Status", value: status, progress });
    } else {
      await board.set({ itemId: id, field: "Progress", value: progress });
    }
    if (model) {
      await board.set({ itemId: id, field: "Model", value: model });
    }
  }
  private async turn(ref: string, role: "owner" | "orchestrator" | null): Promise<void> {
    const current = object(await this.host.github.rest(this.path(ref)));
    if (!Array.isArray(current.assignees)) {
      throw new Error("Missing assignees");
    }
    const assigned = current.assignees.map((p) => String(object(p).login));
    await setTurn(
      this.host.github,
      this.repo,
      this.number(ref),
      assigned,
      turnAssignees(this.host.people, this.repo, assigned, role)
    );
  }
  private async ready(item: ObjectData, draft: boolean): Promise<void> {
    if (item.isDraft === draft) {
      return;
    }
    const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    await this.host.github.graphql(
      `mutation TaskReady($id: ID!) { ${mutation}(input: {pullRequestId: $id}) { pullRequest { id } } }`,
      { id: item.id }
    );
  }

  /** Open an isolated draft delivery, freezing only an on-scale opening issue Estimate. */
  async open(input: OpenTaskInput): Promise<string> {
    for (const value of [input.hold, input.part, input.ownerApproved]) {
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error("Invalid task flags");
      }
    }
    for (const value of [input.issue, input.direct, input.model, input.unapproved]) {
      if (value !== undefined && (typeof value !== "string" || !value.trim())) {
        throw new Error("Invalid task text argument");
      }
    }
    if (
      (!input.issue && !input.direct) ||
      (input.unapproved !== undefined && !input.unapproved.trim())
    ) {
      throw new Error("Issue/direct title and nonempty exception reason required");
    }
    const issue = input.issue
      ? await this.host.thread(String(this.number(input.issue)), "issue")
      : undefined;
    if (input.part && !issue) {
      throw new Error("--part requires an issue");
    }
    if (issue) {
      this.track(issue);
      if (issue.state !== "OPEN") {
        throw new Error("Issue is not open");
      }
      if (input.unapproved === undefined && (await this.host.issueApproved(issue)) !== true) {
        throw new Error("scope not approved: post SCOPE REVIEW first");
      }
    }
    let hint: string | undefined;
    let pointsOpen: number | undefined;
    if (issue && object(this.config.board).enabled !== false) {
      const board = this.host.board();
      const snapshot = await board.snapshot();
      const card = (await board.cards(snapshot.id)).find((card) => card.contentId === issue.id);
      hint = typeof card?.values.Model === "string" ? card.values.Model : undefined;
      const estimate = card?.values.Estimate;
      if (estimate === undefined || estimate === null) {
        throw new Error("Issue must have an Estimate at opening");
      }
      assertEstimate(estimate);
      pointsOpen = estimate;
    }
    const models = loadYaml(this.root, "models") as {
      family: string;
      model: string;
      gate: string;
      tier: string;
    }[];
    const model = models.find((model) => model.family === (input.model ?? hint ?? "sol"));
    if (!model) {
      throw new Error("Unknown model family");
    }
    if (model.gate === "owner" && input.ownerApproved !== true) {
      throw new Error("Model requires --owner-approved");
    }
    let title = String(input.direct ?? issue?.title ?? "");
    if (!input.direct && issue) {
      title = title.replace(/^bug:\s*/, "fix: ");
    }
    if (!conformingTitle(title)) {
      // Issue titles are prose; generate a conventional feature title, never retain a scope.
      title = `feat: ${title.replace(/^[a-z]+\([^)]*\):\s*/, "").trim()}`;
    }
    if (!conformingTitle(title)) {
      throw new Error("Title must be <type>: <subject> without scope");
    }
    const spec = String(issue?.body ?? input.direct ?? "");
    const handoff = /^## Handoff breakpoints\s*$/m.test(spec);
    if (handoff && model.tier !== "expensive") {
      throw new Error("Handoff breakpoints require tier: expensive");
    }
    const base = String(this.config.baseBranch);
    validateBranch(base);
    const slug =
      title
        .replace(/^[^:]+:\s*/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 70) || "task";
    const number = input.issue ?? createHash("sha256").update(title).digest("hex").slice(0, 8);
    const branch = String(object(this.config.branches).taskPattern ?? "<number>-<slug>")
      .replaceAll("<number>", number)
      .replaceAll("<slug>", slug);
    taskBranch(branch, this.config);
    const templatePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../templates/task-pr.md"
    );
    // Bundled CLI lives in dist/, whereas TypeScript lives in src/gateway/.
    const template = readFileSync(
      existsSync(templatePath)
        ? templatePath
        : resolve(dirname(fileURLToPath(import.meta.url)), "../templates/task-pr.md"),
      "utf8"
    );
    const renderBody = (taskPr: string): string =>
      template
        .replaceAll("<task PR number>", taskPr)
        .replaceAll(
          "<delivery title>",
          `${title}${input.issue ? ` (${input.part ? "part of " : ""}issue #${input.issue})` : ""}`
        )
        .replace(
          "<!-- points_open: <issue estimate> -->",
          pointsOpen === undefined ? "" : `<!-- points_open: ${pointsOpen} -->`
        )
        .replaceAll(
          "<link and agreement, or explicit direct go>",
          issue
            ? `https://github.com/${this.repo}/issues/${input.issue}; ${input.unapproved ? `unapproved exception: ${input.unapproved}` : input.direct ? "direct owner go" : "approved specification"} reproduced below`
            : `Direct owner go: ${input.direct}`
        )
        .replaceAll("<actual values from project config>", `base ${base}; branch ${branch}`)
        .replaceAll(
          "<family and exact id; any required owner authorization>",
          `${model.family}: ${model.model}`
        )
        .replaceAll("<specifics>", "See the task specification below.")
        .replace(
          /<Existing helpers,[\s\S]*?debt from examples\.>/,
          "Read the repository's current helpers and preserve existing interfaces."
        )
        .replaceAll(
          "<Deliverable, owning path/API and observable acceptance case.>",
          "Implement the approved specification below."
        )
        .replaceAll(
          "<Lifecycle/order/units/boundaries and integration consequences, if applicable.>",
          "Preserve the boundaries and acceptance cases in that specification."
        )
        .replace(
          /<For each touched area,[\s\S]*?before launch\. State where any new recurring rule and guard belong\.>/,
          "Follow the local routing entry point and its tooling rules."
        )
        .replace(
          /<Exclusions,[\s\S]*?removing issue\.>/,
          "Anything outside the task specification."
        )
        .replace(
          /<actual configured commands[\s\S]*?needed>\./,
          (Array.isArray(object(this.config.checks).verify)
            ? (object(this.config.checks).verify as string[]).join("; ")
            : "Run the project's configured checks") + "."
        )
        .replace(
          /<Measurable acceptance cases,[\s\S]*?unresolved blockers\.>/,
          "All specification acceptance cases pass, with green CI and no unresolved blockers."
        ) +
      `\n\n${input.hold ? `${holdBanner}\n\n` : ""}## Task specification\n\n${spec}\n` +
      (handoff
        ? "\nAt each defined breakpoint post `[worker] HANDOFF` with what is done, uncommitted files and remaining mechanical steps, then end your turn.\n"
        : "") +
      `\n<!-- vmethod-task ${JSON.stringify({ issues: issue ? [Number(input.issue)] : [], ...(input.part ? { part: true } : {}), ...(input.unapproved ? { scopeException: input.unapproved } : {}) })} -->\n`;
    const checkedBody = async (taskPr: string): Promise<string> => {
      const body = renderBody(taskPr);
      guardClosingKeywords(body);
      await checkMarkdown(this.root, body);
      return body;
    };
    const body = await checkedBody("<task PR number>");
    if (input.unapproved && issue) {
      await this.post(input.issue!, `[orchestrator] Unapproved exception\n\n${input.unapproved}`);
    }
    const git = this.git();
    if (!(await git.transfer("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
      throw new Error("Fetch failed");
    }
    const commit = sha(
      (
        await git.run(
          "commit-tree",
          `refs/remotes/origin/${base}^{tree}`,
          "-p",
          `refs/remotes/origin/${base}`,
          "-m",
          `chore: open task ${number}\n\nPrepare draft task delivery.`
        )
      ).trim()
    );
    if (!(await git.transfer("push", [`${commit}:refs/heads/${branch}`]))) {
      throw new Error("Task branch push failed");
    }
    const created = object(
      await this.host.github.rest(
        `/repos/${this.repo}/pulls`,
        "POST",
        { title, body, base, head: branch, draft: true },
        false
      )
    );
    const ref = String(created.number);
    this.number(ref);
    // GitHub assigns the task PR number on creation, independently of the issue number.
    const finalBody = await checkedBody(ref);
    try {
      await this.host.github.rest(this.path(ref, "pulls"), "PATCH", { body: finalBody }, false);
    } catch (error) {
      throw new Error(
        `Created draft PR #${ref}, but command rendering failed; inspect it before retrying open-task`,
        {
          cause: error,
        }
      );
    }
    const pr = { id: created.node_id };
    if (this.config.track) {
      await this.host.github.rest(`${this.path(ref)}/labels`, "POST", {
        labels: [`track:${String(this.config.track)}`],
      });
    }
    if (issue && !input.part) {
      try {
        await this.closingLinks(
          await this.host.thread(ref, "pr"),
          [this.number(input.issue!)],
          false
        );
      } catch (error) {
        throw new Error(
          `Created draft PR #${ref}, but Development linking failed; retry link-task ${ref}`,
          { cause: error }
        );
      }
    }
    await this.card(pr, "In progress", input.hold ? "⛔" : "🤖🔨", model.family);
    await this.turn(ref, null);
    if (issue) {
      await this.card(issue, "In progress", null);
      await this.turn(input.issue!, null);
    }
    return `Opened draft PR #${ref} (${branch})`;
  }

  /** Backfill Development links; complete promotes, unlink demotes to a partial task. */
  async link(ref: string, complete = false, unlink = false): Promise<string> {
    if (typeof complete !== "boolean" || typeof unlink !== "boolean" || (complete && unlink)) {
      throw new Error("Invalid or conflicting link flags");
    }
    const item = await this.pr(ref);
    if (item.state !== "OPEN") {
      throw new Error("PR is not open");
    }
    let body = String(item.body);
    const relation = taskRelation(body);
    if (!relation) {
      throw new Error("Missing structured task relation");
    }
    if (!relation.issues.length) {
      return `Task #${ref} links already current`;
    }
    if ((complete && relation.part) || (unlink && !relation.part)) {
      relation.part = unlink;
      body = body.replace(
        /^(# Task: [^\r\n]*) \((?:part of )?issue #([1-9]\d*)\)/,
        (_match, title: string, issue: string) =>
          `${title} (${relation.part ? "part of " : ""}issue #${issue})`
      );
      // The template's marker is last; marker examples in the worker prompt are data.
      const marker = [...body.matchAll(/<!-- vmethod-task (\{[^\n]*\}) -->/g)].at(-1);
      if (marker) {
        const value = object(JSON.parse(marker[1]));
        const updated = `<!-- vmethod-task ${JSON.stringify({ ...value, issues: relation.issues, part: relation.part })} -->`;
        body = body.slice(0, marker.index) + updated + body.slice(marker.index + marker[0].length);
      }
    }
    if (body !== item.body) {
      await checkMarkdown(this.root, body);
    }
    const changed =
      unlink || !relation.part ? await this.closingLinks(item, relation.issues, unlink) : false;
    if (!changed && body === item.body) {
      return `Task #${ref} links already current`;
    }
    if (body !== item.body) {
      // Only structured plan flags change, never reference prose or prompt text.
      await this.host.github.rest(this.path(ref, "pulls"), "PATCH", { body }, false);
    }
    return `${unlink ? "Unlinked" : "Linked"} task #${ref}${complete ? " as completing" : ""}`;
  }

  private async closingLinks(
    item: ObjectData,
    issues: number[],
    unlink: boolean
  ): Promise<boolean> {
    if (!issues.length) {
      return false;
    }
    const references = this.linkedIssues(item);
    if (typeof item.id !== "string" || !item.id) {
      throw new Error("Missing task PR node id");
    }
    let changed = false;
    for (const number of issues) {
      const linked = references.has(number);
      if (linked !== unlink) {
        continue;
      }
      const issue = await this.host.thread(String(number), "issue");
      if (typeof issue.id !== "string" || !issue.id) {
        throw new Error("Missing issue node id");
      }
      const mutation = unlink ? "removeCloseIssueReferences" : "addCloseIssueReferences";
      const result = object(
        await this.host.github.graphql(
          `mutation TaskClosingLink($issueId: ID!, $pullRequestIds: [ID!]!) {
          ${mutation}(input: {issueId: $issueId, pullRequestIds: $pullRequestIds}) { clientMutationId }
        }`,
          { issueId: issue.id, pullRequestIds: [item.id] }
        )
      );
      if (!result[mutation] || typeof result[mutation] !== "object") {
        throw new Error("Missing closing reference mutation result");
      }
      changed = true;
    }
    if (unlink && changed) {
      const remaining = this.linkedIssues(await this.pr(String(item.number)));
      if (issues.some((number) => remaining.has(number))) {
        throw new Error(
          "Closing reference remains; --unlink removes manual links only, not automatic body references"
        );
      }
    }
    return changed;
  }

  private linkedIssues(item: ObjectData): Set<number> {
    const references = object(item.closingIssuesReferences);
    if (!Array.isArray(references.nodes) || object(references.pageInfo).hasNextPage !== false) {
      throw new Error("Missing or incomplete closing issue references");
    }
    const numbers = new Set<number>();
    for (const value of references.nodes) {
      const node = object(value);
      if (
        !Number.isSafeInteger(node.number) ||
        Number(node.number) < 1 ||
        typeof object(node.repository).nameWithOwner !== "string"
      ) {
        throw new Error("Invalid closing issue reference");
      }
      if (object(node.repository).nameWithOwner === this.repo) {
        numbers.add(Number(node.number));
      }
    }
    return numbers;
  }

  async review(input: ReviewInput): Promise<string> {
    if (!["changes", "owner", "answer", "ask", "approve"].includes(input.outcome)) {
      throw new Error("Invalid review outcome");
    }
    const item = await this.pr(input.ref);
    if (item.state !== "OPEN") {
      throw new Error("PR is not open");
    }
    const comments = await this.host.comments(String(item.id));
    const round =
      1 +
      Math.max(
        0,
        ...comments.map((c) =>
          Number(/^\[orchestrator\] REVIEW round (\d+)/.exec(String(c.body))?.[1] ?? 0)
        )
      );
    const heading = {
      changes: `REVIEW round ${round}`,
      owner: "OWNER REVIEW",
      answer: "ANSWER",
      ask: "OWNER QUESTION",
      approve: "APPROVED",
    }[input.outcome];
    if (input.replyTo) {
      const url = new URL(input.replyTo);
      if (
        url.origin !== "https://github.com" ||
        url.search ||
        url.username ||
        url.password ||
        ![`/${this.repo}/issues/${input.ref}`, `/${this.repo}/pull/${input.ref}`].includes(
          url.pathname
        ) ||
        !/^#(?:issuecomment-|discussion_r)\d+$/.test(url.hash)
      ) {
        throw new Error("Invalid reply URL");
      }
    }
    const body =
      `[orchestrator] ${heading}\n\n` +
      (input.replyTo ? `in reply to ${input.replyTo}\n\n` : "") +
      (input.outcome === "owner" ? `Current head: ${sha(item.headRefOid)}\n\n` : "") +
      readFileSync(input.file, "utf8");
    await this.post(input.ref, body);
    await this.ready(item, !["owner", "approve"].includes(input.outcome));
    const progress = {
      changes: `🤖🔨 🔁${roundText(round)}`,
      owner: "👤🔍",
      answer: "🤖🔨",
      ask: "👤❓",
      approve: "🧭🔍",
    }[input.outcome];
    await this.card(
      item,
      input.outcome === "owner" || input.outcome === "ask" || input.outcome === "approve"
        ? "In review"
        : input.outcome === "changes" || input.outcome === "answer"
          ? "In progress"
          : undefined,
      progress
    );
    await this.turn(
      input.ref,
      input.outcome === "approve"
        ? "orchestrator"
        : input.outcome === "owner" || input.outcome === "ask"
          ? "owner"
          : null
    );
    for (const number of taskIssueNumbers(String(item.body)) ?? []) {
      const issue = await this.host.thread(String(number), "issue");
      const owner = input.outcome === "owner" || input.outcome === "ask";
      await this.turn(String(number), null);
      await this.card(issue, owner ? "In review" : "In progress", null);
    }
    const wake =
      input.outcome === "changes" || input.outcome === "answer"
        ? await this.wake(input.ref, heading)
        : undefined;
    return `Posted ${heading} on #${input.ref}${wake ? `\n${wake}` : ""}`;
  }

  /** Ask the owner on an issue without a live task PR; task questions belong on that PR. */
  async ask(ref: string, file: string): Promise<string> {
    const issue = await this.host.thread(String(this.number(ref)), "issue");
    this.track(issue);
    if (issue.state !== "OPEN") {
      throw new Error("Issue is not open");
    }
    for (let page = 1; ; page++) {
      const pulls = await this.host.github.rest(
        `/repos/${this.repo}/pulls?state=open&per_page=100&page=${page}`
      );
      if (!Array.isArray(pulls)) {
        throw new Error("Missing open task PRs");
      }
      if (pulls.some((pr) => taskIssueNumbers(String(object(pr).body))?.includes(Number(ref)))) {
        throw new Error("Issue has an open task PR; use review <pr> ask");
      }
      if (pulls.length < 100) {
        break;
      }
    }
    await this.post(ref, `[orchestrator] OWNER QUESTION\n\n${readFileSync(file, "utf8")}`);
    await this.card(issue, undefined, "👤❓");
    await this.turn(ref, "owner");
    return `Posted OWNER QUESTION on #${ref}`;
  }

  async status(ref: string, forMerge = false): Promise<"live" | "stopped" | "unknown"> {
    const status = (await this.deps.workers?.status(this.number(ref), forMerge)) ?? "unknown";
    return ["live", "stopped", "unknown"].includes(status) ? status : "unknown";
  }
  /** Release an open held task, preserving prompt edits and refusing repeated releases. */
  async release(ref: string): Promise<string> {
    const item = await this.pr(ref);
    if (item.state !== "OPEN") {
      throw new Error("PR is not open");
    }
    const body = String(item.body ?? ""),
      title = String(item.title);
    if (!taskHeld(title, body)) {
      throw new Error("Task PR is not on hold");
    }
    const updated = withoutHold(title, body);
    await checkMarkdown(this.root, updated.body);
    // Re-read after validation: never replace a prompt edited while preparing release.
    const current = await this.pr(ref);
    if (current.body !== body || current.title !== title || current.state !== "OPEN") {
      throw new Error("Task PR changed while preparing release; read it and retry");
    }
    await this.host.github.rest(this.path(ref, "pulls"), "PATCH", updated, false);
    const comments = await this.host.comments(String(item.id));
    if (!comments.some((c) => /^\[orchestrator\] GO(?:\s|$)/.test(String(c.body)))) {
      await this.post(ref, "[orchestrator] GO\n\nThe hold is lifted; work may begin.");
    }
    await this.card(item, "In progress", "🤖🔨");
    await this.turn(ref, null);
    const wake = await this.wake(ref, "GO");
    return `Released #${ref}${wake ? `\n${wake}` : ""}`;
  }

  private async wake(ref: string, heading: string): Promise<string | void> {
    return this.deps.workers?.resume(
      this.number(ref),
      `[orchestrator] ${heading} is on your PR; read it with vmethod read pr ${ref} and act.`
    );
  }

  private async green(ref: string, head: string): Promise<void> {
    const accepted: ObjectData[] = [];
    for (let page = 1; ; page++) {
      const data = object(
        await this.host.github.rest(
          `/repos/${this.repo}/commits/${head}/check-runs?per_page=100&page=${page}`
        )
      );
      if (!Array.isArray(data.check_runs)) {
        throw new Error("Missing CI checks");
      }
      for (const value of data.check_runs) {
        const run = object(value);
        if (
          this.host.people.some(
            (p) =>
              p.role === "system" &&
              p.events?.includes("check_run") &&
              p.appIds?.includes(Number(object(run.app).id))
          )
        ) {
          accepted.push(run);
        }
      }
      if (data.check_runs.length < 100) {
        break;
      }
    }
    const latest = new Map<string, ObjectData>();
    for (const run of accepted) {
      const key = `${String(object(run.app).id)}:${String(run.name)}`;
      if (!latest.has(key) || Number(run.id) > Number(latest.get(key)!.id)) {
        latest.set(key, run);
      }
    }
    const runs = [...latest.values()];
    const required = object(this.config.checks).ci;
    if (
      !runs.length ||
      runs.some(
        (run) =>
          run.head_sha !== head ||
          run.status !== "completed" ||
          !["success", "neutral", "skipped"].includes(String(run.conclusion))
      ) ||
      (Array.isArray(required) &&
        required.some(
          (name) => !runs.some((run) => run.name === name && run.conclusion === "success")
        ))
    ) {
      throw new Error(`CI is not green on current head of #${ref}`);
    }
  }

  private async issues(item: ObjectData): Promise<number[]> {
    const relation = taskRelation(String(item.body));
    if (relation) {
      return relation.part ? [] : relation.issues;
    }
    if (/^[\t ]*(?:>[\t ]*)?(?:\*\*)?Part of\s+#([1-9]\d*)\b/im.test(String(item.body))) {
      return [];
    }
    const references = object(item.closingIssuesReferences);
    if (object(references.pageInfo).hasNextPage === true) {
      throw new Error("Too many legacy issue links");
    }
    const linked = Array.isArray(references.nodes)
      ? references.nodes
          .map(object)
          .filter((node) => object(node.repository).nameWithOwner === this.repo)
          .map((node) => Number(node.number))
      : [];
    const legacy = linked.length ? linked : legacyIssueHeaders(String(item.body));
    if (legacy.some((number) => !Number.isSafeInteger(number))) {
      throw new Error("Invalid legacy issue link");
    }
    if (legacy.length) {
      this.deps.report("legacy link: using pre-adoption issue relation");
    } else {
      this.deps.report("no linked issue");
    }
    return [...new Set(legacy)];
  }
  private stateFile(ref: string): string {
    const name = String(this.config.stateName ?? this.repo.replace("/", "-"));
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || [".", ".."].includes(name)) {
      throw new Error("Invalid stateName");
    }
    return join(
      this.env.XDG_STATE_HOME ?? join(this.env.HOME ?? homedir(), ".local/state"),
      "vmethod",
      name,
      `merge-${this.number(ref)}.json`
    );
  }
  private save(file: string, journal: Journal): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(journal), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /** Merge a stopped/session-less task against the live base; carryApproval certifies no behaviour change after base merges. */
  async merge(ref: string, mergeCommit = false, carryApproval?: string): Promise<string> {
    if (typeof mergeCommit !== "boolean") {
      throw new Error("Invalid merge-commit flag");
    }
    if (
      carryApproval !== undefined &&
      (typeof carryApproval !== "string" || !carryApproval.trim() || /[\r\n]/.test(carryApproval))
    ) {
      throw new Error("Approval carry requires a nonempty single-line reason");
    }
    const item = await this.pr(ref);
    if (!["OPEN", "MERGED"].includes(String(item.state))) {
      throw new Error("PR is closed without merging");
    }
    if (item.state === "OPEN" && (await this.status(ref, true)) !== "stopped") {
      throw new Error("Stop the worker before merging (live or unknown session)");
    }
    const head = sha(item.headRefOid),
      base = String(item.baseRefName),
      branch = String(item.headRefName);
    const pack = branch.startsWith(String(object(this.config.branches).packPrefix ?? "pack/"));
    if (pack && !mergeCommit && item.state === "OPEN") {
      throw new Error("Pack branches require --merge-commit");
    }
    if (!conformingTitle(String(item.title))) {
      if (item.state === "OPEN") {
        throw new Error("Squash subject must be <type>: <subject> without scope");
      }
      this.deps.report(
        "warning: already-merged PR has a non-conforming subject; continuing follow-up"
      );
    }
    const git = this.git();
    if (item.state === "OPEN") {
      for (const number of taskIssueNumbers(String(item.body)) ?? []) {
        const issue = await this.host.thread(String(number), "issue");
        const marker = /<!-- vmethod-task (\{[^\r\n]*\}) -->\s*$/.exec(String(item.body));
        const exception = marker ? object(JSON.parse(marker[1])).scopeException : undefined;
        if (
          !(typeof exception === "string" && exception.trim()) &&
          (await this.host.issueApproved(issue)) !== true
        ) {
          throw new Error("scope not approved: post SCOPE REVIEW first");
        }
      }
      const baseSha = sha(item.baseRefOid);
      if (
        !(await git.transfer("fetch", [
          `+refs/heads/${base}:refs/remotes/origin/${base}`,
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ]))
      ) {
        throw new Error("Fetch failed");
      }
      const liveBase = await liveBaseHead(base, { git });
      let certification: string | undefined;
      if (carryApproval !== undefined) {
        for (const approved of await this.host.candidates(ref)) {
          if ((await this.host.approved(ref, approved)) !== true) {
            continue;
          }
          const files = await approvalCarryFiles(
            (...args) => git.run(...args),
            approved,
            head,
            baseSha
          );
          if (files === null) {
            continue;
          }
          certification = `[orchestrator] APPROVAL CARRIED from ${approved} to ${head}: ${carryApproval}\n\nI certify there is no behaviour change or algorithmic revamp.\n\nRemerge-diff files:\n${files.length ? files.map((file) => `- ${JSON.stringify(file)}`).join("\n") : "- (none)"}`;
          break;
        }
        if (!certification) {
          throw new Error(
            "Owner approval cannot be carried: an earlier approval and only base-merge commits are required; re-ask the owner"
          );
        }
      } else if ((await this.host.approved(ref)) !== true) {
        let survived = false;
        for (const approved of await this.host.candidates(ref)) {
          if (
            (await this.host.approved(ref, approved)) === true &&
            (await cleanBaseMerges((...args) => git.run(...args), approved, head, baseSha))
          ) {
            survived = true;
            break;
          }
        }
        if (!survived) {
          throw new Error("Owner approval is not valid for current head");
        }
      }
      await this.green(ref, head);
      if (item.mergeable !== "MERGEABLE") {
        throw new Error("PR is conflicting or mergeability is unknown");
      }
      if (object(this.config.merge).requireCurrentBase !== false) {
        try {
          await git.run("merge-base", "--is-ancestor", liveBase, head);
        } catch {
          throw new Error(`CI tested an older base; run refresh-checks ${ref}`);
        }
      } else {
        await this.verifyMerge(ref, liveBase, head);
      }
      const current = await this.pr(ref);
      // Hook execution can take minutes: re-fetch rather than trusting the PR's
      // potentially stale baseRefOid to detect base movement during verification.
      if (!(await git.transfer("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
        throw new Error("Fetch failed");
      }
      if (
        current.headRefOid !== head ||
        current.baseRefOid !== baseSha ||
        current.baseRefName !== base ||
        (await liveBaseHead(base, { git })) !== liveBase
      ) {
        throw new Error("Head or base moved during merge checks");
      }
      if ((await this.status(ref, true)) !== "stopped") {
        throw new Error("Worker restarted before merge");
      }
      if (item.isDraft) {
        await this.ready(item, false);
      }
      if (certification) {
        await this.post(ref, certification);
      }
      const merged = object(
        await this.host.github.rest(
          this.path(ref, "pulls") + "/merge",
          "PUT",
          {
            sha: head,
            merge_method: mergeCommit ? "merge" : "squash",
            commit_title: `${String(item.title)} (#${ref})`,
          },
          false
        )
      );
      if (merged.merged !== true) {
        throw new Error("Merge was refused; re-run to reconcile state");
      }
    }
    // The merge guard above protects an action, not recovery after a button/API merge.
    // Stop first, then inspect the remote branch before any destructive cleanup.
    try {
      if (!this.deps.workers?.stop) {
        this.deps.report(`#${ref} worker stop unavailable (session unknown); continuing follow-up`);
      } else {
        const outcome = await this.deps.workers.stop(this.number(ref));
        this.deps.report(`#${ref} worker stop: ${outcome ?? "requested"}`);
        this.deps.report(`#${ref} worker status after stop: ${await this.status(ref)}`);
      }
    } catch {
      this.deps.report(`#${ref} worker stop failed; continuing follow-up`);
    }
    const branchHead = async () => {
      const data = await this.host.github.rest(
        `/repos/${this.repo}/git/matching-refs/heads/${encodeURIComponent(branch)}`
      );
      if (!Array.isArray(data)) {
        throw new Error("Missing branch refs");
      }
      const ref = data.map(object).find((value) => value.ref === `refs/heads/${branch}`);
      return ref ? sha(object(ref.object).sha) : undefined;
    };
    const preserveBranch = async () => {
      const current = await branchHead();
      if (!current || current === head) {
        return { exists: Boolean(current), preserve: false };
      }
      const commits: string[] = [];
      for (let page = 1; ; page++) {
        const comparison = object(
          await this.host.github.rest(
            `/repos/${this.repo}/compare/${head}...${current}?per_page=100&page=${page}`
          )
        );
        if (!Array.isArray(comparison.commits)) {
          throw new Error("Missing post-merge commit comparison; branch retained");
        }
        commits.push(...comparison.commits.map((commit) => sha(object(commit).sha)));
        if (comparison.commits.length < 100) {
          break;
        }
      }
      // Even divergent/force-pushed history must never be deleted.
      this.deps.report(
        `post-merge commits on ${branch}: ${[...new Set([...commits, current])].join(" ")}`
      );
      return { exists: true, preserve: true };
    };
    let keepBranch = (await preserveBranch()).preserve;
    const file = this.stateFile(ref);
    const journal: Journal = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Journal)
      : { head, base, branch, issues: await this.issues(item), done: [] };
    if (journal.head !== head || journal.base !== base || journal.branch !== branch) {
      throw new Error("Merge journal does not match PR");
    }
    // Older completed journals may have missed the issue entirely. Reconcile newly
    // discoverable relations without replaying already-checkpointed issue writes.
    if (existsSync(file)) {
      const issues = await this.issues(item);
      if (JSON.stringify(journal.issues) !== JSON.stringify(issues)) {
        journal.issues = issues;
        journal.done = journal.done.filter((name) => name !== "estimates");
      }
    }
    this.save(file, journal);
    const step = async (name: string, action: () => Promise<void | boolean>) => {
      if (!journal.done.includes(name)) {
        if ((await action()) === false) {
          return;
        }
        journal.done.push(name);
        this.save(file, journal);
      }
    };
    if (base === this.mainBase) {
      for (const number of journal.issues) {
        await step(`issue-${number}`, async () => {
          const issue = await this.host.thread(String(number), "issue");
          if (issue.state === "OPEN") {
            await this.host.github.rest(this.path(String(number)), "PATCH", {
              state: "closed",
              state_reason: "completed",
            });
          }
          await this.card(issue, "Done", null);
          await this.turn(String(number), null);
        });
      }
      await step("estimates", async () => {
        const revise = new Set<number>();
        for (const number of journal.issues) {
          for (let page = 1; ; page++) {
            const data = await this.host.github.rest(
              `${this.path(String(number))}/dependencies/blocking?per_page=100&page=${page}`
            );
            if (!Array.isArray(data)) {
              throw new Error("Missing blocking issues");
            }
            for (const value of data) {
              const issue = object(value);
              if (
                issue.state === "open" &&
                issue.repository_url === `https://api.github.com/repos/${this.repo}` &&
                Number.isSafeInteger(issue.number)
              ) {
                revise.add(Number(issue.number));
              }
            }
            if (data.length < 100) {
              break;
            }
          }
        }
        if (revise.size) {
          this.deps.report(
            `revise estimates: ${[...revise]
              .sort((a, b) => a - b)
              .map((n) => `#${n}`)
              .join(" ")}`
          );
        }
      });
    }
    await step("pr-card", async () => {
      await this.card(item, "Done", null);
      await this.turn(ref, null);
    });
    await step("done-cap", async () => {
      if (object(this.config.board).enabled !== false) {
        await this.host.board().capDone();
      }
    });
    if (!pack) {
      await step("branch", async () => {
        // Recheck immediately before delete too: a late push must be preserved.
        const latest = await preserveBranch();
        keepBranch = latest.preserve || keepBranch;
        if (!keepBranch && latest.exists) {
          await this.host.github.rest(
            `/repos/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
            "DELETE"
          );
        }
      });
    }
    if (base === this.mainBase) {
      await step("checkout", async () => {
        const main = resolve(String(object(this.config.branches).mainCheckout ?? this.root));
        const local = this.git(main);
        if (
          (await local.run("rev-parse", "--abbrev-ref", "HEAD")).trim() !== base ||
          (await local.run("status", "--porcelain", "--untracked-files=no")).trim()
        ) {
          throw new Error(
            "Main checkout must be clean and on baseBranch; retry follow-up after fixing it"
          );
        }
        if (!journal.checkout) {
          if (
            !(await local.transfer("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))
          ) {
            throw new Error("Fetch failed");
          }
          journal.checkout = {
            old: sha((await local.run("rev-parse", "HEAD")).trim()),
            target: sha((await local.run("rev-parse", `refs/remotes/origin/${base}`)).trim()),
            trigger: String(object(this.config.postMerge).trigger ?? "package-lock.json"),
          };
          this.save(file, journal);
        }
        await local.run("merge", "--ff-only", journal.checkout.target);
        const changed = await local.run(
          "diff",
          "--name-only",
          journal.checkout.old,
          journal.checkout.target,
          "--",
          journal.checkout.trigger
        );
        journal.install = Boolean(changed.trim());
      });
    }
    if (!pack) {
      await step("worktree", async () =>
        new WorktreeService(this.root, this.config, this.env, this.deps, (pr) =>
          this.status(String(pr))
        ).cleanup({ pr: this.number(ref), branch, base, head, state: "MERGED" })
      );
    }
    // All state/board/reporting is complete before the package may replace itself.
    await step("follow-up", async () => {
      this.deps.report(`#${ref} merged; follow-up complete`);
    });
    const output = `Merged #${ref}`;
    if (journal.install) {
      const install = String(object(this.config.postMerge).install ?? "npm ci");
      const installEnv: NodeJS.ProcessEnv = { HUSKY: "0" };
      for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
        if (this.env[key]) {
          installEnv[key] = this.env[key];
        }
      }
      // Intentionally nothing follows this await: old-version code never loads new code.
      await this.deps.exec("sh", ["-c", install], {
        cwd: resolve(String(object(this.config.branches).mainCheckout ?? this.root)),
        env: installEnv,
      });
    }
    return output;
  }

  private async verifyMerge(ref: string, base: string, head: string): Promise<void> {
    const parent = join(this.root, ".tmp");
    mkdirSync(parent, { recursive: true });
    const temporary = mkdtempSync(join(parent, "merge-verify-"));
    const worktree = join(temporary, "worktree");
    const git = this.git();
    let added = false;
    try {
      await git.run("worktree", "add", "--detach", worktree, base);
      added = true;
      try {
        await this.git(worktree).run(
          "-c",
          "user.name=orchestrator",
          "-c",
          "user.email=orchestrator@localhost",
          "merge",
          "-q",
          "--no-edit",
          head
        );
      } catch {
        throw new Error(`PR #${ref} does not merge cleanly onto the live base`);
      }
      if (!existsSync(join(worktree, "scripts/vmethod-hooks/verify"))) {
        throw new Error(
          `requireCurrentBase is false but no verify hook is configured; run refresh-checks ${ref}`
        );
      }
      const result = await runVerifyHook(worktree, this.config, this.env, this.deps, [
        "--scope",
        "merge",
      ]);
      if (result.code) {
        throw new Error(
          `Merge verification failed: scripts/vmethod-hooks/verify\n${result.text}\nlogs: ${result.logs}`
        );
      }
      this.deps.report(`Merge verification passed\n${result.text}\nlogs: ${result.logs}`);
    } finally {
      if (added) {
        await git.run("worktree", "remove", "--force", worktree);
      }
      rmdirSync(temporary);
    }
  }
}
