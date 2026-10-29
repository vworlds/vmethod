import { heading as protocolHeading, parseFirstLine, wakeText } from "../core/protocol.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { assertEstimate } from "../board/estimate.js";
import { renderProgress } from "../board/progress.js";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadYaml, type Config } from "../config.js";
import { type Dependencies, type GitHubClient } from "./client.js";
import { type BoardService } from "./board.js";
import { object, type ObjectData, type Person } from "./people.js";
import { checkMarkdown, guardClosingKeywords, guardProtocolHeader } from "./markdown.js";
import { GitTransport, taskBranch, validateBranch } from "./git.js";
import { cleanBaseMerges } from "./clean-base.js";
import { liveBaseHead } from "./base-head.js";
import { approvalCarryFiles } from "./carry-approval.js";
import type { ConflictPrior, OpenTaskInput, ReviewInput } from "./task-flow-types.js";
import { taskIssueNumbers, taskRelation } from "./task-flow-types.js";
import { modelGateError } from "./model-gate.js";
import { ownerForTurn, setTurn, turnAssignees } from "./turn.js";
import { holdBanner, taskHeld, withoutHold } from "./task-hold.js";
import { runVerifyHook } from "./verify-hook.js";
import { assertLockfileInSync, npmCiEnvironment } from "./lockfile.js";
import packageInfo from "../../package.json" with { type: "json" };
import { WorktreeService } from "./worktrees.js";
import type { AutopilotState } from "./autopilot.js";

