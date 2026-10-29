import { type Config } from "../config.js";
import { ModelRegistry } from "../core/config.js";
import { type Dependencies, type GitHubClient } from "../gateway/client.js";
import { type BoardOperation, type BoardService } from "../gateway/board.js";
import { object, type ObjectData, type Person } from "../gateway/people.js";
import { checkMarkdown, guardClosingKeywords } from "../gateway/markdown.js";
import { GitTransport, taskBranch, validateBranch } from "../gateway/git.js";
import { closingIssueNumbers } from "./markers.js";
import { ownerForTurn, setTurn, turnAssignees } from "../gateway/turn.js";
import type { AutopilotState } from "../evidence/autopilot.js";

/** Filtered gateway reads and write services shared by task operations and conflict hooks. */
export interface TaskHost {
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
  board: () => Pick<
    BoardService,
    "ensure" | "item" | "set" | "setArchived" | "capDone" | "snapshot" | "cards"
  >;
  people: Person[];
}
/** Validate a commit id before it reaches task git operations or journal records. */
export const sha = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f\d]{40}$/i.test(value)) {
    throw new Error("Invalid commit SHA");
  }
  return value;
};

/** Whether a task title can be used verbatim as a scope-free squash subject. */
export function conformingTitle(title: string): boolean {
  return /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|BREAKING CHANGE): \S[^\r\n]*$/.test(
    title
  );
}
/** Shared task identity gates, board writes and worker status; no workflow orchestration. */
export class TaskCommon {
  constructor(
    protected root: string,
    protected env: NodeJS.ProcessEnv,
    protected config: Config,
    protected deps: Dependencies,
    protected host: TaskHost,
    protected models = new ModelRegistry(root)
  ) {}

  async status(ref: string, forMerge = false): Promise<"live" | "stopped" | "unknown"> {
    const status = (await this.deps.workers?.status(this.number(ref), forMerge)) ?? "unknown";
    return ["live", "stopped", "unknown"].includes(status) ? status : "unknown";
  }

  protected number(ref: string): number {
    if (!/^[1-9]\d*$/.test(ref) || !Number.isSafeInteger(Number(ref))) {
      throw new Error("Expected own-repository PR/issue number");
    }
    return Number(ref);
  }

  protected get repo(): string {
    return this.config.repo ?? "undefined";
  }

  protected path(ref: string, kind = "issues"): string {
    return `/repos/${this.repo}/${kind}/${this.number(ref)}`;
  }

  protected git(cwd = this.root): GitTransport {
    return new GitTransport(this.config, this.env, this.deps, cwd);
  }

  protected async pr(ref: string): Promise<ObjectData> {
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

  protected track(item: ObjectData): void {
    const labels = object(item.labels).nodes;
    if (!Array.isArray(labels)) {
      throw new Error("Missing task labels");
    }
    const tracks = labels
      .map((label) => String(object(label).name))
      .filter((name) => name.startsWith("track:"));
    const expected = this.config.track ? [`track:${this.config.track}`] : [];
    if (JSON.stringify(tracks.sort()) !== JSON.stringify(expected)) {
      throw new Error("Task belongs to another track");
    }
  }

  protected async post(ref: string, body: string): Promise<void> {
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    await this.host.github.rest(`${this.path(ref)}/comments`, "POST", { body }, false);
  }

  protected async card(
    item: ObjectData,
    status: string | undefined,
    progress: string | null,
    model?: string
  ): Promise<void> {
    if (this.config.board?.enabled === false) {
      return;
    }
    const board = this.host.board();
    const operation: BoardOperation = {};
    const id = await board.ensure(String(item.id), operation);
    if (status) {
      await board.set({ itemId: id, field: "Status", value: status, progress }, operation);
    } else {
      await board.set({ itemId: id, field: "Progress", value: progress }, operation);
    }
    if (model) {
      await board.set({ itemId: id, field: "Model", value: model }, operation);
    }
  }

  protected async boardCard(item: ObjectData) {
    if (this.config.board?.enabled === false) {
      return undefined;
    }
    const board = this.host.board();
    const snapshot = await board.snapshot();
    return (await board.cards(snapshot.id)).find((card) => card.contentId === item.id);
  }

  protected async assigned(ref: string): Promise<string[]> {
    const current = object(await this.host.github.rest(this.path(ref)));
    if (!Array.isArray(current.assignees)) {
      throw new Error("Missing assignees");
    }
    return current.assignees.map((person) => String(object(person).login));
  }

  protected async turn(
    ref: string,
    role: "owner" | "orchestrator" | "worker" | null
  ): Promise<void> {
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

  protected async ready(item: ObjectData, draft: boolean): Promise<void> {
    if (item.isDraft === draft) {
      return;
    }
    const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    await this.host.github.graphql(
      `mutation TaskReady($id: ID!) { ${mutation}(input: {pullRequestId: $id}) { pullRequest { id } } }`,
      { id: item.id }
    );
  }

  protected nonTaskBranch(branch: string): void {
    taskBranch(branch, this.config);
    const branches = this.config.branches ?? {};
    const pattern = (branches.taskPattern ?? "<number>-<slug>")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      // Issue-less open-task deliveries use an eight-character title hash.
      .replaceAll("<number>", "(?:\\d+|[a-f\\d]{8})")
      .replaceAll("<slug>", "[A-Za-z0-9._-]+");
    if (
      new RegExp(`^${pattern}$`).test(branch) ||
      branch.startsWith(branches.packPrefix ?? "pack/")
    ) {
      throw new Error("Task branches use open-task and merge-task");
    }
  }

  protected async closingLinks(
    item: ObjectData,
    issues: number[],
    unlink: boolean
  ): Promise<boolean> {
    if (!issues.length) {
      return false;
    }
    const references = closingIssueNumbers(item, this.repo);
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
      const remaining = closingIssueNumbers(await this.pr(String(item.number)), this.repo);
      if (issues.some((number) => remaining.has(number))) {
        throw new Error(
          "Closing reference remains; --unlink removes manual links only, not automatic body references"
        );
      }
    }
    return changed;
  }
}
