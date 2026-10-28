import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { assertEstimate } from "../board/estimate.js";
import { ownerAgreement } from "./owner-agreement.js";
import { getConfig, loadYaml, type Config } from "../config.js";
import { WorkerWorktrees } from "./worker-launch.js";
import { WorktreeService, type WorktreeTask } from "./worktrees.js";
import { GitHubClient, GitHubHttpError, type Dependencies } from "./client.js";
import { Digest, stateRoot } from "./digest.js";
import {
  PeopleFilter,
  labelled,
  object,
  untrusted,
  checkFacts,
  type ObjectData,
  type Person,
} from "./people.js";
import {
  actorFields,
  filterData,
  filterDiagnostic,
  identityFields,
  readQuery,
  renderItem,
  repoOf,
  restActor,
} from "./queries.js";
import {
  checkMarkdown,
  guardClosingKeywords,
  guardDependencyText,
  guardProtocolHeader,
} from "./markdown.js";
import {
  inProcess,
  type CallContext,
  type Handlers,
  type Operations,
  type Transport,
} from "./transport.js";
import { tokenIdentity, tokenViewer } from "./identity.js";
import { approvalRefusal, isOwnerApproved } from "./approval.js";
import { bodyHash, ScopeReader, legacyScopeCutoff } from "./scope.js";
import {
  itemKey,
  readThreadSnapshot,
  saveThreadSnapshot,
  snapshotBase,
  threadContent,
  threadDiff,
  threadId,
  threadSection,
  threadTime,
  type ThreadItem,
} from "./thread.js";
import { AutopilotReader, inheritAutopilot, type AutopilotState } from "./autopilot.js";
import { taskIssueNumbers } from "./task-flow-types.js";
import { ownerForTurn, setTurn, turnAssignees } from "./turn.js";
import { renderProgress } from "../board/progress.js";
import { workflowColumns } from "../board/runner.js";
import { legacyIssueHeaders, TaskFlow } from "./task-flow.js";
import { isTaskPrompt } from "./task-flow-types.js";
import { GitTransport, pushFailureMessage, taskBranch, validateBranch } from "./git.js";
import { realpathSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { BoardService } from "./board.js";
import { WorkerService, type TaskMetadata } from "./workers.js";
import {
  EventLoop,
  eventDeps,
  resolveSession,
  muteThread,
  unmuteThread,
  listMutes,
} from "./events.js";
import { procWatchStopDeps, watchStop } from "./watch-stop.js";

import { ChecksService } from "./checks.js";
import { VerificationService } from "./verify.js";
import {
  blockerLabel,
  blockerReference,
  parentReference,
  reference,
  type ThreadRef,
} from "./refs.js";
import { LearningsService, central } from "./learnings.js";
import { LearningAnnotations, type LearningBundle } from "./learning-annotations.js";
import { checkLearningPr } from "./learning-check.js";
import { upstreamCaller, upstreamFooter } from "./upstream.js";
import { mergeLearningPr } from "./learning-merge.js";
import { releaseNext } from "./release.js";
import { ConflictService } from "./conflicts.js";
import { verifyConflictHead } from "./verify-hook.js";
import { isModelApproved } from "./model-gate.js";

class GatewayServer {
  private config: Config;
  private readonly watchStateConfig: Config;
  private peopleMtime: number;
  private configMtime: number;
  private readonly filter: PeopleFilter;
  private readonly digest: Digest;
  // Lazy: offline CLI verbs never create or authenticate a gateway client.
  private client?: GitHubClient;
  private identity?: Promise<ObjectData>;
  private boardClient?: BoardService;
  private workersClient?: WorkerService;

  /** Cache the promise too, so concurrent first calls share one viewer lookup. */
  async authenticate(ctx: CallContext, operation: keyof Operations): Promise<boolean> {
    const viewer = await (this.identity ??= tokenViewer(this.github));
    const actionsLearningCheck =
      operation === "learningCheck" &&
      this.env.GITHUB_ACTIONS === "true" &&
      ctx.taskPr === undefined;
    const person = tokenIdentity(viewer, this.filter, actionsLearningCheck);
    // Authority is per repository (#186): a peer project's orchestrator holds no
    // gateway orchestration role for this configuration's repository.
    const role = this.filter.roleIn(person, String(this.config.repo));
    // The CI-only learning validator retains its pinned-base registry and write gates.
    // Neither an environment flag alone nor a system identity grants any other verb.
    if (person.role === "system" && actionsLearningCheck) {
      return true;
    }
    if (role !== "orchestrator" && role !== "worker") {
      throw new Error(
        `Gateway token refused: ${person.login} (${role}) is not an orchestrator or worker identity`
      );
    }
    if (ctx.taskPr !== undefined && role !== "worker") {
      throw new Error(
        `worker session holds a non-worker token (${person.login}); fix the worker environment`
      );
    }
    if (ctx.role === "orchestrator" && role !== "orchestrator") {
      throw new Error(
        `VMETHOD_ROLE=orchestrator refused: token belongs to ${person.login} (${role})`
      );
    }
    return false;
  }

  private get workerWorktrees(): WorkerWorktrees {
    return new WorkerWorktrees(this.root, this.config, this.env, this.deps);
  }

  private get workers(): WorkerService {
    return (this.workersClient ??= new WorkerService(this.root, this.config, this.env, this.deps, {
      metadata: (pr) => this.workerMetadata(pr),
      prepare: async (pr) => {
        const task = await this.task({ ref: String(pr) }, { role: "orchestrator" });
        return this.workerWorktrees.prepare({ pr, ...task });
      },
      locate: async (pr) => {
        const task = await this.task({ ref: String(pr) }, { role: "orchestrator" });
        return this.workerWorktrees.locate(task.branch);
      },
      setModel: async (pr, family) => {
        await this.setWorkerField(pr, "pr", "Model", family);
      },
      modelComment: async (pr, body) => {
        await checkMarkdown(this.root, body);
        guardClosingKeywords(body);
        const { person } = await this.thread(String(pr), "pr");
        if (!person) {
          throw new Error("Refusing model note on unaccepted PR");
        }
        await this.github.rest(`/repos/${String(this.config.repo)}/issues/${pr}/comments`, "POST", {
          body,
        });
      },
      setEstimate: (issue, points) => this.setWorkerField(issue, "issue", "Estimate", points),
      setCost: (pr, cost) => this.setWorkerField(pr, "pr", "Cost", cost),
      gradeComment: async (issue, body) => {
        await checkMarkdown(this.root, body);
        guardClosingKeywords(body);
        const { person } = await this.thread(String(issue), "issue");
        if (!person) {
          throw new Error("Refusing GRADE on unaccepted issue");
        }
        await this.github.rest(
          `/repos/${String(this.config.repo)}/issues/${issue}/comments`,
          "POST",
          { body }
        );
      },
      modelApproval: (pr, issue, family) => this.modelApproval(family, { pr, issue }),
      submitLearnings: () => this.learningService().command({ action: "submit" }),
      issue: (issue) => this.workerIssue(issue),
      diffStats: async (_pr, base, head) => {
        if (![base, head].every((sha) => /^[a-f0-9]{40}$/i.test(sha))) {
          throw new Error("Invalid diff boundary SHA");
        }
        if (base === head) {
          return { files: 0, additions: 0, deletions: 0 };
        }
        const result = object(
          await this.github.rest(`/repos/${String(this.config.repo)}/compare/${base}...${head}`)
        );
        if (!Array.isArray(result.files) || result.files.length >= 300) {
          return null;
        }
        return {
          files: result.files.length,
          additions: result.files.reduce((n, f) => n + Number(object(f).additions), 0),
          deletions: result.files.reduce((n, f) => n + Number(object(f).deletions), 0),
        };
      },
    }));
  }

  worker: Handlers["worker"] = async ({ args }) => {
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

  private get worktrees(): WorktreeService {
    return new WorktreeService(
      this.root,
      this.config,
      this.env,
      this.deps,
      (pr) => (this.deps.workers ? this.deps.workers.status(pr) : this.workers.mergeStatus(pr)),
      (pr) => this.workers.closeSession(pr),
      (pr) => this.workers.captureUsage(pr)
    );
  }

  private async worktreeTask(pr: number): Promise<WorktreeTask> {
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

  private async worktreeTaskFor(branch: string): Promise<WorktreeTask | undefined> {
    const tasks: number[] = [];
    for (let page = 1; ; page++) {
      const data = await this.github.rest(
        `/repos/${String(this.config.repo)}/pulls?state=all&head=${encodeURIComponent(`${String(this.config.repo).split("/")[0]}:${branch}`)}&per_page=100&page=${page}`
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
  grade: Handlers["grade"] = async ({ ref, points }) =>
    this.workers.grade(this.localNumber(ref), points);
  suggestModel: Handlers["suggestModel"] = async ({ ref }) => {
    const suggestion = await this.workers.suggest(this.localNumber(ref));
    const family = suggestion.split(":", 1)[0];
    return `${suggestion}\n${await this.learningService().show(family)}`;
  };
  learnings: Handlers["learnings"] = async (input) => {
    if (input.action === "annotate" || input.action === "aggregate") {
      return new LearningAnnotations(
        this.root,
        this.config,
        this.env,
        this.deps,
        () => this.learningService().records(),
        (pr) => this.learningBundle(pr)
      ).command(input);
    }
    // Orchestrator-only central merge of an authorized learning submission (#308).
    if (input.action === "merge") {
      if (String(this.config.repo).toLowerCase() !== "vworlds/vmethod") {
        throw new Error("Learning PR merges run only in the central repository");
      }
      if (!Number.isSafeInteger(input.pr) || input.pr < 1) {
        throw new Error("Invalid learning PR number");
      }
      return mergeLearningPr(this.github, this.filter, input.pr);
    }
    return this.learningService().command(input);
  };

  private async learningBundle(pr: number): Promise<LearningBundle> {
    const meta = await this.workerMetadata(pr);
    if (!meta.issue || meta.state === "OPEN" || !meta.closedAt) {
      throw new Error("Annotation requires a closed task PR with one linked issue");
    }
    const issue = await this.richThread(meta.issue, "issue");
    const comments = [...meta.comments];
    // Grade lives on the issue; include owner and orchestrator evidence there as well.
    for (const entry of await this.collection(String(issue.id), "Issue", "comments")) {
      if (
        !this.filter.accept(
          entry,
          repoOf(entry).owner,
          `https://github.com/${String(this.config.repo)}/issues/${meta.issue}`
        )
      ) {
        continue;
      }
      const c = await this.node(String(entry.id), "body createdAt url", "IssueComment");
      const author = this.filter.accept(
        c,
        repoOf(c).owner,
        `https://github.com/${String(this.config.repo)}/issues/${meta.issue}`
      );
      if (!author || this.filter.identity(c.author)?.role !== author.role) {
        continue;
      }
      if (
        typeof c.body !== "string" ||
        typeof c.url !== "string" ||
        !Number.isFinite(Date.parse(String(c.createdAt)))
      ) {
        throw new Error("Incomplete annotation comment");
      }
      if (/^\[orchestrator\] GRADE\b/.test(c.body) && !c.body.includes(`Graded PR #${pr}:`)) {
        continue;
      }
      comments.push({
        body: c.body,
        role: this.learningRole(author),
        date: String(c.createdAt),
        url: c.url,
      });
    }
    return {
      repo: String(this.config.repo),
      pr,
      closedAt: meta.closedAt,
      issue: {
        body: String(issue.body),
        url: `https://github.com/${String(this.config.repo)}/issues/${meta.issue}`,
      },
      comments,
      diff: meta.diff ?? null,
    };
  }
  learningCheck: Handlers["learningCheck"] = async ({ ref, label }) => {
    if (String(this.config.repo).toLowerCase() !== "vworlds/vmethod") {
      throw new Error("Learning PR checks run only in the central repository");
    }
    return checkLearningPr(this.github, this.localNumber(ref), label);
  };

  private learningService(): LearningsService {
    return new LearningsService(this.root, this.config, this.env, this.deps, () => this.github);
  }
  private learningRole(person: Person): string {
    if (person.role !== "orchestrator") {
      return person.role;
    }
    const [login] = turnAssignees(this.filter.people, String(this.config.repo), [], "orchestrator");
    return person.login.toLowerCase() === login.toLowerCase()
      ? "orchestrator"
      : "peer-orchestrator";
  }
  private localNumber(ref: string): number {
    const target = reference(ref, this.config);
    if (target.repo.toLowerCase() !== String(this.config.repo).toLowerCase()) {
      throw new Error("Worker operations require configured repository");
    }
    return target.number;
  }

  private projectCard(item: ObjectData): ObjectData {
    const nodes = object(item.projectItems).nodes;
    if (!Array.isArray(nodes)) {
      throw new Error("Missing task project metadata");
    }
    return object(
      nodes.find(
        (value) =>
          object(object(value).project).number === object(this.config.board).number &&
          String(object(object(object(value).project).owner).login).toLowerCase() ===
            String(object(this.config.board).owner).toLowerCase()
      )
    );
  }
  private projectValue(item: ObjectData, field: string): unknown {
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
  private async richThread(ref: number, kind: "pr" | "issue"): Promise<ObjectData> {
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
  private async setWorkerField(
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
  private async workerIssue(issue: number): Promise<{ estimate?: number; kind: string }> {
    const item = await this.richThread(issue, "issue");
    const estimate = this.projectValue(item, "Estimate");
    const labels = object(item.labels).nodes;
    return {
      estimate: typeof estimate === "number" ? estimate : undefined,
      kind: Array.isArray(labels)
        ? labels.map((v) => String(object(v).name)).join(", ") || "other"
        : "other",
    };
  }
  private async workerMetadata(pr: number): Promise<TaskMetadata> {
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
    const header = /^# Task:.*?\((?:part of )?issue #([1-9]\d*)\)/m.exec(body);
    if (header) {
      numbers.add(Number(header[1]));
    }
    if (!numbers.size) {
      for (const issue of legacyIssueHeaders(body)) {
        numbers.add(issue);
      }
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
        ? labels.map((v) => String(object(v).name)).join(", ") || "other"
        : "other";
    }
    const comments: TaskMetadata["comments"] = [];
    for (const meta of await this.collection(String(item.id), "PullRequest", "comments")) {
      if (
        !this.filter.accept(
          meta,
          repoOf(meta).owner,
          `https://github.com/${String(this.config.repo)}/pull/${pr}`
        )
      ) {
        continue;
      }
      const comment = await this.node(String(meta.id), "body createdAt url", "IssueComment");
      const author = this.filter.accept(
        comment,
        repoOf(comment).owner,
        `https://github.com/${String(this.config.repo)}/pull/${pr}`
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
  private readonly loops = new Map<string, EventLoop>();
  private readonly eventReaders = new Set<string>();

  nextEvents: Handlers["nextEvents"] = async (input) => {
    const name = resolveSession(this.watchStateConfig, input).stateName;
    // The guard belongs to the session, not a loop that a config edit can replace.
    if (this.eventReaders.has(name)) {
      throw new Error("watch: another reader is already waiting for this session");
    }
    this.eventReaders.add(name);
    try {
      return await this.eventLoop(input).nextEvents(input);
    } finally {
      this.eventReaders.delete(name);
    }
  };

  private eventLoop(input: Parameters<Handlers["nextEvents"]>[0]): EventLoop {
    const session = resolveSession(this.watchStateConfig, input);
    const name = session.stateName;
    let loop = this.loops.get(name);
    if (!loop) {
      const methodology = String(object(this.config.vmethod).repo ?? "vworlds/vmethod");
      const filter = new PeopleFilter(
        this.filter.people,
        String(this.config.org),
        this.digest,
        methodology === "off" ? [] : [methodology]
      );
      loop = new EventLoop(
        {
          root: this.root,
          config: this.config,
          env: this.env,
          deps: eventDeps(this.deps),
          filter,
          refresh: () => {
            this.reloadWatchFiles();
            filter.reload(this.filter.people);
            return this.eventLoop(input);
          },
          github: this.github,
          workerStatus: (pr) => this.workers.watchStatus(pr),
          // Without a configured worker checkout no task can have a worker worktree.
          workerTrees: async () =>
            this.config.workerCheckout === undefined ? [] : this.workerWorktrees.registered(),
          workerSend: (pr, text) => this.workers.resume(pr, text),
          workerMetric: (pr, event) => this.workers.recordMetric(pr, event),
          resolveConflicts: (pr) => this.conflicts.resolve(pr),
          conflictPending: (pr) => this.conflicts.pending(pr),
          conflictFixing: (pr) => this.conflicts.fixing(pr),
          board: {
            set: (input) => this.board.set(input),
            moveToTop: (itemId) => this.board.moveToTop(itemId),
          },
          digest: this.digest,
        },
        input,
        session
      );
      this.loops.set(name, loop);
    }
    return loop;
  }

  private reloadWatchFiles(): void {
    // Remember attempted versions too: a bad edit is reported once, not every poll.
    const peopleMtime = this.watchMtime("people");
    if (peopleMtime !== this.peopleMtime) {
      this.peopleMtime = peopleMtime;
      try {
        this.filter.reload(loadYaml(this.root, "people") as Person[]);
        const owners = this.filter.people.filter((p) => p.role === "owner").map((p) => p.login);
        this.deps.report(`people.yaml reloaded (owners: ${owners.join(", ")})`);
      } catch (error) {
        this.deps.report(
          `people.yaml reload failed: ${(error as Error).message}; keeping the previous list`
        );
      }
    }
    const configMtime = this.watchMtime("vmethod");
    if (configMtime !== this.configMtime) {
      this.configMtime = configMtime;
      let config: Config;
      try {
        config = getConfig(this.root, this.env);
      } catch (error) {
        this.deps.report(
          `vmethod.yaml reload failed: ${(error as Error).message}; keeping the previous config`
        );
        return;
      }
      for (const loop of this.loops.values()) {
        loop.close();
      }
      this.loops.clear();
      this.config = config;
      this.client = undefined;
      this.boardClient = undefined;
      this.workersClient = undefined;
      this.deps.report("vmethod.yaml reloaded");
    }
  }

  private watchMtime(kind: string): number {
    try {
      return statSync(resolve(this.root, `${kind}.yaml`)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return -1;
      }
      throw error;
    }
  }
  watchMute: Handlers["watchMute"] = async ({ ref }) => muteThread(this.config, this.env, ref);
  watchUnmute: Handlers["watchUnmute"] = async ({ ref }) =>
    unmuteThread(this.config, this.env, ref);
  watchMutes: Handlers["watchMutes"] = async () => listMutes(this.config, this.env);
  /** Stop the running watcher for this resolved session's state directory (#340):
   * the same session resolution as `nextEvents`, without starting a loop.
   */
  watchStop: Handlers["watchStop"] = async ({ force, ...session }) =>
    watchStop(
      stateRoot(this.env, resolveSession(this.watchStateConfig, session).stateName),
      force === true,
      procWatchStopDeps(this.deps.now, this.deps.sleep)
    );

  private get ci(): ChecksService {
    return new ChecksService(this.config, this.github, this.filter, this.deps);
  }

  private get conflicts(): ConflictService {
    return new ConflictService(this.root, this.config, this.env, eventDeps(this.deps), {
      snapshot: async (pr) => {
        await this.flow.conflictTask(String(pr));
        return this.ci.snapshot(String(pr));
      },
      approved: async (pr, head) =>
        (await this.approvalFor(String(pr), head)) === true ||
        (await this.autopilotApprovalFor(String(pr), head)),
      update: async (pr, head) => {
        await this.github.rest(
          `/repos/${String(this.config.repo)}/pulls/${pr}/update-branch`,
          "PUT",
          {
            expected_head_sha: head,
          },
          false
        );
      },
      wait: (pr) => this.ci.wait({ ref: String(pr) }),
      fix: (pr, base, files) => this.workers.resolveConflict(pr, base, files),
      status: (pr) => this.workers.mergeStatus(pr, true),
      stop: async (pr) => {
        await this.workers.command(["stop", String(pr)]);
      },
      workerBlocked: async (pr, since) => {
        const meta = await this.workerMetadata(pr);
        const latest = meta.comments
          .filter((comment) => comment.role === "worker" && Date.parse(comment.date) >= since)
          .sort((a, b) => a.date.localeCompare(b.date))
          .at(-1);
        return !!latest && /^\[worker\] (BLOCKED|QUESTION)\b/.test(latest.body);
      },
      directory: (pr) => this.workers.conflictDirectory(pr),
      verify: async (directory, head, reportNotice) => {
        return verifyConflictHead(directory, head, this.config, this.env, this.deps, reportNotice);
      },
      blocked: async (pr, reason, files) => {
        await this.flow.escalateConflict(String(pr), reason, files);
      },
      merge: async (pr, reason, head) => {
        await this.flow.merge(String(pr), false, reason, head);
      },
      cardPrior: (pr) => this.flow.cardPrior(String(pr)),
      cardConflict: (pr) => this.flow.cardConflict(String(pr)),
      cardRestore: (pr, prior) => this.flow.cardRestore(String(pr), prior),
      lifecycle: (pr) => this.flow.pullLifecycle(String(pr)),
    });
  }

  resolveConflicts: Handlers["resolveConflicts"] = async ({ ref, retry }) =>
    this.conflicts.resolve(this.localNumber(ref), retry);

  private get verification(): VerificationService {
    return new VerificationService(
      this.root,
      this.env,
      this.config,
      this.deps,
      this.ci,
      (input, taskPr) => this.push(input, { role: "orchestrator", taskPr })
    );
  }

  waitChecks: Handlers["waitChecks"] = async (input) => this.ci.wait(input);
  checkTaskCi: Handlers["checkTaskCi"] = async ({ ref }) => this.ci.check(ref);
  refreshChecks: Handlers["refreshChecks"] = async ({ ref }) => this.verification.refresh(ref);
  verify: Handlers["verify"] = async (input) => this.verification.verify(input);

  releaseNext: Handlers["releaseNext"] = async () =>
    releaseNext(this.root, this.config, this.env, this.deps, () => this.github);

  private get board(): BoardService {
    return (this.boardClient ??= new BoardService(
      this.config,
      this.github,
      this.deps,
      undefined,
      undefined,
      this.filter
    ));
  }

  boardStatus: Handlers["boardStatus"] = async ({ fix }) =>
    fix ? this.board.fixStatus() : this.board.status();
  boardInit: Handlers["boardInit"] = async (input) => {
    if (input.steal !== undefined && typeof input.steal !== "boolean") {
      throw new Error("Invalid initialization flags");
    }
    return this.board.init(input);
  };
  boardMigrate: Handlers["boardMigrate"] = async (input) => {
    if (
      (input.dryRun !== undefined && typeof input.dryRun !== "boolean") ||
      (input.steal !== undefined && typeof input.steal !== "boolean")
    ) {
      throw new Error("Invalid migration flags");
    }
    return this.board.migrate(input);
  };
  boardItem: Handlers["boardItem"] = async ({ itemId }) => this.board.item(itemId);
  boardSet: Handlers["boardSet"] = async (input) => this.board.set(input);
  /** Set an issue board field, or clear Progress/Estimate with a null value. */
  boardSetIssue: Handlers["boardSetIssue"] = async ({ ref, field, value }) => {
    this.localNumber(ref);
    const issue = await this.flowThread(ref, "issue");
    return this.board.setIssueField(String(issue.id), field, value);
  };

  /** Orchestrator-only management-turn housekeeping (#257): the board service validates
   * the requested assignee against the card's Status and Progress and journals the writes. */
  boardSetAssignees: Handlers["boardSetAssignees"] = async ({ ref, value }) => {
    const number = this.localNumber(ref);
    return this.board.setAssignees(number, value);
  };

  /** Create an own-repository issue from checked content and ensure readable configured-board
   * membership. Optional estimate/status use the shared board field writer; estimates must
   * use the shared points scale and labels may repeat. Status defaults to the first workflow
   * column (Backlog), so a card filed without --status is never in no column.
   * Board follow-up failures identify the created issue and name the exact
   * `board add` retry command with the original flags (#287), so callers never
   * recreate a duplicate. `--parent <epic>` attaches the fresh issue to a
   * configured-repository epic after the board follow-up (#327); a failed attachment
   * names the `issue parent` retry with the same keep-the-issue pattern.
   */
  issueCreate: Handlers["issueCreate"] = async ({
    title,
    file,
    labels = [],
    estimate,
    status,
    parent,
  }) => {
    if (
      Array.isArray(labels) &&
      labels.some(
        (label) => typeof label === "string" && label.trim().toLowerCase() === "autopilot"
      )
    ) {
      throw new Error("Only the owner may add autopilot; issue create cannot grant delegation");
    }
    if (
      typeof title !== "string" ||
      !title.trim() ||
      /[\r\n]/.test(title) ||
      !Array.isArray(labels) ||
      labels.some((label) => typeof label !== "string" || !label.trim())
    ) {
      throw new Error("Invalid issue title or labels");
    }
    if (estimate !== undefined) {
      assertEstimate(estimate);
    }
    if (status !== undefined && (typeof status !== "string" || !status.trim())) {
      throw new Error("Invalid issue status");
    }
    // A parent outside the configured repository is refused before the create, so a
    // failed spec never leaves a detached #327 sub-issue behind.
    const epicRef = parent === undefined ? undefined : this.subIssueParentRef(parent);
    const boardEnabled = object(this.config.board).enabled !== false;
    if (!boardEnabled && (estimate !== undefined || status !== undefined)) {
      throw new Error("Board is disabled; estimate/status require a configured board");
    }
    const body = readFileSync(file, "utf8");
    guardDependencyText(body);
    await checkMarkdown(this.root, `${title}\n\n${body}`);
    guardClosingKeywords(`${title}\n\n${body}`);
    const created = object(
      await this.github.rest(
        `/repos/${String(this.config.repo)}/issues`,
        "POST",
        { title, body, labels },
        false
      )
    );
    if (!Number.isSafeInteger(created.number) || Number(created.number) < 1) {
      throw new Error("Missing created issue number; inspect repository before retrying");
    }
    if (boardEnabled) {
      try {
        if (typeof created.node_id !== "string" || !created.node_id) {
          throw new Error("Missing created issue node ID");
        }
        const board = this.board;
        // One operation for the board init writes (#199): membership add, then the
        // Estimate/Status fields in a single ordered mutation.
        this.github.writes.beginOperation("issue create", [
          { repo: String(this.config.repo), number: Number(created.number) },
        ]);
        await board.ensure(created.node_id);
        // One ordered board mutation, Status last with its progress companion (#199);
        // the created issue's default Status files it in the first workflow column (#231).
        await board.setIssueFields(created.node_id, [
          ...(estimate !== undefined ? [{ name: "Estimate", value: String(estimate) }] : []),
          { name: "Status", value: status ?? workflowColumns[0] },
        ]);
      } catch (error) {
        // The retry hint is the orchestrator's repair path (#287): it passes the
        // created issue's original estimate/status flags to `board add`, which can
        // exactly redo the failed membership and field writes idempotently.
        const flags = [
          ...(estimate !== undefined ? ["--estimate", String(estimate)] : []),
          ...(status !== undefined ? ["--status", status] : []),
        ];
        throw new Error(
          `Created issue #${String(created.number)}; board follow-up failed: ${error instanceof Error ? error.message : String(error)}. Do not recreate; inspect this issue and retry board operations only; retry with: vmethod board add ${String(created.number)}${flags.length ? ` ${flags.join(" ")}` : ""}${epicRef ? `; then attach with: vmethod issue parent ${String(created.number)} ${epicRef.number}` : ""}`,
          { cause: error }
        );
      }
    }
    // Attach to the epic only after the board follow-up: each follow-up step reports its
    // own failure and names its own retry, so a broken step never hides another (#327).
    if (epicRef) {
      try {
        if (typeof created.node_id !== "string" || !created.node_id) {
          throw new Error("Missing created issue node ID");
        }
        await this.relateSubIssue(
          { number: Number(created.number), id: String(created.node_id) },
          epicRef,
          "add"
        );
      } catch (error) {
        throw new Error(
          `Created issue #${String(created.number)}; parent attachment failed: ${error instanceof Error ? error.message : String(error)}. Do not recreate; inspect this issue and retry the attachment only; retry with: vmethod issue parent ${String(created.number)} ${epicRef.number}`,
          { cause: error }
        );
      }
      return `Created issue #${String(created.number)}; attached to epic ${blockerLabel(epicRef, this.config)}`;
    }
    return `Created issue #${String(created.number)}`;
  };

  /** Orchestrator-only upstream filing on the central repository (#333): the caller
   * must be a centrally bound orchestrator — the same check as `learnings submit`,
   * run before any write — and the body passes the shared post checks. The footer
   * names the consumer repository and its pinned vmethod version for the vmethod
   * owner's triage; no labels, assignees or board writes happen. */
  upstreamIssue: Handlers["upstreamIssue"] = async ({ title, file }) => {
    if (typeof title !== "string" || !title.trim() || /[\r\n]/.test(title)) {
      throw new Error("Invalid upstream issue title");
    }
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) {
      throw new Error("Post must contain nonempty Markdown");
    }
    const body = `${raw.trimEnd()}\n\n${upstreamFooter(String(this.config.repo))}`;
    await checkMarkdown(this.root, `${title}\n\n${body}`);
    guardClosingKeywords(`${title}\n\n${body}`);
    await upstreamCaller(this.github, String(this.config.repo));
    const created = object(
      await this.github.rest(`/repos/${central}/issues`, "POST", { title, body }, false)
    );
    if (!Number.isSafeInteger(created.number) || Number(created.number) < 1) {
      throw new Error("Missing created issue number; inspect repository before retrying");
    }
    return `https://github.com/${central}/issues/${String(created.number)}`;
  };

  /** The comment sibling (#333): the same central gate and body checks, posted to an
   * existing central-repository issue — a pull request or a missing number is
   * refused by the GraphQL issue lookup before any write. */
  upstreamComment: Handlers["upstreamComment"] = async ({ ref, file }) => {
    if (typeof ref !== "string" || !/^[1-9]\d*$/.test(ref) || !Number.isSafeInteger(Number(ref))) {
      throw new Error("Invalid upstream issue reference");
    }
    const number = Number(ref);
    const body = readFileSync(file, "utf8");
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    await upstreamCaller(this.github, String(this.config.repo));
    const found = object(
      await this.github.graphql(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }`,
        { owner: central.split("/")[0], name: central.split("/")[1], number }
      )
    );
    if (!object(object(found.repository).issue).id) {
      throw new Error(`Upstream issue not found: ${central}#${number}`);
    }
    const posted = object(
      await this.github.rest(`/repos/${central}/issues/${number}/comments`, "POST", { body }, false)
    );
    if (!Number.isSafeInteger(posted.id) || !posted.node_id) {
      throw new Error("Missing comment id; inspect the upstream issue before retrying");
    }
    return `Commented on https://github.com/${central}/issues/${number}`;
  };

  /** Orchestrator-only retry of issue create's board follow-up (#287): membership
   * through `board.ensure` (the issue-side relation), then one `setIssueFields` call
   * with the effective entries, inside the same journaled operation (#199). Idempotent: an
   * off-board issue gains Status (the --status value or the first workflow column)
   * plus any passed Estimate; a card already on the board keeps its Status unless
   * --status is given and only the passed fields change, so a re-run never moves
   * it back to Backlog. A foreign reference, a PR and a closed issue are refused
   * before any write. */
  boardAdd: Handlers["boardAdd"] = async ({ ref, estimate, status }) => {
    if (estimate !== undefined) {
      assertEstimate(estimate);
    }
    if (status !== undefined && (typeof status !== "string" || !status.trim())) {
      throw new Error("Invalid issue status");
    }
    if (object(this.config.board).enabled === false) {
      throw new Error("Board is disabled; board add requires a configured board");
    }
    const number = this.localNumber(ref);
    const issue = await this.flowThread(String(number), "issue");
    if (issue.state !== "OPEN") {
      throw new Error(`Refusing board add on closed issue #${number}`);
    }
    const contentId = String(issue.id);
    const card = await this.board.issueCard(contentId);
    // The field plan mirrors issue create's follow-up: a fresh card files in the
    // first workflow column unless --status names one; an on-board card keeps its
    // Status and receives only the fields that were passed (#287).
    const entries = [
      ...(estimate !== undefined ? [{ name: "Estimate", value: String(estimate) }] : []),
      ...(!card || status !== undefined
        ? [{ name: "Status", value: status ?? workflowColumns[0] }]
        : []),
    ];
    // One operation for the board writes (#199), exactly as issue create's
    // follow-up: the membership add, then the fields in a single ordered mutation.
    this.github.writes.beginOperation("board add", [{ repo: String(this.config.repo), number }]);
    await this.board.ensure(contentId);
    if (entries.length) {
      await this.board.setIssueFields(contentId, entries);
    }
    return card
      ? entries.length
        ? `Repaired issue #${number} board fields`
        : `Issue #${number} is already on the board`
      : `Added issue #${number} to the board`;
  };

  /** Close an accepted own-repository issue, optionally posting a validated file comment first. */
  /** Rewrite only the exact body previously returned by read issue. */
  issueEdit: Handlers["issueEdit"] = async ({ ref, file, scopeReview }) => {
    const number = this.localNumber(ref);
    const body = readFileSync(file, "utf8");
    guardDependencyText(body);
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    // #359: validate the paired summary before any write, exactly like the standalone
    // scope-review verb; the edit below then hands the new body straight to review.
    const summary = scopeReview === undefined ? undefined : this.scopeSummary(scopeReview);
    const item = await this.flowThread(String(number), "issue");
    const snapshot = resolve(this.root, ".tmp", `issue-read-${number}.sha256`);
    if (!existsSync(snapshot) || readFileSync(snapshot, "utf8") !== bodyHash(String(item.body))) {
      throw new Error(
        "Issue body changed since read (or not read); read issue again before editing"
      );
    }
    // #359: the current, pre-edit approval is what the edit voids; read it before writing.
    // The paired --scope-review flow voids and re-approves in one verb, so it skips the warning.
    const stale = summary === undefined ? await this.staleScopeApproval(number, item) : undefined;
    // Journal the body write as the verb's operation (#199) so a poll between it and
    // a sibling write cannot report the card.
    this.github.writes.beginOperation("issue edit", [{ repo: String(this.config.repo), number }]);
    await this.github.rest(
      `/repos/${String(this.config.repo)}/issues/${number}`,
      "PATCH",
      { body },
      false
    );
    writeFileSync(snapshot, bodyHash(body));
    if (summary !== undefined) {
      return `Updated issue #${number}; ${await this.scopeReviewCore(number, summary)}`;
    }
    return `Updated issue #${number}${stale === undefined ? "" : `\n${stale}`}`;
  };

  /** The edit-time scope warning (#359): an edit voids a body-bound approval or an open
   * task PR's merge-time scope recheck, which merge-task would only refuse at the end. */
  private staleMessage(number: number): string {
    return `scope approval for #${number} is now stale; run scope-review ${number} <summary-file> before merging`;
  }

  private async staleScopeApproval(number: number, item: ObjectData): Promise<string | undefined> {
    if ((await this.scopeState(item))?.approved === true) {
      return this.staleMessage(number);
    }
    return (await this.openTaskPr(number)) ? this.staleMessage(number) : undefined;
  }

  /** One open pull request whose task header or marker lists this issue (#359). */
  private async openTaskPr(number: number): Promise<boolean> {
    for (let page = 1; ; page++) {
      const pulls = await this.github.rest(
        `/repos/${String(this.config.repo)}/pulls?state=open&per_page=100&page=${page}`
      );
      if (!Array.isArray(pulls)) {
        throw new Error("Missing open task PRs");
      }
      if (pulls.map(object).some((pr) => taskIssueNumbers(String(pr.body))?.includes(number))) {
        return true;
      }
      if (pulls.length < 100) {
        return false;
      }
    }
  }

  /** The batched scope read for one issue; open-task and merge-task's approval checks
   * share it, so the edit-time warning and the merge gate see the same evidence. */
  private async scopeState(item: ObjectData) {
    return (
      await new ScopeReader(
        this.github,
        this.filter,
        this.config,
        object(this.config.board).enabled === false
          ? Infinity
          : legacyScopeCutoff((await this.board.snapshot()).readme)
      ).read([String(item.id)])
    ).get(String(item.id));
  }

  /** Publish checked summary with the live digest, then assign scope review to the owner. */
  scopeReview: Handlers["scopeReview"] = async ({ ref, file }) =>
    this.scopeReviewCore(this.localNumber(ref), this.scopeSummary(file));

  /** Read and validate a change summary before any write: the posted comment already
   * opens with `[orchestrator] SCOPE REVIEW`, so the summary must not forge a header. */
  private scopeSummary(file: string): string {
    const summary = readFileSync(file, "utf8");
    if (!summary.trim() || /body sha256:|\[orchestrator\] SCOPE REVIEW/.test(summary)) {
      throw new Error("Provide a nonempty change summary, without a review tag or body hash");
    }
    guardProtocolHeader(summary, "scope-review");
    return summary;
  }

  private async scopeReviewCore(number: number, summary: string): Promise<string> {
    const issue = await this.flowThread(String(number), "issue");
    if (issue.state !== "OPEN" || typeof issue.body !== "string") {
      throw new Error("Scope review requires an open issue with a readable body");
    }
    const snapshot = await this.board.snapshot();
    const card = (await this.board.cards(snapshot.id)).find((card) => card.contentId === issue.id);
    const estimate = card?.values.Estimate;
    assertEstimate(estimate);
    const autopilot = (await this.autopilotFor(issue)).active;
    const body = `[orchestrator] SCOPE REVIEW\n\nI have updated the main body to the final scope.\n\nEstimate: ${estimate}\n\n${summary.trim()}\n\n${autopilot ? "Autopilot: scope approved.\n\nScoping → Spec review under autopilot.\n\n" : ""}body sha256: ${bodyHash(String(issue.body))}`;
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    const assignments = await this.node(
      String(issue.id),
      "assignees(first: 100) { nodes { login } pageInfo { hasNextPage } }",
      "Issue"
    );
    if (
      !this.filter.accept(
        assignments,
        repoOf(assignments).owner,
        `https://github.com/${String(this.config.repo)}`
      ) ||
      object(object(assignments.assignees).pageInfo).hasNextPage !== false
    ) {
      throw new Error("Incomplete scope assignments");
    }
    const current = (object(assignments.assignees).nodes as ObjectData[]).map((item) =>
      String(item.login)
    );
    const next = turnAssignees(
      this.filter.people,
      String(this.config.repo),
      current,
      "owner",
      await ownerForTurn(this.github, this.filter.people, String(this.config.repo), number)
    );
    // One operation for the assignment, summary comment and board handoff writes (#199).
    this.github.writes.beginOperation("scope-review", [{ repo: String(this.config.repo), number }]);
    await setTurn(this.github, String(this.config.repo), number, current, next);
    await this.github.rest(
      `/repos/${String(this.config.repo)}/issues/${number}/comments`,
      "POST",
      { body },
      false
    );
    await this.board.setIssueField(
      String(issue.id),
      "Status",
      "Spec review",
      renderProgress({ state: "owner-review", round: null, red: false })
    );
    if (autopilot && (await this.autopilotFor(issue)).active) {
      await this.github.rest(
        `/repos/${String(this.config.repo)}/issues/${number}/comments`,
        "POST",
        {
          body: "[orchestrator] AUTOPILOT\n\nSpec review → Executing under autopilot, on my scope review.",
        },
        false
      );
      await setTurn(
        this.github,
        String(this.config.repo),
        number,
        next,
        turnAssignees(this.filter.people, String(this.config.repo), next, null)
      );
      await this.board.setIssueField(String(issue.id), "Status", "Executing");
      return `Scope approved under autopilot for #${number}`;
    }
    return `Scope review requested for #${number}`;
  }

  issueClose: Handlers["issueClose"] = async ({ ref, comment }) => {
    const number = this.localNumber(ref);
    const body = comment === undefined ? undefined : readFileSync(comment, "utf8");
    if (body !== undefined) {
      await checkMarkdown(this.root, body);
      guardClosingKeywords(body);
    }
    await this.flowThread(ref, "issue");
    const path = `/repos/${String(this.config.repo)}/issues/${number}`;
    if (body !== undefined) {
      await this.github.rest(`${path}/comments`, "POST", { body }, false);
    }
    const closed = object(
      await this.github.rest(path, "PATCH", {
        state: "closed",
        state_reason: "completed",
        assignees: [],
      })
    );
    if (closed.state !== "closed") {
      throw new Error("Issue closure not confirmed");
    }
    if (typeof closed.node_id !== "string") {
      throw new Error("Closed issue response lacks node id");
    }
    await this.board.setIssueField(closed.node_id, "Status", "Done");
    await this.board.setIssueField(closed.node_id, "Progress", null);
    return `Closed issue #${number}`;
  };

  /** Attach a configured-repository sub-issue to a configured-repository epic through
   * GitHub's addSubIssue (#327): a parent outside the configured repository is refused
   * before any write, an issue already attached to that epic is a read-only no-op, and
   * an issue parented elsewhere is refused, naming its current parent, before the write. */
  issueParent: Handlers["issueParent"] = async ({ ref, epic }) => {
    const number = this.localNumber(ref);
    const epicRef = this.subIssueParentRef(epic);
    const child = await this.flowThread(String(number), "issue");
    return this.relateSubIssue({ number, id: String(child.id) }, epicRef, "add");
  };

  /** Detach a configured-repository sub-issue from a configured-repository epic through
   * GitHub's removeSubIssue (#327): an issue not attached to that epic is a read-only
   * no-op, naming the current parent when there is one. */
  issueUnparent: Handlers["issueUnparent"] = async ({ ref, epic }) => {
    const number = this.localNumber(ref);
    const epicRef = this.subIssueParentRef(epic);
    const child = await this.flowThread(String(number), "issue");
    return this.relateSubIssue({ number, id: String(child.id) }, epicRef, "remove");
  };

  /** Set a blocked-by relation; the target is in the configured repository, the blocker may be elsewhere. */
  issueBlock: Handlers["issueBlock"] = async ({ ref, blocker }) => {
    const number = this.localNumber(ref);
    const target = await this.flowThread(String(number), "issue");
    const blockerRef = blockerReference(blocker, this.config);
    await this.github.graphql(
      `mutation($issueId: ID!, $blockingIssueId: ID!) { addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { number } blockingIssue { number } } }`,
      { issueId: String(target.id), blockingIssueId: await this.issueNodeId(blockerRef) }
    );
    return `Blocked #${number} by ${blockerLabel(blockerRef, this.config)}`;
  };

  /** Clear a blocked-by relation set through issueBlock. */
  issueUnblock: Handlers["issueUnblock"] = async ({ ref, blocker }) => {
    const number = this.localNumber(ref);
    const target = await this.flowThread(String(number), "issue");
    const blockerRef = blockerReference(blocker, this.config);
    await this.github.graphql(
      `mutation($issueId: ID!, $blockingIssueId: ID!) { removeBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { number } blockingIssue { number } } }`,
      { issueId: String(target.id), blockingIssueId: await this.issueNodeId(blockerRef) }
    );
    return `Unblocked #${number} from ${blockerLabel(blockerRef, this.config)}`;
  };

  /** Write an existing issue card's Estimate; the shared scale gate precedes any write. */
  issueEstimate: Handlers["issueEstimate"] = async ({ ref, points }) => {
    assertEstimate(points);
    this.localNumber(ref);
    const issue = await this.flowThread(ref, "issue");
    return this.board.setIssueField(String(issue.id), "Estimate", String(points));
  };

  private async issueNodeId(ref: ThreadRef, missing = "Blocker issue"): Promise<string> {
    const result = object(
      await this.github.graphql(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }`,
        { owner: ref.owner, name: ref.name, number: ref.number }
      )
    );
    const issue = object(object(result.repository).issue);
    if (!issue.id) {
      throw new Error(`${missing} not found: ${blockerLabel(ref, this.config)}`);
    }
    return String(issue.id);
  }

  /** The sub-issue parent argument: blockers-like `#m`/`m` spellings, but strictly within
   * the configured repository — GitHub's own hierarchies may span same-org repositories,
   * so a raw pre-existing parent can also read `repo#n` in the messages below (#327). */
  private subIssueParentRef(epic: string): ThreadRef {
    const ref = parentReference(epic, this.config);
    if (ref.repo.toLowerCase() !== String(this.config.repo).toLowerCase()) {
      throw new Error(
        `Sub-issue parent must be in the configured repository, not ${ref.repo}#${ref.number}`
      );
    }
    return ref;
  }

  /** The sub-issue's current parent relation: structural node fields only (id, number,
   * repository), never the parent's content — this read never delivers a thread (#327). */
  private async subIssueParent(childNumber: number): Promise<ObjectData | null> {
    const [owner, name] = String(this.config.repo).split("/");
    const result = object(
      await this.github.graphql(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { parent { id number repository { nameWithOwner } } } } }`,
        { owner, name, number: childNumber }
      )
    );
    const issue = object(object(result.repository).issue);
    if (!Object.hasOwn(issue, "parent")) {
      throw new Error("Missing sub-issue parent read");
    }
    if (issue.parent === null) {
      return null;
    }
    const parent = object(issue.parent);
    if (typeof parent.id !== "string" || !parent.id) {
      throw new Error("Incomplete sub-issue parent read");
    }
    this.parentLabel(parent);
    return parent;
  }

  /** `#n` for a parent in the configured repository, otherwise `repo#n` (parents attached
   * through raw GitHub calls can live outside the configured repository). */
  private parentLabel(parent: ObjectData): string {
    const repo = String(object(parent.repository).nameWithOwner ?? "");
    const number = Number(parent.number);
    if (!repo || !Number.isSafeInteger(number) || number < 1) {
      throw new Error("Incomplete sub-issue parent read");
    }
    return repo.toLowerCase() === String(this.config.repo).toLowerCase()
      ? `#${number}`
      : `${repo}#${number}`;
  }

  /** One sub-issue relation move shared by `issue parent`/`issue unparent` and
   * `issue create --parent` (#327): the child arrives already authenticated (an
   * accept-filtered thread for the verbs, the fresh creation response for the flag).
   * The parent is refused outside the configured repository, already-attached adds are
   * a read-only no-op, and a child parented elsewhere is refused before any write. */
  private async relateSubIssue(
    child: { number: number; id: string },
    epicRef: ThreadRef,
    action: "add" | "remove"
  ): Promise<string> {
    const epicLabel = blockerLabel(epicRef, this.config);
    if (!Number.isSafeInteger(child.number) || child.number < 1 || !child.id) {
      throw new Error("Missing sub-issue identity for the parent relation");
    }
    const parent = await this.subIssueParent(child.number);
    const attached = parent !== null && this.parentMatchesEpic(parent, epicRef);
    if (attached) {
      if (action === "remove") {
        await this.writeSubIssueRelation(
          "remove",
          await this.issueNodeId(epicRef, "Epic issue"),
          child.id
        );
        return `Removed sub-issue #${child.number} from epic ${epicLabel}`;
      }
      return `Issue #${child.number} is already a sub-issue of epic ${epicLabel}; nothing attached`;
    }
    if (parent !== null) {
      if (action === "add") {
        throw new Error(
          `Issue #${child.number} is already a sub-issue of ${this.parentLabel(parent)}; detach it before re-attaching`
        );
      }
      throw new Error(
        `Issue #${child.number} is not a sub-issue of epic ${epicLabel}; it is a sub-issue of ${this.parentLabel(parent)}`
      );
    }
    if (action === "remove") {
      return `Issue #${child.number} is not a sub-issue of epic ${epicLabel}; nothing removed`;
    }
    await this.writeSubIssueRelation(
      "add",
      await this.issueNodeId(epicRef, "Epic issue"),
      child.id
    );
    return `Added sub-issue #${child.number} to epic ${epicLabel}`;
  }

  private parentMatchesEpic(parent: ObjectData, epicRef: ThreadRef): boolean {
    const repo = String(object(parent.repository).nameWithOwner ?? "");
    return (
      repo.toLowerCase() === String(this.config.repo).toLowerCase() &&
      Number(parent.number) === epicRef.number
    );
  }

  /** GitHub's sub-issue relation mutation: `issueId` is the parent/epic node, `subIssueId` the child's. */
  private async writeSubIssueRelation(
    action: "add" | "remove",
    issueId: string,
    subIssueId: string
  ): Promise<void> {
    const mutation = action === "add" ? "addSubIssue" : "removeSubIssue";
    await this.github.graphql(
      `mutation($issueId: ID!, $subIssueId: ID!) { ${mutation}(input: { issueId: $issueId, subIssueId: $subIssueId }) { issue { number } subIssue { number } } }`,
      { issueId, subIssueId }
    );
  }
  boardArchive: Handlers["boardArchive"] = async ({ itemId }) => this.board.archive(itemId);

  private get flow(): TaskFlow {
    const scopeReasons = new Map<string, string>();
    const deps: Dependencies = {
      ...this.deps,
      workers: this.deps.workers ?? {
        status: (pr, forMerge) => this.workers.mergeStatus(pr, forMerge),
        recorded: (pr) => this.workers.recorded(pr),
        stop: async (pr) => {
          await this.workers.command(["stop", String(pr)]);
        },
        close: (pr) => this.workers.closeSession(pr),
        captureUsage: (pr) => this.workers.captureUsage(pr),
        resume: (pr, prompt) => this.workers.resume(pr, prompt),
        clearWake: (pr) => this.workers.clearWake(pr),
      },
    };
    return new TaskFlow(this.root, this.env, this.config, deps, {
      github: this.github,
      board: () => this.board,
      people: loadYaml(this.root, "people") as Person[],
      autopilot: async (ref, kind) => this.autopilotFor(await this.flowThread(ref, kind)),
      copyAutopilot: async (issue, pr) => {
        if (
          (object(issue.labels).nodes as ObjectData[]).some((label) => label.name === "autopilot")
        ) {
          await inheritAutopilot(this.github, this.filter, this.config, issue, pr);
        }
      },
      autopilotApproved: (ref, head) => this.autopilotApprovalFor(ref, head),
      thread: (ref, kind) => this.flowThread(ref, kind),
      conflictPending: async (ref) => this.conflicts.pending(Number(ref)),
      comments: (id, kind) => this.flowComments(id, kind === "issue" ? "Issue" : "PullRequest"),
      replyTarget: (id) => this.flowComment(id),
      approved: (ref, historical) => this.approvalFor(ref, historical),
      approvalRefusal: async (ref) => {
        let reason = `Owner approval is missing or cannot be verified for current head; hand over with review ${ref} owner`;
        await this.approvalFor(ref, undefined, (text) => {
          reason = text;
        });
        return reason;
      },
      scopeRefusal: async (item) =>
        scopeReasons.get(String(item.id)) ??
        `scope not approved: run scope-review ${String(item.number)} <file>`,
      candidates: async (ref) => {
        const { item, person } = await this.thread(ref, "pr");
        if (!person) {
          return [];
        }
        const candidates = new Set<string>();
        for (const review of await this.collection(String(item.id), "PullRequest", "reviews")) {
          if (
            this.filter.identity(review.author)?.role === "owner" &&
            (review.lastEditedAt == null ||
              this.filter.identity(review.editor)?.role === "owner") &&
            review.state === "APPROVED"
          ) {
            const head = object(review.commit).oid;
            if (typeof head === "string" && /^[a-f\d]{40}$/i.test(head)) {
              candidates.add(head);
            }
          }
        }
        for (const comment of await this.flowComments(String(item.id))) {
          const delegated =
            /^\[orchestrator\] AUTOPILOT APPROVED\n\nCurrent head: ([a-f\d]{40})\n/i.exec(
              String(comment.body)
            );
          if (delegated) {
            candidates.add(delegated[1]);
          }
          if (/^\[orchestrator\] OWNER REVIEW(?:\s|$)/.test(String(comment.body))) {
            for (const head of String(comment.body).match(/\b[a-f\d]{40}\b/gi) ?? []) {
              candidates.add(head);
            }
          }
        }
        return [...candidates];
      },
      issueApproved: async (item) => {
        const state = await this.scopeState(item);
        if (state?.refusal) {
          scopeReasons.set(String(item.id), state.refusal);
        }
        return state?.approved === true;
      },
      modelApproval: (issue, family) => this.modelApproval(family, { issue }),
      // #339: open-task's advisory lines reuse suggest-model's recommendation and the
      // per-family learnings aggregate; informational only, never a refusal source.
      modelSuggestion: async (issue) => {
        const { model, reason } = await this.workers.recommend(issue);
        return { family: model.family, tier: model.tier, reason };
      },
      learningEvidence: (family) => this.learningService().familyEvidence(family),
      ownerAgreement: async (ref, url, since, handback, kind = "pr") => {
        const match =
          /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/([1-9]\d*)#issuecomment-([1-9]\d*)$/.exec(
            url
          );
        if (!match || match[1] !== String(this.config.repo) || match[2] !== ref) {
          return false;
        }
        const item = await this.flowThread(ref, kind);
        const comments = await this.ownerModelComments(
          String(item.id),
          kind === "issue" ? "Issue" : "PullRequest",
          url
        );
        return comments.some((comment) =>
          ownerAgreement(comment, this.filter, String(this.config.repo), ref, url, since, handback)
        );
      },
    });
  }
  /** Gate reads are fresh; watcher state and label presence are not credentials. */
  /** Historical exact-head review evidence never replaces a current delegation. */
  private async autopilotApprovalFor(ref: string, head: string): Promise<boolean> {
    const pr = await this.flowThread(ref, "pr");
    const state = await this.autopilotFor(pr);
    const reviews = (await this.flowComments(String(pr.id))).filter((comment) =>
      String(comment.body).startsWith(
        `[orchestrator] AUTOPILOT APPROVED\n\nCurrent head: ${head}\n`
      )
    );
    if (reviews.length && !state.active) {
      throw new Error("autopilot delegation is no longer current; ask the owner");
    }
    return (
      state.active &&
      reviews.some((comment) =>
        state.at(Date.parse(String(comment.lastEditedAt ?? comment.createdAt)))
      )
    );
  }

  private async autopilotFor(item: ObjectData): Promise<AutopilotState> {
    const items = [item];
    if (item.__typename === "PullRequest") {
      for (const issue of taskIssueNumbers(String(item.body)) ?? []) {
        items.push(await this.flowThread(String(issue), "issue"));
      }
    }
    if (
      !items.some(
        (value) =>
          Array.isArray(object(value.labels).nodes) &&
          (object(value.labels).nodes as ObjectData[]).some((label) => label.name === "autopilot")
      )
    ) {
      return { active: false, at: () => false, unauthorized: false };
    }
    return (
      (
        await new AutopilotReader(this.github, this.filter, this.config).read(
          items.map((value) => String(value.id))
        )
      ).get(String(item.id)) ?? { active: false, at: () => false, unauthorized: false }
    );
  }

  /** Stop delegation on an accepted local thread; watcher reconciles its task turn. */
  autopilotStop: Handlers["autopilotStop"] = async ({ ref, kind }) => {
    if (kind !== "issue" && kind !== "pr") {
      throw new Error("Expected issue or pr");
    }
    const number = this.localNumber(ref);
    const item = await this.flowThread(String(number), kind);
    if ((object(item.labels).nodes as ObjectData[]).some((label) => label.name === "autopilot")) {
      await this.github.rest(
        `/repos/${String(this.config.repo)}/issues/${number}/labels/autopilot`,
        "DELETE"
      );
      await this.github.rest(
        `/repos/${String(this.config.repo)}/issues/${number}/comments`,
        "POST",
        {
          body: "[orchestrator] AUTOPILOT\n\nStopped autopilot; control returns to the owner at the current step. Completed work is not reverted.",
        },
        false
      );
    }
    return `Autopilot stopped on #${number}`;
  };

  /** Re-run open-task's authenticated grant copy on an accepted task PR (#249): a
   * watcher cleanup or a failed first inheritance is repaired by a live issue grant. */
  autopilotInherit: Handlers["autopilotInherit"] = async ({ ref }) => {
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
          "[orchestrator] AUTOPILOT\n\nCopied the task issue's owner-authorized autopilot grant onto this PR."
        )
      ) {
        return `Autopilot grant copied from #${issue} to #${number}`;
      }
    }
    throw new Error(`No live autopilot grant on the task's linked issues: ${issues.join(", ")}`);
  };

  openTask: Handlers["openTask"] = async (input) => this.flow.open(input);
  prOpen: Handlers["prOpen"] = async (input) => this.flow.openPr(input);
  prMerge: Handlers["prMerge"] = async (input) => this.flow.mergePr(input.ref);
  reviewTask: Handlers["reviewTask"] = async (input) => this.flow.review(input);
  askIssue: Handlers["askIssue"] = async (input) => this.flow.ask(input.ref, input.file);
  mergeTask: Handlers["mergeTask"] = async (input) =>
    this.flow.merge(input.ref, input.mergeCommit, input.carryApproval);
  closeTask: Handlers["closeTask"] = async (input) => this.flow.close(input.ref, input.comment);
  linkTask: Handlers["linkTask"] = async (input) =>
    this.flow.link(input.ref, input.complete, input.unlink);
  releaseHold: Handlers["releaseHold"] = async (input) => this.flow.release(input.ref);
  workerStatus: Handlers["workerStatus"] = async (input) => {
    await this.flowThread(input.ref, "pr");
    return this.flow.status(input.ref);
  };

  private async flowThread(ref: string, kind: "pr" | "issue"): Promise<ObjectData> {
    const { item, person, link } = await this.thread(ref, kind);
    if (!person) {
      throw new Error("No accepted task thread");
    }
    const data = await this.node(
      String(item.id),
      `__typename number title body state labels(first: 100) { nodes { name } pageInfo { hasNextPage } } ${kind === "pr" ? "headRefOid headRefName baseRefName baseRefOid isDraft mergeable headRepository { nameWithOwner } closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } }" : ""}`,
      kind === "pr" ? "PullRequest" : "Issue"
    );
    if (!this.filter.accept(data, repoOf(data).owner, link)) {
      throw new Error("Task identity changed");
    }
    if (object(object(data.labels).pageInfo).hasNextPage !== false) {
      throw new Error("Too many task labels");
    }
    return data;
  }
  private async flowComments(
    id: string,
    type: "Issue" | "PullRequest" = "PullRequest"
  ): Promise<ObjectData[]> {
    const output: ObjectData[] = [];
    for (const meta of await this.collection(id, type, "comments")) {
      const author = this.filter.identity(meta.author);
      if (!author || this.filter.roleIn(author, String(this.config.repo)) !== "orchestrator") {
        continue;
      }
      const comment = await this.node(String(meta.id), "body createdAt url", "IssueComment");
      const effective = this.filter.accept(
        comment,
        repoOf(comment).owner,
        `https://github.com/${String(this.config.repo)}`
      );
      if (
        this.filter.identity(comment.author)?.role === "orchestrator" &&
        effective &&
        this.filter.roleIn(effective, String(this.config.repo)) === "orchestrator"
      ) {
        output.push(comment);
      }
    }
    return output;
  }

  /** One thread's verified-owner comments: bodies are read only after the effective
   * author (author, or an edited comment's editor) identifies as the pinned owner,
   * so foreign approval text never leaves the people filter. */
  private async ownerModelComments(
    id: string,
    type: "Issue" | "PullRequest",
    link: string
  ): Promise<ObjectData[]> {
    const output: ObjectData[] = [];
    for (const meta of await this.collection(id, type, "comments")) {
      if (this.filter.accept(meta, repoOf(meta).owner, link)?.role !== "owner") {
        continue;
      }
      const comment = await this.node(
        String(meta.id),
        "body createdAt url issue { number } pullRequest { number }",
        "IssueComment"
      );
      if (this.filter.accept(comment, repoOf(comment).owner, link)?.role === "owner") {
        output.push(comment);
      }
    }
    return output;
  }

  /** The verifiable owner gate (#218): a `gate: owner` family honorably launches or
   * switches only when the task issue or task PR carries the owner's
   * `APPROVE MODEL <family>` comment, posted after the issue body's last edit and
   * verified by identity, not display name. #242 adds the card path: the owner's own
   * Model value on the issue's or task PR's board card counts through the value's
   * recorded creator, while a value written by anyone else never counts. */
  private async modelApproval(
    family: string,
    task: { pr?: number; issue?: number }
  ): Promise<boolean> {
    let since: number | undefined;
    if (task.issue !== undefined) {
      const { item, link, person } = await this.thread(String(task.issue), "issue");
      if (!person) {
        throw new Error("No accepted task issue");
      }
      // Re-read edit times so the bound is the issue's current body state
      // (identityFields already carries lastEditedAt).
      const current = await this.node(String(item.id), "createdAt", "Issue");
      if (!this.filter.accept(current, repoOf(current).owner, link)) {
        throw new Error("Task issue identity changed during read");
      }
      // An unedited body has no lastEditedAt; its creation is the last body edit.
      const edit = String(current.lastEditedAt ?? current.createdAt ?? "");
      since = Date.parse(edit);
      if (!Number.isFinite(since)) {
        throw new Error("Model gate cannot establish the issue body's last edit");
      }
      if (
        isModelApproved(
          await this.ownerModelComments(String(item.id), "Issue", link),
          family,
          since
        )
      ) {
        return true;
      }
      // The comment path failed: the owner may have approved by setting the card.
      if (await this.ownerCardModel(item, "Issue", family, link)) {
        return true;
      }
    }
    if (task.pr !== undefined) {
      const { item, link, person } = await this.thread(String(task.pr), "pr");
      if (!person) {
        throw new Error("No accepted task thread");
      }
      if (
        isModelApproved(
          await this.ownerModelComments(String(item.id), "PullRequest", link),
          family,
          since
        )
      ) {
        return true;
      }
      if (await this.ownerCardModel(item, "PullRequest", family, link)) {
        return true;
      }
    }
    return false;
  }

  /** The card path of the owner gate (#242): the task card's Model value on the
   * configured board counts as an approval when the value's recorded `creator` —
   * GitHub tracks who set each project field value — is the pinned owner, and the
   * single-select name or text is the family. A Model value written by anyone else,
   * including `open-task` writing the task PR card's Model, never counts. */
  private async ownerCardModel(
    item: ObjectData,
    type: "Issue" | "PullRequest",
    family: string,
    link: string
  ): Promise<boolean> {
    const fields = `projectItems(first: 100) { nodes { id isArchived project { number owner { ... on Organization { login } ... on User { login } } } fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name creator { ${actorFields} } field { ... on ProjectV2SingleSelectField { name } } } ... on ProjectV2ItemFieldTextValue { text creator { ${actorFields} } field { ... on ProjectV2Field { name } } } } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }`;
    const data = await this.node(String(item.id), fields, type);
    if (!this.filter.accept(data, repoOf(data).owner, link)) {
      throw new Error("Task identity changed during read");
    }
    if (object(object(data.projectItems).pageInfo).hasNextPage === true) {
      throw new Error("Too many project memberships; refusing incomplete metadata");
    }
    const card = object(this.projectCard(data).fieldValues);
    if (object(card.pageInfo).hasNextPage === true) {
      throw new Error("Incomplete project field values");
    }
    const values = card.nodes;
    if (!Array.isArray(values)) {
      return false;
    }
    const model = object(values.find((v) => object(object(v).field).name === "Model"));
    if (String(model.name ?? model.text ?? "").trim() !== family) {
      return false;
    }
    const person = this.filter.identity(model.creator);
    return person !== undefined && this.filter.roleIn(person, String(this.config.repo)) === "owner";
  }

  /**
   * The comment with this REST id: its verified pinned author (an editor replaces the
   * author, as PeopleFilter.accept decides for delivery), its issue number and the
   * body's first line. Only ever the protocol tag of a write verb's target leaves
   * this process, so unknown authors return undefined without a digest drop.
   */
  private async flowComment(
    id: string
  ): Promise<{ author: Person; issue: number; firstLine: string } | undefined> {
    let comment: ObjectData;
    try {
      comment = object(
        await this.github.rest(`/repos/${String(this.config.repo)}/issues/comments/${id}`)
      );
    } catch (error) {
      // An unknown REST id (including review-thread hashes) is no protocol target.
      if (error instanceof GitHubHttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
    if (typeof comment.node_id !== "string" || !comment.node_id) {
      throw new Error("Comment has no node id");
    }
    const node = await this.node(comment.node_id, "body issue { number }", "IssueComment");
    let author = this.filter.identity(node.author);
    if (node.lastEditedAt != null) {
      // An edited comment counts as the editor's input, never the original author's.
      author = this.filter.identity(node.editor);
    }
    const issue = object(node.issue).number;
    if (
      !author ||
      repoOf(node).repo !== String(this.config.repo) ||
      !Number.isSafeInteger(issue) ||
      Number(issue) < 1
    ) {
      return undefined;
    }
    return {
      author: { ...author, role: this.filter.roleIn(author, String(this.config.repo)) },
      issue: Number(issue),
      firstLine: typeof node.body === "string" ? node.body.split(/\r?\n/)[0] : "",
    };
  }
  constructor(
    private root: string,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies
  ) {
    this.config = getConfig(root, env);
    this.watchStateConfig = this.config;
    this.peopleMtime = this.watchMtime("people");
    this.configMtime = this.watchMtime("vmethod");
    this.digest = new Digest(
      env,
      String(this.config.stateName ?? String(this.config.repo).replace("/", "-")),
      deps.now
    );
    this.filter = new PeopleFilter(
      loadYaml(root, "people") as Person[],
      String(this.config.org),
      this.digest
    );
  }

  private get github(): GitHubClient {
    return (this.client ??= new GitHubClient(this.config, this.env, this.deps));
  }

  private async node(id: string, fields: string, type: string): Promise<ObjectData> {
    const result = object(
      await this.github.graphql(
        `query($id: ID!) { node(id: $id) { ... on ${type} { ${identityFields} ${fields} } } }`,
        { id }
      )
    );
    return object(result.node);
  }

  private async thread(
    ref: string,
    kind: "pr" | "issue" | "any"
  ): Promise<{ item: ObjectData; link: string; person?: Person }> {
    const target = reference(ref, this.config);
    const field = kind === "pr" ? "pullRequest" : kind === "issue" ? "issue" : "issueOrPullRequest";
    const fields =
      kind === "any"
        ? `__typename ... on Issue { ${identityFields} } ... on PullRequest { ${identityFields} }`
        : `${identityFields} ${
            kind === "pr"
              ? "headRefOid headRefName baseRefName state mergeable headRepository { nameWithOwner }"
              : ""
          }`;
    const result = object(
      await this.github.graphql(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { ${field}(number: $number) { ${fields} } } }`,
        { owner: target.owner, name: target.name, number: target.number }
      )
    );
    const item = object(object(result.repository)[field]);
    if (!item.id) {
      throw new Error("GitHub thread not found");
    }
    const person = this.filter.accept(item, repoOf(item).owner, target.link);
    return { item, link: target.link, person };
  }

  private async collection(
    id: string,
    type: string,
    field: "comments" | "reviews"
  ): Promise<ObjectData[]> {
    const nodes: ObjectData[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const result = object(
        await this.github.graphql(
          `query($id: ID!, $cursor: String) { node(id: $id) { ... on ${type} { ${identityFields} ${field}(first: 100, after: $cursor) { nodes { ${identityFields} ${field === "reviews" ? "submittedAt state commit { oid }" : ""} } pageInfo { hasNextPage endCursor } } } } }`,
          { id, cursor }
        )
      );
      const parent = object(result.node);
      const scope = repoOf(parent);
      const link = `https://github.com/${scope.repo || String(this.config.repo)}`;
      if (!this.filter.accept(parent, scope.owner, link)) {
        return [];
      }
      const connection = object(parent[field]);
      if (!Array.isArray(connection.nodes)) {
        throw new Error("Missing GitHub connection nodes");
      }
      for (const node of connection.nodes) {
        nodes.push(object(node));
      }
      const page = object(connection.pageInfo);
      if (page.hasNextPage === false) {
        return nodes;
      }
      if (
        page.hasNextPage !== true ||
        typeof page.endCursor !== "string" ||
        seen.has(page.endCursor)
      ) {
        throw new Error("Invalid GitHub pagination cursor");
      }
      cursor = page.endCursor;
      seen.add(cursor);
    }
  }

  /** The pull request's review comments, one listing per resolved review thread; item
   * identity is filtered per comment exactly like the conversation comments. */
  private async reviewThreadComments(prId: string): Promise<ObjectData[]> {
    const comments: ObjectData[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const result = object(
        await this.github.graphql(
          `query($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequest { reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { comments(first: 100) { nodes { ${identityFields} } pageInfo { hasNextPage endCursor } } } } } } }`,
          { id: prId, cursor }
        )
      );
      const connection = object(object(result.node).reviewThreads);
      const page = object(connection.pageInfo);
      if (!Array.isArray(connection.nodes)) {
        throw new Error("Missing GitHub connection nodes");
      }
      for (const value of connection.nodes) {
        const thread = object(object(value).comments);
        const info = object(thread.pageInfo);
        if (!Array.isArray(thread.nodes) || typeof info.hasNextPage !== "boolean") {
          throw new Error("Invalid review-thread comments");
        }
        if (info.hasNextPage) {
          throw new Error("Review-thread comments exceeded one page");
        }
        comments.push(...thread.nodes.map(object));
      }
      if (page.hasNextPage === false) {
        return comments;
      }
      if (
        page.hasNextPage !== true ||
        typeof page.endCursor !== "string" ||
        seen.has(page.endCursor)
      ) {
        throw new Error("Invalid GitHub pagination cursor");
      }
      cursor = page.endCursor;
      seen.add(cursor);
    }
  }

  /** One thread item's body read: verified identity, REST id, time and fenced body. */
  private async threadEntry(
    kind: "comment" | "review" | "review comment",
    meta: ObjectData,
    link: string,
    fields: string,
    type: string
  ): Promise<ThreadItem | undefined> {
    const read = await this.node(String(meta.id), fields, type);
    const person = this.filter.accept(read, repoOf(read).owner, link);
    if (!person) {
      // A race between listing and body read is today's filtered delivery: skipped.
      return undefined;
    }
    return {
      kind,
      id: threadId(read.databaseId, kind),
      time: threadTime(read.submittedAt, read.createdAt),
      login: person.login,
      role: person.role,
      content: threadContent(read),
    };
  }

  /** The whole PR thread as one item per section: the PR (title, state, draft, head
   * and body), then each comment, review and review comment. Every step filters
   * identities exactly like the labelled reads; a dropped author's read is skipped. */
  private async prThread(
    item: ObjectData,
    link: string,
    target: ThreadRef
  ): Promise<ThreadItem[] | undefined> {
    const content = await this.node(
      String(item.id),
      "title body isDraft state headRefOid createdAt",
      "PullRequest"
    );
    const author = this.filter.accept(content, repoOf(content).owner, link);
    if (!author) {
      // Today's read: the re-filtered PR body returning nothing means no thread.
      return undefined;
    }
    if (
      typeof content.isDraft !== "boolean" ||
      typeof content.state !== "string" ||
      typeof content.headRefOid !== "string"
    ) {
      throw new Error("Missing PR thread metadata");
    }
    const items: ThreadItem[] = [];
    const seen = new Set<string>();
    const add = (entry: ThreadItem): void => {
      const key = itemKey(entry);
      if (seen.has(key)) {
        throw new Error(`Duplicate thread item ${key}`);
      }
      seen.add(key);
      items.push(entry);
    };
    add({
      kind: "pr",
      id: String(target.number),
      time: threadTime(content.createdAt),
      login: author.login,
      role: author.role,
      // The state line hashes separately from the body: a push re-reports the
      // head without re-delivering the title and the task body (issue #284).
      metaLine: `state ${content.state}, draft ${content.isDraft}, head ${content.headRefOid}`,
      content: threadContent(content),
    });
    for (const meta of await this.collection(String(item.id), "PullRequest", "comments")) {
      if (!this.filter.accept(meta, repoOf(meta).owner, link)) {
        continue;
      }
      const entry = await this.threadEntry(
        "comment",
        meta,
        link,
        "body databaseId createdAt",
        "IssueComment"
      );
      if (entry) {
        add(entry);
      }
    }
    for (const review of await this.collection(String(item.id), "PullRequest", "reviews")) {
      if (!this.filter.accept(review, repoOf(review).owner, link)) {
        continue;
      }
      const entry = await this.threadEntry(
        "review",
        review,
        link,
        "body databaseId createdAt submittedAt",
        "PullRequestReview"
      );
      if (entry) {
        add(entry);
      }
    }
    for (const comment of await this.reviewThreadComments(String(item.id))) {
      if (!this.filter.accept(comment, repoOf(comment).owner, link)) {
        continue;
      }
      const entry = await this.threadEntry(
        "review comment",
        comment,
        link,
        "body databaseId createdAt",
        "PullRequestReviewComment"
      );
      if (entry) {
        add(entry);
      }
    }
    return items;
  }

  /** The whole issue thread as one item per section: the issue (title, state and
   * body), then each comment. Every step filters identities exactly like the
   * labelled reads; a dropped author's read is skipped. */
  private async issueThread(
    item: ObjectData,
    link: string,
    target: ThreadRef
  ): Promise<ThreadItem[] | undefined> {
    const content = await this.node(String(item.id), "title body state createdAt", "Issue");
    const author = this.filter.accept(content, repoOf(content).owner, link);
    if (!author) {
      // Today's read: the re-filtered issue body returning nothing means no thread.
      return undefined;
    }
    if (typeof content.state !== "string") {
      throw new Error("Missing issue state");
    }
    // The exact body this read delivered, hashed for `issue edit`'s stale-read guard.
    if (target.repo === String(this.config.repo)) {
      mkdirSync(resolve(this.root, ".tmp"), { recursive: true });
      writeFileSync(
        resolve(this.root, ".tmp", `issue-read-${target.number}.sha256`),
        bodyHash(String(content.body))
      );
    }
    const items: ThreadItem[] = [];
    const seen = new Set<string>();
    const add = (entry: ThreadItem): void => {
      const key = itemKey(entry);
      if (seen.has(key)) {
        throw new Error(`Duplicate thread item ${key}`);
      }
      seen.add(key);
      items.push(entry);
    };
    add({
      kind: "issue",
      id: String(target.number),
      time: threadTime(content.createdAt),
      login: author.login,
      role: author.role,
      // The state line hashes separately from the body: a close or reopen
      // re-reports only it, never the untouched title and body (#292).
      metaLine: `state ${content.state}`,
      content: threadContent(content),
    });
    for (const meta of await this.collection(String(item.id), "Issue", "comments")) {
      if (!this.filter.accept(meta, repoOf(meta).owner, link)) {
        continue;
      }
      const entry = await this.threadEntry(
        "comment",
        meta,
        link,
        "body databaseId createdAt",
        "IssueComment"
      );
      if (entry) {
        add(entry);
      }
    }
    return items;
  }

  /** Print the per-item thread; `--new` diffs against the checkout-local snapshot. */
  private async threadReport(
    kind: "pr" | "issue",
    ref: string,
    item: ObjectData,
    link: string,
    option: ReadInput["option"]
  ): Promise<string> {
    const target = reference(ref, this.config);
    const items =
      kind === "pr"
        ? await this.prThread(item, link, target)
        : await this.issueThread(item, link, target);
    if (!items) {
      return "No accepted thread";
    }
    const base = snapshotBase(target, String(this.config.repo));
    if (option !== "--new") {
      saveThreadSnapshot(this.root, base, items);
      return items.map(threadSection).join("\n\n");
    }
    const snapshot = readThreadSnapshot(this.root, base);
    if (snapshot.state === "ok") {
      const delta = threadDiff(items, snapshot.records);
      if (delta.nothing) {
        return `#${target.number}: nothing new since your last read (${delta.unchanged} unchanged)`;
      }
      saveThreadSnapshot(this.root, base, delta.next);
      return [...delta.sections, `${delta.unchanged} unchanged`].join("\n\n");
    }
    saveThreadSnapshot(this.root, base, items);
    const prefix =
      snapshot.state === "missing"
        ? `#${target.number}: no earlier read; full thread follows`
        : `#${target.number}: snapshot unreadable (${snapshot.reason}); full thread follows`;
    return [prefix, ...items.map(threadSection)].join("\n\n");
  }

  private async checks(item: ObjectData, link: string): Promise<string> {
    const scope = repoOf(item);
    const sha = String(item.headRefOid);
    if (!/^[a-f\d]{40}$/i.test(sha)) {
      throw new Error("Invalid PR head SHA");
    }
    const output: string[] = [];
    for (let page = 1; ; page++) {
      const result = object(
        await this.github.rest(
          `/repos/${scope.repo}/commits/${sha}/check-runs?per_page=100&page=${page}`
        )
      );
      if (!Array.isArray(result.check_runs)) {
        throw new Error("Missing check runs");
      }
      for (const value of result.check_runs) {
        const run = object(value);
        const person = this.filter.check(run, scope.owner, link);
        if (!person) {
          continue;
        }
        output.push(labelled(person, JSON.stringify(checkFacts({ ...run, head_sha: sha }))));
      }
      if (result.check_runs.length < 100) {
        break;
      }
    }
    return output.join("\n\n") || "No accepted check runs";
  }

  read: Handlers["read"] = async ({ kind, ref, option }) => {
    if (
      !["pr", "issue", "comment", "checks", "registry"].includes(kind) ||
      (option !== undefined &&
        (kind === "issue"
          ? option !== "--new"
          : kind !== "pr" ||
            !["--files", "--diff", "--reviews", "--checks", "--new"].includes(option)))
    ) {
      throw new Error("Unsupported read kind or option");
    }
    if (kind === "registry") {
      if (option || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(ref) || [".", ".."].includes(ref)) {
        throw new Error("Invalid npm package name");
      }
      const response = await this.deps.fetch(
        `https://registry.npmjs.org/${encodeURIComponent(ref)}`,
        { redirect: "error", signal: AbortSignal.timeout(30000) }
      );
      if (!response.ok) {
        throw new Error(`Registry HTTP ${response.status}`);
      }
      return untrusted(JSON.stringify(await response.json(), null, 2));
    }
    if (kind === "comment") {
      if (option || !/^[1-9]\d*$/.test(ref) || !Number.isSafeInteger(Number(ref))) {
        throw new Error("Expected numeric comment id");
      }
      const target = reference("1", this.config);
      const item = object(await this.github.rest(`/repos/${target.repo}/issues/comments/${ref}`));
      const author = this.filter.identity(restActor(item.user));
      const link = `https://github.com/${target.repo}/issues/${Number(item.issue_url?.toString().split("/").at(-1)) || 1}#issuecomment-${ref}`;
      if (!author || author.role === "system") {
        this.filter.accept({ author: restActor(item.user) }, target.owner, link);
        return "No accepted comment";
      }
      if (typeof item.node_id !== "string") {
        throw new Error("Comment has no node id");
      }
      const meta = await this.node(item.node_id, "", "IssueComment");
      if (!this.filter.accept(meta, repoOf(meta).owner, link)) {
        return "No accepted comment";
      }
      return (
        renderItem(await this.node(item.node_id, "body", "IssueComment"), this.filter, link) ??
        "No accepted comment"
      );
    }
    const { item, person, link } = await this.thread(ref, kind === "issue" ? "issue" : "pr");
    if (!person) {
      return "No accepted thread";
    }
    if (kind === "checks" || option === "--checks") {
      return this.checks(item, link);
    }
    if (option === "--files" || option === "--diff") {
      if (kind !== "pr") {
        throw new Error("Files and diff require a PR");
      }
      const target = reference(ref, this.config);
      if (option === "--diff") {
        return labelled(
          person,
          await this.github.diff(`/repos/${target.repo}/pulls/${target.number}`)
        );
      }
      const files: unknown[] = [];
      for (let page = 1; ; page++) {
        const result = await this.github.rest(
          `/repos/${target.repo}/pulls/${target.number}/files?per_page=100&page=${page}`
        );
        if (!Array.isArray(result)) {
          throw new Error("Missing PR files");
        }
        files.push(
          ...result.map((value) => {
            const file = object(value);
            return {
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              patch: file.patch,
            };
          })
        );
        if (result.length < 100) {
          break;
        }
      }
      return labelled(person, JSON.stringify(files, null, 2));
    }
    if (option === "--reviews") {
      if (kind !== "pr") {
        throw new Error("Reviews require a PR");
      }
      const output: string[] = [];
      for (const meta of await this.collection(String(item.id), "PullRequest", "reviews")) {
        if (!this.filter.accept(meta, repoOf(meta).owner, link)) {
          continue;
        }
        const body = renderItem(
          await this.node(String(meta.id), "body", "PullRequestReview"),
          this.filter,
          link
        );
        if (body) {
          output.push(body);
        }
      }
      return output.join("\n\n") || "No accepted content";
    }
    return this.threadReport(kind, ref, item, link, option);
  };

  /** Post exact Markdown without changing the turn. A same-PR discussion_r replyTo
   * selects the inline reply endpoint; other valid comment URLs stay in conversation.
   */
  post: Handlers["post"] = async ({ ref, file, replyTo }, ctx) => {
    const target = reference(ref, this.config);
    let inlineId: string | undefined;
    if (replyTo !== undefined) {
      const url = new URL(replyTo);
      if (
        url.origin !== "https://github.com" ||
        url.search ||
        url.username ||
        url.password ||
        ![
          `/${target.repo}/pull/${target.number}`,
          `/${target.repo}/issues/${target.number}`,
        ].includes(url.pathname) ||
        !/^#(?:issuecomment-|discussion_r)[1-9]\d*$/.test(url.hash)
      ) {
        throw new Error("Invalid reply URL");
      }
      inlineId = /^#discussion_r([1-9]\d*)$/.exec(url.hash)?.[1];
      if (
        inlineId &&
        (!Number.isSafeInteger(Number(inlineId)) ||
          url.pathname !== `/${target.repo}/pull/${target.number}`)
      ) {
        throw new Error("Invalid inline reply URL");
      }
    }
    const body = readFileSync(file, "utf8");
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    const { item, person } = await this.thread(ref, "any");
    // REST issue comments also support PRs, but the metadata query must accept both.
    if (!person) {
      throw new Error("Refusing to post on an unaccepted thread");
    }
    if (inlineId && item.__typename !== "PullRequest") {
      throw new Error("Inline replies require a PR");
    }
    const warning =
      ctx.role === "orchestrator" &&
      target.repo === String(this.config.repo) &&
      item.__typename === "PullRequest" &&
      (await this.ownerReplyTurn(item, target.link))
        ? `\nWarning: this does not hand the turn back; use review ${target.number} owner`
        : "";
    const endpoint = inlineId
      ? `/repos/${target.repo}/pulls/${target.number}/comments/${inlineId}/replies`
      : `/repos/${target.repo}/issues/${target.number}/comments`;
    await this.github.rest(endpoint, "POST", {
      body,
    });
    return `Posted to ${target.link}${warning}`;
  };

  private async ownerReplyTurn(item: ObjectData, link: string): Promise<boolean> {
    if (object(this.config.board).enabled === false) {
      return false;
    }
    const board = this.board;
    const snapshot = await board.snapshot();
    const card = (await board.cards(snapshot.id)).find((card) => card.contentId === item.id);
    if (
      !card ||
      !["Owner review", "Executing"].includes(String(card.values.Status)) ||
      (!String(card.values.Progress ?? "").startsWith("🧭") &&
        !card.assignees.some((login) =>
          this.filter.people.some(
            (person) =>
              this.filter.roleIn(person, String(this.config.repo)) === "orchestrator" &&
              person.login === login
          )
        ))
    ) {
      return false;
    }
    // Ignore our plain answers: they do not supersede the owner's pending turn.
    const comments = await this.collection(String(item.id), "PullRequest", "comments");
    const replies = comments
      .map((comment) => this.filter.accept(comment, repoOf(comment).owner, link))
      .filter((person) => person && ["owner", "worker"].includes(person.role));
    // GitHub's comments connection is in creation order, including across pages.
    return replies.at(-1)?.role === "owner";
  }

  resolveTask: Handlers["resolveTask"] = async ({ branch }) => {
    validateBranch(branch);
    const repo = String(this.config.repo);
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

  task: Handlers["task"] = async ({ ref, fetch }) => {
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

  private async checkedTask(ref: string, requirePrompt = false) {
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
      String(this.config.repo).toLowerCase()
    ) {
      throw new Error("Task branch must belong to the configured repository");
    }
    if (item.state !== "OPEN") {
      throw new Error("Task PR is not open");
    }
    return { branch, base, item };
  }

  push: Handlers["push"] = async ({ worktree, branch, commit: selected, task: target }, ctx) => {
    if (target !== undefined && selected !== undefined) {
      throw new Error("An explicit task push must use the worktree HEAD");
    }
    if (
      target !== undefined &&
      (ctx.role !== "orchestrator" || !Number.isSafeInteger(target) || target < 1)
    ) {
      throw new Error(
        "Only orchestrators may push an explicit task PR (positive integer required)"
      );
    }
    if (
      selected !== undefined &&
      (ctx.role !== "orchestrator" || !/^[a-f\d]{40}$/i.test(selected))
    ) {
      throw new Error("Only orchestrators may push a frozen commit");
    }
    if (branch !== undefined) {
      taskBranch(branch, this.config);
    }
    const taskPr = target ?? ctx.taskPr;
    if (!Number.isSafeInteger(taskPr) || Number(taskPr) < 1) {
      throw new Error("Push requires its own taskPr");
    }
    const task = await this.checkedTask(String(taskPr), target !== undefined);
    if (target !== undefined) {
      branch ??= task.branch;
      if (branch !== task.branch) {
        throw new Error("Push branch must match its task PR branch");
      }
    }
    if (branch === undefined) {
      throw new Error("Push requires a branch");
    }
    if (selected && task.branch !== branch) {
      throw new Error("Frozen push must match its task PR branch");
    }
    if (ctx.role === "worker") {
      if (task.branch !== branch) {
        throw new Error("Worker may push only its own task branch");
      }
    }
    if (target === undefined && realpathSync(worktree) !== realpathSync(this.root)) {
      throw new Error("Push worktree must be the gateway checkout");
    }
    const git = new GitTransport(this.config, this.env, this.deps, resolve(worktree));
    const commit = (
      await git.run(
        "rev-parse",
        "--verify",
        selected
          ? `${selected}^{commit}`
          : target !== undefined
            ? "HEAD^{commit}"
            : `refs/heads/${branch}^{commit}`
      )
    ).trim();
    if (!/^[a-f\d]{40}$/i.test(commit)) {
      throw new Error("Invalid local commit");
    }
    if (target !== undefined) {
      const head = String(task.item.headRefOid ?? "");
      if (!/^[a-f\d]{40}$/i.test(head)) {
        throw new Error("Invalid task PR head");
      }
      const fetched = await git.transfer("fetch", [
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
      if (!fetched.ok) {
        throw new Error(pushFailureMessage(fetched, String(this.config.repo)));
      }
      const remote = (
        await git.run("rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`)
      ).trim();
      if (
        remote !== head ||
        (await git.run("rev-list", "--count", `${commit}..${head}`)).trim() !== "0"
      ) {
        throw new Error(
          pushFailureMessage({ ok: false, outcome: "moved", detail: "" }, String(this.config.repo))
        );
      }
    }
    const base = task.base;
    // Validate config refs before allowing them into fetch refspecs.
    validateBranch(base);
    if (!(await git.transferOk("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
      throw new Error("error: fetch failed");
    }
    const count = (
      await git.run("rev-list", "--count", `refs/remotes/origin/${base}..${commit}`)
    ).trim();
    if (!/^\d+$/.test(count) || Number(count) === 0) {
      throw new Error(`error: ${branch} has no commits on top of origin/${base}`);
    }
    const files = await git.run(
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      `refs/remotes/origin/${base}...${commit}`
    );
    const configured = (this.config.push as { denyPatterns?: string[] } | undefined)?.denyPatterns;
    const patterns = configured ?? [
      ".tmp/",
      "dist/",
      "coverage/",
      "*.log",
      "test-results/",
      "playwright-report/",
      "test-reports/",
    ];
    const changelog = String(
      object(this.config.changelog).directory ?? "changes/unreleased"
    ).replace(/\/$/, "");
    const denied = files.split("\0").filter(
      (file) =>
        file &&
        (configured !== undefined ||
          !(
            /(^|\/)(?:fixtures|__fixtures__|snapshots|__snapshots__)(\/|$)/.test(file) ||
            /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(
              file
            ) ||
            file.startsWith(`${changelog}/`)
          )) &&
        patterns.some((pattern) => {
          const glob = pattern.endsWith("/") ? `${pattern}**` : pattern;
          return matchesGlob(file, glob) || matchesGlob(file, `**/${glob}`);
        })
    );
    if (denied.length) {
      throw new Error(`error: refusing to push generated artefacts:\n${denied.join("\n")}`);
    }
    const result = await git.transfer("push", [`${commit}:refs/heads/${branch}`]);
    if (!result.ok) {
      throw new Error(pushFailureMessage(result, String(this.config.repo)));
    }
    if (ctx.role === "orchestrator") {
      this.github.writes.recordPush(String(this.config.repo), Number(taskPr), commit);
    }
    await git.run("update-ref", `refs/remotes/origin/${branch}`, commit);
    return `pushed ${branch} at ${commit.slice(0, 7)}`;
  };

  ghRead: Handlers["ghRead"] = async ({ source }) => {
    const counts = { dropped: 0, redacted: 0, textRedacted: 0 };
    if (source.endsWith(".graphql")) {
      const query = readQuery(readFileSync(source, "utf8"));
      const data = await this.github.graphql(query);
      const repo = String(this.config.repo);
      const output = untrusted(
        JSON.stringify(
          filterData(data, this.filter, repo, `https://github.com/${repo}`, counts, query),
          null,
          2
        ) ?? "null"
      );
      return `${output}\n${counts.dropped} items dropped by the people filter${counts.redacted ? `\n${counts.redacted} nested values redacted` : ""}${counts.textRedacted ? `\n${counts.textRedacted} text fields redacted from unattributable items` : ""}`;
    }
    // Only scoped repository endpoints. No URLs, alternate methods, redirects or encoded paths.
    const match =
      /^\/?repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[A-Za-z0-9_./-]+)?(?:\?([A-Za-z0-9_=&,.-]+))?$/.exec(
        source
      );
    // Permit exactly the compare delimiter, not traversal or arbitrary double dots.
    const safePath = (match?.[3] ?? "").replace(
      /^\/compare\/([A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*)\.\.\.([A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*)$/,
      "/compare/$1/$2"
    );
    if (
      !match ||
      safePath.includes("..") ||
      match[1].includes("..") ||
      match[2].includes("..") ||
      (match[4] ?? "").includes("..") ||
      match[1].toLowerCase() !== String(this.config.org).toLowerCase()
    ) {
      throw new Error(
        "gh-read permits scoped repository GET endpoints or a query .graphql file only"
      );
    }
    const repo = `${match[1]}/${match[2]}`;
    let data = await this.github.rest(source.startsWith("/") ? source : `/${source}`);
    if (/^\/(?:issues|pulls)\/[1-9]\d*$/.test(match[3] ?? "")) {
      data = await this.diagnosticThread(object(data), repo, match[3]!.startsWith("/pulls/"));
    } else if (/^\/(?:issues|pulls)$/.test(match[3] ?? "") && Array.isArray(data)) {
      const entries: unknown[] = [];
      for (const entry of data) {
        entries.push(await this.diagnosticThread(object(entry), repo, match[3] === "/pulls"));
      }
      data = entries;
    }
    const output = untrusted(
      JSON.stringify(
        filterDiagnostic(data, this.filter, repo, `https://github.com/${repo}`, counts),
        null,
        2
      ) ?? "null"
    );
    return `${output}\n${counts.dropped} items dropped by the people filter${counts.redacted ? `\n${counts.redacted} nested values redacted` : ""}${counts.textRedacted ? `\n${counts.textRedacted} text fields redacted from unattributable items` : ""}`;
  };

  private async diagnosticThread(
    rest: ObjectData,
    repo: string,
    pullRequest: boolean
  ): Promise<unknown> {
    const link = `https://github.com/${repo}/issues/${String(rest.number)}`;
    // REST updated_at includes labels/state changes and cannot identify a text editor.
    // Gate the original author, then obtain editor-aware metadata before requesting text.
    if (!this.filter.accept({ author: restActor(rest.user) }, repo.split("/")[0], link)) {
      return undefined;
    }
    if (typeof rest.node_id !== "string") {
      throw new Error("Missing diagnostic thread node ID");
    }
    const kind = pullRequest || rest.pull_request ? "PullRequest" : "Issue";
    const metadata = await this.node(rest.node_id, "", kind);
    if (!this.filter.accept(metadata, repoOf(metadata).owner, link)) {
      return undefined;
    }
    if (repoOf(metadata).repo !== repo) {
      throw new Error("Diagnostic thread repository changed");
    }
    const current = await this.node(rest.node_id, "title body", kind);
    if (!this.filter.accept(current, repoOf(current).owner, link)) {
      return undefined;
    }
    if (repoOf(current).repo !== repo || current.id !== rest.node_id) {
      throw new Error("Diagnostic thread identity changed");
    }
    if (typeof current.title !== "string" || typeof current.body !== "string") {
      throw new Error("Missing current diagnostic thread text");
    }
    const result = { ...rest };
    delete result.body_html;
    delete result.body_text;
    return {
      ...result,
      title: current.title,
      body: current.body,
      __vm_author: current.author,
      __vm_editor: current.editor,
      __vm_edited: current.lastEditedAt,
      __vm_repository: current.repository,
    };
  }

  dropped: Handlers["dropped"] = async ({ since }) => this.digest.read(since);

  ownerApproved: Handlers["ownerApproved"] = async ({ ref }) => this.approvalFor(ref);

  private async approvalFor(
    ref: string,
    historical?: string,
    explain?: (reason: string) => void
  ): Promise<boolean | "unknown"> {
    const { item, person } = await this.thread(ref, "pr");
    if (!person) {
      return false;
    }
    const reviews = await this.collection(String(item.id), "PullRequest", "reviews");
    // A review is authoritative without needing a usable project timeline API.
    if (
      isOwnerApproved(
        {
          headRefOid: historical ?? String(item.headRefOid),
          reviews,
          timeline: [],
          comments: [],
          boardNumber: Number(object(this.config.board).number),
          historical: historical !== undefined,
        },
        this.filter,
        String(this.config.repo)
      ) === true
    ) {
      const current = await this.thread(ref, "pr");
      return current.person && current.item.headRefOid === item.headRefOid ? true : "unknown";
    }
    const comments: ObjectData[] = [];
    const target = reference(ref, this.config);
    for (const meta of await this.collection(String(item.id), "PullRequest", "comments")) {
      const person = this.filter.accept(meta, repoOf(meta).owner, target.link);
      if (
        person?.role !== "orchestrator" ||
        this.filter.identity(meta.author)?.role !== "orchestrator"
      ) {
        continue;
      }
      const comment = await this.node(String(meta.id), "body createdAt", "IssueComment");
      if (
        this.filter.accept(comment, repoOf(comment).owner, target.link)?.role === "orchestrator"
      ) {
        comments.push(comment);
      }
    }
    // Timeline shape is normalized here; current card status is never queried.
    const timeline: ObjectData[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const data = object(
        await this.github.graphql(
          `query($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequest { ${identityFields} headRefOid timelineItems(first: 100, after: $cursor, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]) { nodes { __typename ... on ProjectV2ItemStatusChangedEvent { actor { ${actorFields} } status previousStatus createdAt project { number } } } pageInfo { hasNextPage endCursor } } } } }`,
          { id: item.id, cursor }
        )
      );
      const parent = object(data.node);
      if (!this.filter.accept(parent, repoOf(parent).owner, reference(ref, this.config).link)) {
        return false;
      }
      if (parent.headRefOid !== item.headRefOid) {
        return "unknown";
      }
      const connection = object(parent.timelineItems);
      if (!Array.isArray(connection.nodes)) {
        throw new Error("Missing timeline nodes");
      }
      for (const node of connection.nodes) {
        timeline.push({ ...object(node), field: "Status" });
      }
      const page = object(connection.pageInfo);
      if (page.hasNextPage === false) {
        break;
      }
      if (
        page.hasNextPage !== true ||
        typeof page.endCursor !== "string" ||
        seen.has(page.endCursor)
      ) {
        throw new Error("Invalid timeline pagination cursor");
      }
      cursor = page.endCursor;
      seen.add(cursor);
    }
    const evidence = {
      headRefOid: historical ?? String(item.headRefOid),
      reviews,
      timeline,
      comments,
      boardNumber: Number(object(this.config.board).number),
      historical: historical !== undefined,
    };
    if (explain) {
      // Delegation must still be current before an old autopilot head is diagnostic evidence.
      const delegated = comments.filter((comment) =>
        /^\[orchestrator\] AUTOPILOT APPROVED\n\nCurrent head: [a-f\d]{40}\n/i.test(
          String(comment.body)
        )
      );
      const state = delegated.length
        ? await this.autopilotFor(await this.flowThread(ref, "pr"))
        : undefined;
      explain(
        approvalRefusal(
          {
            ...evidence,
            comments: comments.filter(
              (comment) =>
                !delegated.includes(comment) ||
                (state?.active &&
                  state.at(Date.parse(String(comment.lastEditedAt ?? comment.createdAt))))
            ),
          },
          this.filter,
          String(this.config.repo),
          ref
        )
      );
    }
    return isOwnerApproved(evidence, this.filter, String(this.config.repo));
  }
}

export function createGateway(root: string, env: NodeJS.ProcessEnv, deps: Dependencies): Transport {
  const server = new GatewayServer(root, env, deps);
  const config = getConfig(root, env);
  const handlers: Handlers = {
    resolveTask: server.resolveTask,
    learnings: server.learnings,
    learningCheck: server.learningCheck,
    issueCreate: server.issueCreate,
    upstreamIssue: server.upstreamIssue,
    upstreamComment: server.upstreamComment,
    issueEdit: server.issueEdit,
    issueBlock: server.issueBlock,
    issueUnblock: server.issueUnblock,
    issueParent: server.issueParent,
    issueUnparent: server.issueUnparent,
    issueEstimate: server.issueEstimate,
    scopeReview: server.scopeReview,
    autopilotStop: server.autopilotStop,
    autopilotInherit: server.autopilotInherit,
    issueClose: server.issueClose,
    boardSetIssue: server.boardSetIssue,
    boardSetAssignees: server.boardSetAssignees,
    boardAdd: server.boardAdd,
    worker: server.worker,
    grade: server.grade,
    suggestModel: server.suggestModel,
    openTask: server.openTask,
    prOpen: server.prOpen,
    prMerge: server.prMerge,
    reviewTask: server.reviewTask,
    askIssue: server.askIssue,
    mergeTask: server.mergeTask,
    closeTask: server.closeTask,
    resolveConflicts: server.resolveConflicts,
    linkTask: server.linkTask,
    releaseHold: server.releaseHold,
    releaseNext: server.releaseNext,
    workerStatus: server.workerStatus,
    nextEvents: server.nextEvents,
    watchMute: server.watchMute,
    watchUnmute: server.watchUnmute,
    watchMutes: server.watchMutes,
    watchStop: server.watchStop,
    waitChecks: server.waitChecks,
    checkTaskCi: server.checkTaskCi,
    refreshChecks: server.refreshChecks,
    verify: server.verify,
    boardStatus: server.boardStatus,
    boardInit: server.boardInit,
    boardMigrate: server.boardMigrate,
    boardItem: server.boardItem,
    boardSet: server.boardSet,
    boardArchive: server.boardArchive,
    read: server.read,
    post: server.post,
    push: server.push,
    task: server.task,
    ghRead: server.ghRead,
    dropped: server.dropped,
    ownerApproved: server.ownerApproved,
  };
  const policy = {
    learnings: ["worker", "orchestrator"],
    learningCheck: ["worker", "orchestrator"],
    issueCreate: ["orchestrator"],
    upstreamIssue: ["orchestrator"],
    upstreamComment: ["orchestrator"],
    issueEdit: ["orchestrator"],
    issueBlock: ["orchestrator"],
    issueUnblock: ["orchestrator"],
    issueParent: ["orchestrator"],
    issueUnparent: ["orchestrator"],
    issueEstimate: ["orchestrator"],
    scopeReview: ["orchestrator"],
    autopilotStop: ["orchestrator"],
    autopilotInherit: ["orchestrator"],
    issueClose: ["orchestrator"],
    boardSetIssue: ["orchestrator"],
    boardSetAssignees: ["orchestrator"],
    boardAdd: ["orchestrator"],
    worker: ["orchestrator"],
    grade: ["orchestrator"],
    suggestModel: ["orchestrator"],
    openTask: ["orchestrator"],
    prOpen: ["orchestrator"],
    prMerge: ["orchestrator"],
    reviewTask: ["orchestrator"],
    askIssue: ["orchestrator"],
    mergeTask: ["orchestrator"],
    closeTask: ["orchestrator"],
    resolveConflicts: ["orchestrator"],
    linkTask: ["orchestrator"],
    releaseHold: ["orchestrator"],
    releaseNext: ["orchestrator"],
    workerStatus: ["orchestrator"],
    nextEvents: ["orchestrator"],
    watchMute: ["orchestrator"],
    watchUnmute: ["orchestrator"],
    watchMutes: ["orchestrator"],
    watchStop: ["orchestrator"],
    waitChecks: ["worker", "orchestrator"],
    checkTaskCi: ["orchestrator"],
    refreshChecks: ["orchestrator"],
    verify: ["orchestrator"],
    boardStatus: ["orchestrator"],
    boardInit: ["orchestrator"],
    boardMigrate: ["orchestrator"],
    boardItem: ["orchestrator"],
    boardSet: ["orchestrator"],
    boardArchive: ["orchestrator"],
    read: ["worker", "orchestrator"],
    post: ["worker", "orchestrator"],
    push: ["worker", "orchestrator"],
    resolveTask: ["worker", "orchestrator"],
    task: ["worker", "orchestrator"],
    ghRead: ["orchestrator"],
    dropped: ["orchestrator"],
    ownerApproved: ["orchestrator"],
  } as const satisfies Record<keyof Operations, readonly ("worker" | "orchestrator")[]>;
  return inProcess(handlers, async (operation, input, ctx) => {
    if (
      (operation === "learnings" &&
        ["submit", "annotate", "aggregate", "merge"].includes(
          (input as Operations["learnings"]["input"]).action
        ) &&
        ctx?.role !== "orchestrator") ||
      (operation === "learningCheck" &&
        (input as Operations["learningCheck"]["input"]).label &&
        ctx?.role !== "orchestrator" &&
        env.GITHUB_ACTIONS !== "true")
    ) {
      throw new Error("Learning writes require orchestrator role");
    }
    if (
      !ctx ||
      !Object.hasOwn(policy, operation) ||
      !(policy[operation] as readonly string[]).includes(ctx.role)
    ) {
      throw new Error(
        "Gateway operation denied for client role; check the checkout's VMETHOD_ROLE and VMETHOD_TASK_PR in .vmethod/.env"
      );
    }
    const ciLearningIdentity = await server.authenticate(ctx, operation);
    if (
      operation === "learningCheck" &&
      (input as Operations["learningCheck"]["input"]).label &&
      ctx.role !== "orchestrator" &&
      !ciLearningIdentity
    ) {
      throw new Error("Learning writes require orchestrator role");
    }
    if (ctx.role === "worker" && ["post", "task", "waitChecks"].includes(operation)) {
      const target = reference((input as Operations["post"]["input"]).ref, config);
      if (
        !Number.isSafeInteger(ctx.taskPr) ||
        Number(ctx.taskPr) < 1 ||
        target.number !== ctx.taskPr ||
        target.repo.toLowerCase() !== String(config.repo).toLowerCase()
      ) {
        throw new Error(
          "Worker may post only to its own taskPr in the configured repository; run vmethod in your task worktree, whose .vmethod/.env sets VMETHOD_ROLE=worker and VMETHOD_TASK_PR"
        );
      }
    }
  });
}

export type ReadInput = Operations["read"]["input"];