interface Host {
  thread(ref: string, kind: "pr" | "issue"): Promise<ObjectData>;
  comments(id: string, kind?: "pr" | "issue"): Promise<ObjectData[]>;
  /**
   * The comment with this REST id: the verified pinned author (an editor replaces the
   * author) with the repository-adjusted role, its issue number and the body's first
   * line. Target data for a write verb; undefined when the id is unknown or unpinned.
   */
  replyTarget(
    id: string
  ): Promise<{ author: Person; issue: number; firstLine: string } | undefined>;
  approved(ref: string, historical?: string): Promise<boolean | "unknown">;
  candidates(ref: string): Promise<string[]>;
  issueApproved(item: ObjectData): Promise<boolean | "unknown">;
  approvalRefusal(ref: string): Promise<string>;
  scopeRefusal(item: ObjectData): Promise<string>;
  /** Verify an owner quotation after the latest summons, behind the identity filter. */
  ownerAgreement?(
    ref: string,
    url: string,
    since: number,
    handback: string,
    kind?: "pr" | "issue"
  ): Promise<boolean>;
  /** #218: did the pinned owner verify this gated family on the task issue? */
  modelApproval(issue: number, family: string): Promise<boolean>;
  modelHeadroom?(family: string): Promise<string>;
  modelQuotaWarning?(family: string): Promise<string | undefined>;
  /** #339: open-task's advisory suggestion for an issue, from suggest-model's code path. */
  modelSuggestion?(issue: number): Promise<{ family: string; tier: string; reason: string }>;
  /** #339: a family's graded learnings evidence for the advisory lines; undefined without data. */
  learningEvidence?(
    family: string
  ): { usdPerPoint: number; deliveries: number; totalDeliveries: number } | undefined;
  /** True while an active conflict record still blocks a handover: the
   * implementation closes a recoverable blocked record at once first (#373),
   * then reports whether a dispatched resolution keeps owning the turn. */
  conflictPending?(ref: string): Promise<boolean>;
  /** Fresh owner-delegation evidence; never used by the expensive-model gate. */
  autopilot?(ref: string, kind: "pr" | "issue"): Promise<AutopilotState>;
  copyAutopilot?(issue: ObjectData, pr: ObjectData): Promise<void>;
  /** Verify an exact-head delegated review (including historical heads) and current delegation. */
  autopilotApproved?(ref: string, head: string): Promise<boolean>;
  github: GitHubClient;
  board: () => Pick<BoardService, "ensure" | "item" | "set" | "capDone" | "snapshot" | "cards">;
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

/** #339: model tier ordering for the cheaper-tier note; unknown tiers never count as more expensive. */
const tierRank: Record<string, number> = { cheap: 0, standard: 1, expensive: 2 };

/** #339: "<family> averages $<usd>/point over <k> ..." — the advisory evidence, undefined without data. */
const averages = (
  family: string,
  evidence: { usdPerPoint: number; deliveries: number; totalDeliveries: number } | undefined,
  unit: string
): string | undefined =>
  evidence
    ? `${family} averages $${evidence.usdPerPoint.toFixed(2)}/point over ${evidence.deliveries} of ${evidence.totalDeliveries} ${unit}`
    : undefined;

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
  private async boardCard(item: ObjectData) {
    if (object(this.config.board).enabled === false) {
      return undefined;
    }
    const board = this.host.board();
    const snapshot = await board.snapshot();
    return (await board.cards(snapshot.id)).find((card) => card.contentId === item.id);
  }
  private async assigned(ref: string): Promise<string[]> {
    const current = object(await this.host.github.rest(this.path(ref)));
    if (!Array.isArray(current.assignees)) {
      throw new Error("Missing assignees");
    }
    return current.assignees.map((person) => String(object(person).login));
  }
  private async turn(ref: string, role: "owner" | "orchestrator" | "worker" | null): Promise<void> {
    const assigned = await this.assigned(ref);
    await setTurn(
      this.host.github,
      this.repo,
      this.number(ref),
      assigned,
      turnAssignees(
        this.host.people,
        this.repo,
        assigned,
        role,
        role === "owner"
          ? await ownerForTurn(this.host.github, this.host.people, this.repo, this.number(ref))
          : undefined
      )
    );
  }
  /** Capture the card turn a conflict dispatch will interrupt; store it in the resolution record. */
  async cardPrior(ref: string): Promise<ConflictPrior> {
    const item = await this.pr(ref);
    const assignees = await this.assigned(ref);
    if (object(this.config.board).enabled === false) {
      return { status: null, progress: null, assignees };
    }
    const board = this.host.board();
    const card = await board.item(await board.ensure(String(item.id)));
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.trim() ? value : null;
    return {
      status: text(card.values.Status),
      progress: text(card.values.Progress),
      assignees,
    };
  }
  /** Show the dispatched fixer: 💥 Progress and the assigned worker holding the turn. */
  async cardConflict(ref: string): Promise<void> {
    const item = await this.pr(ref);
    await this.card(
      item,
      undefined,
      renderProgress({ state: "conflict", round: null, red: false })
    );
    await this.turn(ref, "worker");
  }
  /** Return the card to its stored pre-dispatch state once the resolution resolves.
   * Re-reads the live card first: an owner approval found between dispatch and
   * resolution is never overwritten (the #244 case). On an Approved card the restore
   * keeps the Status, restores verifying Progress, clears the interrupted fixer turn
   * and reports the kept approval; otherwise it returns the stored prior turn. */
  async cardRestore(ref: string, prior: ConflictPrior): Promise<void | "approval-kept"> {
    const item = await this.pr(ref);
    if (object(this.config.board).enabled !== false) {
      const card = await this.boardCard(item);
      if (card?.values.Status === "Approved") {
        await this.card(
          item,
          undefined,
          renderProgress({ state: "verifying", round: null, red: false })
        );
        await this.turn(ref, null);
        return "approval-kept";
      }
      if (prior.status) {
        await this.card(item, prior.status, prior.progress ?? null);
      } else {
        await this.card(item, undefined, prior.progress ?? null);
      }
    }
    const assigned = await this.assigned(ref);
    await setTurn(this.host.github, this.repo, this.number(ref), assigned, prior.assignees);
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

  /** Open an already-pushed non-task PR; never creates task relations or a worker. */
  async openPr(input: {
    branch: string;
    title: string;
    file: string;
    draft?: boolean;
  }): Promise<string> {
    this.nonTaskBranch(input.branch);
    if (!conformingTitle(input.title)) {
      throw new Error("Squash subject must be <type>: <subject> without scope");
    }
    if (input.draft !== undefined && typeof input.draft !== "boolean") {
      throw new Error("Invalid draft flag");
    }
    const body = readFileSync(input.file, "utf8");
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    if (taskIssueNumbers(body) !== undefined) {
      throw new Error("Task PRs use open-task");
    }
    const refs = await this.host.github.rest(
      `/repos/${this.repo}/git/matching-refs/heads/${encodeURIComponent(input.branch)}`
    );
    if (
      !Array.isArray(refs) ||
      !refs.some((ref) => object(ref).ref === `refs/heads/${input.branch}`)
    ) {
      throw new Error("Branch must already be pushed to the configured repository");
    }
    const created = object(
      await this.host.github.rest(
        `/repos/${this.repo}/pulls`,
        "POST",
        {
          head: input.branch,
          base: String(this.config.baseBranch),
          title: input.title,
          body,
          draft: input.draft ?? false,
        },
        false
      )
    );
    return `https://github.com/${this.repo}/pull/${this.number(String(created.number))}`;
  }

  private nonTaskBranch(branch: string): void {
    taskBranch(branch, this.config);
    const branches = object(this.config.branches);
    const pattern = String(branches.taskPattern ?? "<number>-<slug>")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      // Issue-less open-task deliveries use an eight-character title hash.
      .replaceAll("<number>", "(?:\\d+|[a-f\\d]{8})")
      .replaceAll("<slug>", "[A-Za-z0-9._-]+");
    if (
      new RegExp(`^${pattern}$`).test(branch) ||
      branch.startsWith(String(branches.packPrefix ?? "pack/"))
    ) {
      throw new Error("Task branches use open-task and merge-task");
    }
  }

  /** Open an isolated draft delivery, freezing only an on-scale opening issue Estimate. */
  async open(input: OpenTaskInput): Promise<string> {
    for (const value of [input.hold, input.part, input.ownerApproved]) {
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error("Invalid task flags");
      }
    }
    for (const value of [
      input.issue,
      input.direct,
      input.model,
      input.unapproved,
      input.modelOverride,
      input.from,
    ]) {
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
    if (input.modelOverride !== undefined && (!input.model || /[\r\n]/.test(input.modelOverride))) {
      throw new Error("--model-override requires --model and a single-line reason");
    }
    if (input.from !== undefined) {
      try {
        validateBranch(input.from);
      } catch (error) {
        throw new Error("open-task --from: invalid branch name", { cause: error });
      }
      if (
        [
          "dev",
          "master",
          "main",
          "HEAD",
          String(this.config.baseBranch),
          String(this.config.releaseBranch),
        ].includes(input.from)
      ) {
        throw new Error("open-task --from refuses the base, release or default branch");
      }
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
        throw new Error(await this.host.scopeRefusal(issue));
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
      if (input.unapproved === undefined && card?.values.Status !== "Executing") {
        throw new Error("open-task requires an Executing issue with approved scope");
      }
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
    if (model.gate === "owner") {
      if (input.ownerApproved !== true) {
        throw new Error("Model requires --owner-approved");
      }
      // The flag alone is not owner authority (#218): the owner must have posted the
      // approval line after the issue body's last edit; a direct task has no issue to
      // verify here, and its launch still re-checks the task PR through worker hooks.
      if (input.issue && !(await this.host.modelApproval(this.number(input.issue), model.family))) {
        throw modelGateError(model.family);
      }
    }
    // The card's Model is the owner's hint; launching on a different family needs a reason.
    const overriding = Boolean(input.model && hint && input.model !== hint);
    if (overriding && !input.modelOverride) {
      throw new Error(
        `issue #${input.issue} has Model ${hint} on its card; use it (omit --model) or override with --model-override "<reason>"`
      );
    }
    // #339: launching without a card Model first shows suggest-model's advice, inform only.
    const advisory =
      issue && !hint
        ? await this.modelAdvisory(this.number(input.issue!), {
            family: model.family,
            tier: model.tier,
          })
        : [];
    const quotaWarning = await this.host.modelQuotaWarning?.(model.family);
    if (quotaWarning) {
      advisory.push(quotaWarning);
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
    const values: Record<string, string> = {
      "delivery title": `${title}${input.issue ? ` (${input.part ? "part of " : ""}issue #${input.issue})` : ""}`,
      "issue estimate": String(pointsOpen ?? ""),
      "approval basis": issue
        ? `https://github.com/${this.repo}/issues/${input.issue}; ${input.unapproved ? `unapproved exception: ${input.unapproved}` : "approved specification"}.`
        : `Direct owner go: ${input.direct}`,
      version: packageInfo.version,
      "hold banner": input.hold ? `${holdBanner}\n\n` : "",
      "task specification": spec,
      "started from": input.from ? `Started from ${input.from}.\n` : "",
      "task metadata": JSON.stringify({
        issues: issue ? [Number(input.issue)] : [],
        ...(input.part ? { part: true } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.unapproved ? { scopeException: input.unapproved } : {}),
        ...(overriding
          ? { modelOverride: { from: hint, to: input.model, reason: input.modelOverride } }
          : {}),
      }),
    };
    // Substitute once: issue text containing template tokens must remain verbatim.
    const body = template
      .replace("<!-- points_open: <issue estimate> -->", () =>
        pointsOpen === undefined ? "" : `<!-- points_open: ${pointsOpen} -->`
      )
      .replace(/<([^<>]+)>/g, (token, key: string) => values[key] ?? token);
    guardClosingKeywords(body);
    await checkMarkdown(this.root, body);
    if (input.unapproved && issue) {
      await this.post(
        input.issue!,
        `${protocolHeading("Unapproved exception")}\n\n${input.unapproved}`
      );
    }
    if (overriding) {
      await this.post(
        input.issue!,
        `${protocolHeading("NOTE")}: model override: using ${input.model} instead of the card's ${hint} — ${input.modelOverride}`
      );
    }
    const git = this.git();
    if (!(await git.transferOk("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
      throw new Error("Fetch failed");
    }
    let head = sha(
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
    if (input.from) {
      head = await this.mergeFromBranch(git, head, input.from, branch, base);
    }
    if (!(await git.transferOk("push", [`${head}:refs/heads/${branch}`]))) {
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
    await this.card(pr, "Executing", input.hold ? "⛔" : "🤖🔨", model.family);
    await this.turn(ref, null);
    if (issue) {
      await this.card(issue, "Executing", null);
      await this.turn(input.issue!, null);
      await this.host.copyAutopilot?.(issue, { id: created.node_id, number: created.number, body });
    }
    return [...advisory, `Opened draft PR #${ref} (${branch})`].join("\n");
  }

  /** #339: the advisory lines open-task prints when launching without a card Model: one
   * suggest-model line, plus a cheaper-tier note when the chosen family costs more. Advisory
   * failures only shorten the output and are reported; the launch is never refused. */
  private async modelAdvisory(
    issue: number,
    chosen: { family: string; tier: string }
  ): Promise<string[]> {
    let suggestion: { family: string; tier: string; reason: string } | undefined;
    try {
      suggestion = await this.host.modelSuggestion?.(issue);
    } catch (error) {
      this.deps.report(`Model suggestion unavailable: ${(error as Error).message}`);
    }
    if (!suggestion) {
      return [];
    }
    const suggested = averages(
      suggestion.family,
      await this.familyEvidence(suggestion.family),
      "graded tasks"
    );
    const lines = [
      `suggest-model #${issue}: ${suggestion.family} (${suggestion.reason}${suggested ? `; ${suggested}` : ""})${this.host.modelHeadroom ? `; ${await this.host.modelHeadroom(suggestion.family)}` : ""}`,
    ];
    const chosenRank = tierRank[chosen.tier];
    const suggestedRank = tierRank[suggestion.tier];
    if (chosenRank !== undefined && suggestedRank !== undefined && chosenRank > suggestedRank) {
      const chosenAverages = averages(
        chosen.family,
        await this.familyEvidence(chosen.family),
        "tasks"
      );
      lines.push(
        `note: ${chosen.family} is a more expensive tier than the suggestion${chosenAverages ? ` (${chosenAverages})` : ""}`
      );
    }
    return lines;
  }

  /** #339: per-family learnings evidence for the advisory lines; failure only shortens a line. */
  private async familyEvidence(
    family: string
  ): Promise<{ usdPerPoint: number; deliveries: number; totalDeliveries: number } | undefined> {
    try {
      return this.host.learningEvidence?.(family);
    } catch (error) {
      this.deps.report(`Learnings evidence unavailable: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Start from existing work: merge origin/<from> into the fresh task branch with a true merge
   * commit (never squash/rebase), so the original authors' commits survive in the delivery. */
  private async mergeFromBranch(
    git: GitTransport,
    head: string,
    from: string,
    branch: string,
    base: string
  ): Promise<string> {
    if (!(await git.transferOk("fetch", [`+refs/heads/${from}:refs/remotes/origin/${from}`]))) {
      throw new Error(`open-task --from: no branch ${from} in ${this.repo}`);
    }
    const fromHead = sha((await git.run("rev-parse", `refs/remotes/origin/${from}`)).trim());
    const preview = await git.mergePreview(head, fromHead);
    if (preview.conflicts.length) {
      throw new Error(
        `open-task --from: merging origin/${from} into ${branch} conflicts; ` +
          `conflicting files: ${preview.conflicts.join(", ")}. Nothing was pushed; ` +
          `resolve the conflicts first, for example by merging ${base} into ${from}.`
      );
    }
    this.deps.report("--from: checking merged-tree lockfile sync");
    await this.checkMergedTreeLockfile(git, preview.tree);
    return sha(
      (
        await git.run(
          "commit-tree",
          preview.tree,
          "-p",
          head,
          "-p",
          fromHead,
          "-m",
          `Merge branch '${from}' into ${branch}`
        )
      ).trim()
    );
  }

  /** Lockfile check on the merged task branch content, before the task branch or any worker exists. */
  private async checkMergedTreeLockfile(git: GitTransport, tree: string): Promise<void> {
    const entries = (await git.run("ls-tree", tree, "--", "package.json", "package-lock.json"))
      .trim()
      .split("\n")
      .filter(Boolean);
    const blobs = new Map(
      entries.flatMap((entry) => {
        const [metadata, path] = entry.split("\t");
        const match = /^(?:100644|100755) blob ([a-f\d]{40})$/.exec(metadata);
        if (!match) {
          // A directory named like a manifest is not extractable here; the worker
          // install path still fails visibly on it.
          return [];
        }
        if (!["package.json", "package-lock.json"].includes(path)) {
          throw new Error("Invalid merged-tree lockfile listing");
        }
        return [[path, match[1]] as const];
      })
    );
    const lockfile = blobs.get("package-lock.json");
    if (!blobs.has("package.json") || !lockfile) {
      // No manifest pair on the branch; the worker's own install path still fails visibly there.
      return;
    }
    const scratch = mkdtempSync(join(tmpdir(), "vmethod-lockfile-"));
    try {
      writeFileSync(
        join(scratch, "package.json"),
        await git.run("cat-file", "blob", blobs.get("package.json")!)
      );
      writeFileSync(
        join(scratch, "package-lock.json"),
        await git.run("cat-file", "blob", lockfile)
      );
      await assertLockfileInSync(this.deps, scratch, npmCiEnvironment(this.env));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
    if (input.outcome === "owner" || input.outcome === "approve") {
      // Before any write: a handover or approval must neither stop a dispatched
      // conflict fixer nor write over an active conflict resolution's card turn.
      // The hook first closes a recoverable blocked record at once instead of
      // waiting for the next watcher poll (#373); an active record still refuses.
      if (item.mergeable === "CONFLICTING") {
        throw new Error(
          `#${this.number(input.ref)} conflicts with ${String(item.baseRefName)}; resolve before handing over`
        );
      }
      if ((await this.host.conflictPending?.(input.ref)) === true) {
        throw new Error(
          `#${this.number(input.ref)} has an active conflict record; resolve before handing over`
        );
      }
    }
    const comments = await this.host.comments(String(item.id));
    const round =
      1 +
      Math.max(
        0,
        ...comments.map(
          (c) =>
            parseFirstLine(String(c.body), {
              role: "orchestrator",
              tags: ["REVIEW"],
              round: "single-space",
            })?.round ?? 0
        )
      );
    const heading = (
      {
        changes: `REVIEW round ${round}`,
        owner: "OWNER REVIEW",
        answer: "ANSWER",
        ask: "OWNER QUESTION",
        approve: "APPROVED",
      } as const
    )[input.outcome];
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
      // An answer hands the turn back to the worker; replying to the owner instead
      // would wake a session while the discussion is still settling the course.
      if (input.outcome === "answer") {
        const id = /#issuecomment-(\d+)$/.exec(url.hash)?.[1];
        const target = id ? await this.host.replyTarget(id) : undefined;
        if (
          !target ||
          target.issue !== this.number(input.ref) ||
          target.author.role !== "worker" ||
          !parseFirstLine(target.firstLine, {
            role: "worker",
            tags: ["QUESTION", "BLOCKED", "DESIGN", "HANDOFF"],
          })
        ) {
          throw new Error(
            "answer replies to a worker QUESTION, BLOCKED, DESIGN or HANDOFF; to reply to the owner use review <pr> ask --in-reply-to <url>"
          );
        }
      }
    }
    const board = object(this.config.board).enabled === false ? undefined : this.host.board();
    const cards = board ? await board.cards((await board.snapshot()).id) : [];
    const card = cards.find((card) => card.contentId === item.id);
    const issues = taskIssueNumbers(String(item.body)) ?? [];
    const summons = cards.filter(
      (candidate) =>
        (candidate.contentId === item.id ||
          (candidate.kind === "Issue" && issues.includes(Number(candidate.number)))) &&
        candidate.values.Status === "Executing" &&
        /^👤(?:❓|🔍)/u.test(String(candidate.values.Progress ?? ""))
    );
    const paused = summons.length > 0;
    if (summons.length > 1) {
      throw new Error(
        "Multiple Executing summons remain paused; release the extra owner turns before handing back"
      );
    }
    const summonsRef = summons[0]?.kind === "Issue" ? String(summons[0].number) : input.ref;
    const summonsKind = summons[0]?.kind === "Issue" ? "issue" : "pr";
    if (input.ownerAgreed !== undefined && input.outcome !== "answer") {
      throw new Error("--owner-agreed is supported only by review answer");
    }
    const handback = readFileSync(input.file, "utf8");
    // Before any write: the posted comment already opens with `[orchestrator] ${heading}`.
    guardProtocolHeader(handback, "review");
    if (paused && input.outcome !== "ask") {
      const summonsComments =
        summonsKind === "issue"
          ? await this.host.comments(String(summons[0].contentId), "issue")
          : comments;
      const since = Math.max(
        ...summonsComments
          .filter((comment) =>
            parseFirstLine(String(comment.body), {
              role: "orchestrator",
              tags: ["OWNER QUESTION", "OWNER REVIEW"],
              boundary: "whitespace",
            })
          )
          .map((comment) => Date.parse(String(comment.lastEditedAt ?? comment.createdAt)))
      );
      if (
        input.outcome !== "answer" ||
        !input.ownerAgreed ||
        !Number.isFinite(since) ||
        !(await this.host.ownerAgreement?.(
          summonsRef,
          input.ownerAgreed,
          since,
          handback,
          summonsKind
        ))
      ) {
        throw new Error(
          "Executing summons is paused; answer requires --owner-agreed and an exact owner quotation after the summons, or owner self-unassignment"
        );
      }
    } else if (input.ownerAgreed) {
      throw new Error("--owner-agreed requires a paused Executing summons");
    }
    if (paused && input.outcome === "ask" && summonsKind === "issue") {
      throw new Error(
        "Continue the existing issue-card summons instead of opening a second owner turn"
      );
    }
    const autopilot =
      input.outcome === "owner" && (await this.host.autopilot?.(input.ref, "pr"))?.active === true;
    const body =
      `${protocolHeading(heading)}\n\n` +
      (input.replyTo ? `in reply to ${input.replyTo}\n\n` : "") +
      (input.outcome === "owner" ? `Current head: ${sha(item.headRefOid)}\n\n` : "") +
      handback +
      (autopilot ? "\n\nExecuting → Owner review under autopilot." : "");
    // One operation for the PR card and every linked issue's writes (#199): the
    // watcher's violation checks stay quiet while the writes land.
    this.host.github.writes.beginOperation("review", [
      { repo: this.repo, number: this.number(input.ref) },
      ...(taskIssueNumbers(String(item.body)) ?? []).map((number) => ({
        repo: this.repo,
        number,
      })),
    ]);
    await this.post(input.ref, body);
    await this.ready(item, !["owner", "approve"].includes(input.outcome));
    const progress = {
      changes: `🤖🔨 🔁${roundText(round)}`,
      owner: "👤🔍",
      answer: "🤖🔨",
      ask: "👤❓",
      approve: "🧭🔍",
    }[input.outcome];
    await this.turn(
      input.ref,
      input.outcome === "approve"
        ? "orchestrator"
        : input.outcome === "owner" || input.outcome === "ask"
          ? "owner"
          : null
    );
    await this.card(
      item,
      input.outcome === "owner"
        ? "Owner review"
        : input.outcome === "approve" && card?.values.Status === "Approved"
          ? "Approved"
          : "Executing",
      progress
    );
    for (const number of taskIssueNumbers(String(item.body)) ?? []) {
      const issue = await this.host.thread(String(number), "issue");
      await this.turn(String(number), null);
      await this.card(issue, "Executing", null);
    }
    // The owner now holds the turn; nothing queued for the stopped worker may wake it.
    if (input.outcome === "owner" || input.outcome === "ask") {
      await this.deps.workers?.clearWake?.(this.number(input.ref));
      if ((await this.status(input.ref)) === "live") {
        await this.deps.workers?.stop?.(this.number(input.ref));
      }
    }
    if (autopilot && (await this.host.autopilot?.(input.ref, "pr"))?.active) {
      await this.post(
        input.ref,
        `${protocolHeading("AUTOPILOT APPROVED")}\n\nCurrent head: ${sha(item.headRefOid)}\n\nOwner review → Approved under autopilot, on my delivery review.`
      );
      await this.card(item, "Approved", "🧭🔍");
      await this.turn(input.ref, "orchestrator");
    }
    const wake =
      input.outcome === "changes" || input.outcome === "answer"
        ? await this.wake(input.ref, heading)
        : undefined;
    return `Posted ${heading} on #${input.ref}${wake ? `\n${wake}` : ""}`;
  }

  /** Ask on the issue; an Executing issue summons also pauses its linked workers. */
  async ask(ref: string, file: string): Promise<string> {
    const issue = await this.host.thread(String(this.number(ref)), "issue");
    this.track(issue);
    if (issue.state !== "OPEN") {
      throw new Error("Issue is not open");
    }
    const card = await this.boardCard(issue);
    const linked: number[] = [];
    for (let page = 1; ; page++) {
      const pulls = await this.host.github.rest(
        `/repos/${this.repo}/pulls?state=open&per_page=100&page=${page}`
      );
      if (!Array.isArray(pulls)) {
        throw new Error("Missing open task PRs");
      }
      const tasks = pulls
        .map(object)
        .filter((pr) => taskIssueNumbers(String(pr.body))?.includes(Number(ref)));
      if (tasks.length && card?.values.Status !== "Executing") {
        throw new Error("Issue has an open task PR; use review <pr> ask");
      }
      linked.push(...tasks.map((pr) => this.number(String(pr.number))));
      if (pulls.length < 100) {
        break;
      }
    }
    // Before pausing workers or writing: the posted comment already opens with
    // `[orchestrator] OWNER QUESTION`.
    const question = readFileSync(file, "utf8");
    guardProtocolHeader(question, "ask");
    for (const pr of linked) {
      await this.deps.workers?.clearWake?.(pr);
      if ((await this.status(String(pr))) === "live") {
        await this.deps.workers?.stop?.(pr);
      }
    }
    this.host.github.writes.beginOperation("ask", [{ repo: this.repo, number: this.number(ref) }]);
    await this.post(ref, `${protocolHeading("OWNER QUESTION")}\n\n${question}`);
    await this.turn(ref, "owner");
    await this.card(
      issue,
      typeof card?.values.Status === "string" ? card.values.Status : "Scoping",
      "👤❓"
    );
    return `Posted OWNER QUESTION on #${ref}`;
  }

  async status(ref: string, forMerge = false): Promise<"live" | "stopped" | "unknown"> {
    const status = (await this.deps.workers?.status(this.number(ref), forMerge)) ?? "unknown";
    return ["live", "stopped", "unknown"].includes(status) ? status : "unknown";
  }
  /** #275: true only when the backend positively reports no worker session record. A failed
   * probe keeps the recorded, cautious path: an unfalsifiable worker is never treated as absent. */
  private async workerAbsent(ref: string): Promise<boolean> {
    try {
      return (await this.deps.workers?.recorded?.(this.number(ref))) === false;
    } catch {
      return false;
    }
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
    // One operation for the turn and board writes, recorded before the GO post (#199):
    // the comment may already exist from an earlier release attempt while these writes land.
    this.host.github.writes.beginOperation("release-hold", [
      { repo: this.repo, number: this.number(ref) },
    ]);
    if (
      !comments.some((c) =>
        parseFirstLine(String(c.body), {
          role: "orchestrator",
          tags: ["GO"],
          boundary: "whitespace",
        })
      )
    ) {
      await this.post(ref, `${protocolHeading("GO")}\n\nThe hold is lifted; work may begin.`);
    }
    await this.turn(ref, null);
    await this.card(item, "Executing", "🤖🔨");
    const wake = await this.wake(ref, "GO");
    return `Released #${ref}${wake ? `\n${wake}` : ""}`;
  }

  private async wake(ref: string, heading: string): Promise<string | void> {
    return this.deps.workers?.resume(this.number(ref), wakeText(heading, ref));
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

  /** Apply task identity, fork, track and hold gates before any conflict side effect. */
  async conflictTask(ref: string): Promise<void> {
    const item = await this.pr(ref);
    if (
      item.state !== "OPEN" ||
      taskIssueNumbers(String(item.body)) === undefined ||
      taskHeld(String(item.title), String(item.body))
    ) {
      throw new Error("Conflict resolution requires an open, non-held task PR on this track");
    }
  }

  /**
   * Tolerant PR lifecycle read for conflict reconciliation: a merged or closed PR
   * must close its resolution record instead of failing every future reconcile.
   */
  async pullLifecycle(ref: string): Promise<"open" | "merged" | "closed"> {
    const item = await this.pr(ref);
    return item.state === "MERGED" ? "merged" : item.state === "CLOSED" ? "closed" : "open";
  }

  /** Escalate independent conflict-proof failures without impersonating the fixer. */
  async escalateConflict(ref: string, reason: string, files: string[]): Promise<void> {
    const item = await this.pr(ref);
    if (item.state !== "OPEN") {
      throw new Error("Conflict task is no longer open");
    }
    // Re-read the live card before writing: an owner approval found between dispatch
    // and escalation is kept, and the note reports it instead of overwriting Approved.
    const approved =
      object(this.config.board).enabled !== false &&
      (await this.boardCard(item))?.values.Status === "Approved";
    // A Status write would move an Approved card out of the owner's decision; on an
    // approved card only the blocked Progress rides the escalation write.
    await this.card(
      item,
      approved ? undefined : "Executing",
      renderProgress({ state: "blocked", round: null, red: false })
    );
    await this.turn(ref, "orchestrator");
    // Report only after the card/turn writes succeed, using the live resulting card.
    const kept =
      object(this.config.board).enabled !== false &&
      (await this.boardCard(item))?.values.Status === "Approved";
    await this.post(
      ref,
      `${protocolHeading("NOTE")}: conflict escalated (${reason})\n\nConflicting files:\n${files.map((file) => `- ${JSON.stringify(file)}`).join("\n") || "- (none)"}\n\n${kept ? "Owner approval kept: the card stays Approved." : "Owner review is required; no approval carried."}`
    );
  }

  /** Merge a stopped/session-less task against the live base; delegated carries also require cleanBaseMerges proof. */
  async merge(
    ref: string,
    mergeCommit = false,
    carryApproval?: string,
    expectedHead?: string
  ): Promise<string> {
    return this.mergeDelivery(ref, mergeCommit, carryApproval, expectedHead, false);
  }

  /** Merge a non-task PR using current owner/delegated approval; recovery only repeats follow-up. */
  async mergePr(ref: string): Promise<string> {
    return this.mergeDelivery(ref, false, undefined, undefined, true);
  }

  private async mergeDelivery(
    ref: string,
    mergeCommit: boolean,
    carryApproval: string | undefined,
    expectedHead: string | undefined,
    nonTask: boolean
  ): Promise<string> {
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
    if (nonTask) {
      this.nonTaskBranch(String(item.headRefName));
      if (
        taskIssueNumbers(String(item.body)) !== undefined ||
        item.baseRefName !== this.config.baseBranch
      ) {
        throw new Error("pr merge requires a non-task PR against baseBranch");
      }
    }
    if (expectedHead !== undefined && item.headRefOid !== expectedHead) {
      throw new Error("Head moved after conflict certification; approval not carried");
    }
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
      if (
        object(this.config.board).enabled !== false &&
        (await this.boardCard(item))?.values.Status !== "Approved"
      ) {
        throw new Error("merge-task requires an Approved PR");
      }
      for (const number of taskIssueNumbers(String(item.body)) ?? []) {
        const issue = await this.host.thread(String(number), "issue");
        const marker = /<!-- vmethod-task (\{[^\r\n]*\}) -->\s*$/.exec(String(item.body));
        const exception = marker ? object(JSON.parse(marker[1])).scopeException : undefined;
        if (
          !(typeof exception === "string" && exception.trim()) &&
          (await this.host.issueApproved(issue)) !== true
        ) {
          throw new Error(await this.host.scopeRefusal(issue));
        }
      }
      const baseSha = sha(item.baseRefOid);
      if (
        !(await git.transferOk("fetch", [
          `+refs/heads/${base}:refs/remotes/origin/${base}`,
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ]))
      ) {
        throw new Error("Fetch failed");
      }
      const liveBase = await liveBaseHead(base, { git });
      let certification: string | undefined;
      let autopilot = false;
      let autopilotHead = head;
      if (carryApproval !== undefined) {
        for (const approved of nonTask ? [] : await this.host.candidates(ref)) {
          const owner = (await this.host.approved(ref, approved)) === true;
          const delegated = !owner && (await this.host.autopilotApproved?.(ref, approved)) === true;
          if (!owner && !delegated) {
            continue;
          }
          if (
            delegated &&
            !(await cleanBaseMerges((...args) => git.run(...args), approved, head, baseSha))
          ) {
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
          const escalate = object(this.config.conflicts).escalatePaths;
          if (
            Array.isArray(escalate) &&
            files.some((file) => escalate.some((pattern) => matchesGlob(file, String(pattern))))
          ) {
            throw new Error(
              "Owner approval cannot be carried across an escalated conflict path; re-ask the owner"
            );
          }
          autopilot = delegated;
          autopilotHead = approved;
          certification = `${protocolHeading("APPROVAL CARRIED")}${delegated ? " (autopilot)" : ""} from ${approved} to ${head}: ${carryApproval}\n\nI certify there is no behaviour change or algorithmic revamp.\n\nRemerge-diff files:\n${files.length ? files.map((file) => `- ${JSON.stringify(file)}`).join("\n") : "- (none)"}`;
          break;
        }
        if (!certification) {
          throw new Error(
            "Owner approval cannot be carried: an earlier approval and only base-merge commits are required; re-ask the owner"
          );
        }
      } else if ((await this.host.approved(ref)) !== true) {
        autopilot = (await this.host.autopilotApproved?.(ref, head)) === true;
        let survived = autopilot;
        for (const approved of nonTask ? [] : await this.host.candidates(ref)) {
          if (survived) {
            break;
          }
          const owner = (await this.host.approved(ref, approved)) === true;
          const delegated = !owner && (await this.host.autopilotApproved?.(ref, approved)) === true;
          if (
            (owner || delegated) &&
            (await cleanBaseMerges((...args) => git.run(...args), approved, head, baseSha))
          ) {
            survived = true;
            autopilot = delegated;
            autopilotHead = approved;
            break;
          }
        }
        if (!survived) {
          throw new Error(await this.host.approvalRefusal(ref));
        }
      }
      if (autopilot) {
        const files = (await git.run("diff", "--name-only", `${liveBase}...${head}`))
          .trim()
          .split("\n");
        if (
          base === String(this.config.releaseBranch) ||
          files.some((file) =>
            /(?:^|\/)people\.ya?ml$|(?:^|\/)CODEOWNERS$|^(?:\.claude\/|\.opencode\/|opencode\.jsonc?$|vmethod\.yaml$)/.test(
              file
            )
          )
        ) {
          throw new Error(
            "Autopilot cannot authorize releases, identity or permission changes; ask the owner"
          );
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
      if (nonTask) {
        this.nonTaskBranch(String(current.headRefName));
        if (taskIssueNumbers(String(current.body)) !== undefined) {
          throw new Error("PR became a task during merge checks; use merge-task");
        }
      }
      // Hook execution can take minutes: re-fetch rather than trusting the PR's
      // potentially stale baseRefOid to detect base movement during verification.
      if (!(await git.transferOk("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
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
      if (nonTask && !autopilot && (await this.host.approved(ref)) !== true) {
        throw new Error(await this.host.approvalRefusal(ref));
      }
      if (item.isDraft) {
        await this.ready(item, false);
      }
      if (autopilot) {
        if (!(await this.host.autopilotApproved?.(ref, autopilotHead))) {
          throw new Error(
            autopilotHead === head
              ? "Autopilot revoked during merge checks; ask the owner at the current step"
              : "autopilot delegation is no longer current; ask the owner"
          );
        }
      }
      if (certification) {
        await this.post(ref, certification);
      }
      if (autopilot) {
        await this.post(
          ref,
          `${protocolHeading("AUTOPILOT")}\n\nMerging ${head} under autopilot, after my delivery review and the normal merge checks.`
        );
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
    // #275: with no worker record the PR never had a worker; the worker is absent,
    // not unknown, and the stop is skipped silently.
    if (!nonTask && !(await this.workerAbsent(ref))) {
      try {
        if (!this.deps.workers?.stop) {
          this.deps.report(
            `#${ref} worker stop unavailable (session unknown); continuing follow-up`
          );
        } else {
          const outcome = await this.deps.workers.stop(this.number(ref));
          this.deps.report(`#${ref} worker stop: ${outcome ?? "requested"}`);
          this.deps.report(`#${ref} worker status after stop: ${await this.status(ref)}`);
        }
      } catch {
        this.deps.report(`#${ref} worker stop failed; continuing follow-up`);
      }
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
    let keepBranch = nonTask ? false : (await preserveBranch()).preserve;
    const file = this.stateFile(ref);
    const journal: Journal = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Journal)
      : { head, base, branch, issues: nonTask ? [] : await this.issues(item), done: [] };
    if (journal.head !== head || journal.base !== base || journal.branch !== branch) {
      throw new Error("Merge journal does not match PR");
    }
    // Older completed journals may have missed the issue entirely. Reconcile newly
    // discoverable relations without replaying already-checkpointed issue writes.
    if (!nonTask && existsSync(file)) {
      const issues = await this.issues(item);
      if (JSON.stringify(journal.issues) !== JSON.stringify(issues)) {
        journal.issues = issues;
        journal.done = journal.done.filter((name) => name !== "estimates");
      }
    }
    this.save(file, journal);
    // One operation for the merge follow-up's issue and PR card writes (#199): the
    // watcher stays quiet while closures, board moves and turn clears land.
    this.host.github.writes.beginOperation(nonTask ? "pr-merge" : "merge-task", [
      { repo: this.repo, number: this.number(ref) },
      ...journal.issues.map((number) => ({ repo: this.repo, number })),
    ]);
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
    if (!pack && !nonTask) {
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
            !(await local.transferOk("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))
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
    if (!pack && !nonTask) {
      const worktrees = new WorktreeService(
        this.root,
        this.config,
        this.env,
        this.deps,
        // Merge recovery: an absent worker record is stopped, not unknown (#275).
        (pr) => this.status(String(pr), true),
        undefined,
        this.deps.workers?.captureUsage
      );
      const task = { pr: this.number(ref), branch, base, head, state: "MERGED" };
      await step("session", async () => {
        if (!(await worktrees.eligible(task))) {
          return false;
        }
        if (await this.workerAbsent(ref)) {
          // #275: a PR that never had a worker has no session to close or hide.
          return true;
        }
        if (!this.deps.workers?.close) {
          this.deps.report(`#${ref} session not closed: backend unavailable`);
          return false;
        }
        try {
          return await this.deps.workers.close(this.number(ref));
        } catch (error) {
          this.deps.report(`#${ref} session not closed: ${(error as Error).message}`);
          return false;
        }
      });
      await step("worktree", async () => worktrees.cleanup(task));
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

  /** Close an unmerged task PR without merging (#288): the delivery is abandoned.
   * The watcher moves the closed PR card to Done and reports the worktree cleanup
   * candidate; a linked issue stays open for the LAUNCH decision. Refused before
   * any write unless the PR is in the configured repository, open and a task PR. */
  async close(ref: string, comment?: string): Promise<string> {
    const item = await this.pr(ref);
    if (item.state !== "OPEN") {
      throw new Error("PR is not open");
    }
    // The watcher's task-PR test: a task header or a valid structured relation.
    if (taskIssueNumbers(String(item.body)) === undefined) {
      throw new Error("Closing requires a task PR (task header or vmethod-task relation)");
    }
    const body = comment === undefined ? undefined : readFileSync(comment, "utf8");
    if (body !== undefined) {
      // Checked like `issue close`, before any effect.
      await checkMarkdown(this.root, body);
      guardClosingKeywords(body);
    }
    // Stop the recorded worker exactly like merge follow-up. #275: with no worker
    // record the PR never had a worker; the stop is skipped silently. A failed
    // or unavailable stop never blocks the close; the watcher reports the worker.
    if (!(await this.workerAbsent(ref))) {
      try {
        if (!this.deps.workers?.stop) {
          this.deps.report(`#${ref} worker stop unavailable (session unknown); continuing`);
        } else {
          const outcome = await this.deps.workers.stop(this.number(ref));
          this.deps.report(`#${ref} worker stop: ${outcome ?? "requested"}`);
          this.deps.report(`#${ref} worker status after stop: ${await this.status(ref)}`);
        }
      } catch {
        this.deps.report(`#${ref} worker stop failed; continuing`);
      }
    }
    if (body !== undefined) {
      await this.post(ref, body);
    }
    const closed = object(
      await this.host.github.rest(this.path(ref, "pulls"), "PATCH", { state: "closed" }, false)
    );
    if (closed.state !== "closed") {
      throw new Error("PR closure not confirmed");
    }
    return `Closed #${ref}\nReminder: run grade ${ref}`;
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
