import { parseFirstLine } from "../core/protocol.js";
import { EvidenceReader } from "../evidence/reader.js";
import { getConfig, loadYaml, type Config } from "../config.js";
import { ModelRegistry } from "../core/config.js";
import { WorkerWorktrees } from "./worker-launch.js";
import { WorktreeService } from "./worktrees.js";
import { GitHubClient, type Dependencies } from "./client.js";
import { Digest } from "./digest.js";
import { PeopleFilter, object, type ObjectData } from "./people.js";
import { checkMarkdown, guardClosingKeywords } from "./markdown.js";
import { inProcess, type Handlers, type Operations, type Transport } from "./transport.js";
import { inheritAutopilot } from "../evidence/autopilot.js";
import { TaskFlow } from "./task-flow.js";
import { BoardService } from "./board.js";
import { WorkerService } from "./workers.js";
import { EventLoop, eventDeps } from "./events.js";
import { ChecksService } from "./checks.js";
import { VerificationService } from "./verify.js";
import { ConflictService } from "./conflicts.js";
import { verifyConflictHead } from "./verify-hook.js";
import * as workers from "./handlers/workers.js";
import * as learnings from "./handlers/learnings.js";
import * as watch from "./handlers/watch.js";
import * as diagnostics from "./handlers/diagnostics.js";
import * as board from "./handlers/board.js";
import * as issues from "./handlers/issues.js";
import * as tasks from "./handlers/tasks.js";
import * as threads from "./handlers/threads.js";
import * as push from "./handlers/push.js";
import { TokenAuthentication } from "../identity/token.js";
import { authorizeGateway } from "../identity/policy.js";

/** Builds and shares the lazy services used by gateway handlers. */
export class GatewayServices {
  config: Config;
  readonly models: ModelRegistry;
  readonly watchStateConfig: Config;
  peopleMtime: number;
  configMtime: number;
  readonly filter: PeopleFilter;
  readonly digest: Digest;
  // Lazy: offline CLI verbs never create or authenticate a gateway client.
  client?: GitHubClient;
  boardClient?: BoardService;
  workersClient?: WorkerService;
  readonly loops = new Map<string, EventLoop>();
  readonly eventReaders = new Set<string>();
  readonly authentication: TokenAuthentication;
  worker = workers.worker.bind(this);
  worktreeTask = workers.worktreeTask;
  worktreeTaskFor = workers.worktreeTaskFor;
  grade = workers.grade.bind(this);
  suggestModel = workers.suggestModel.bind(this);
  limits = workers.limits.bind(this);
  localNumber = workers.localNumber;
  projectCard = workers.projectCard;
  projectValue = workers.projectValue;
  richThread = workers.richThread;
  setWorkerField = workers.setWorkerField;
  workerIssue = workers.workerIssue;
  workerMetadata = workers.workerMetadata;
  learnings = learnings.learnings.bind(this);
  learningBundle = learnings.learningBundle;
  learningCheck = learnings.learningCheck.bind(this);
  learningService = learnings.learningService;
  learningRole = learnings.learningRole;
  nextEvents = watch.nextEvents.bind(this);
  eventLoop = watch.eventLoop;
  reloadWatchFiles = watch.reloadWatchFiles;
  watchMtime = watch.watchMtime;
  watchMute = watch.watchMute.bind(this);
  watchUnmute = watch.watchUnmute.bind(this);
  watchMutes = watch.watchMutes.bind(this);
  watchStop = watch.watchStop.bind(this);
  resolveConflicts = diagnostics.resolveConflicts.bind(this);
  waitChecks = diagnostics.waitChecks.bind(this);
  checkTaskCi = diagnostics.checkTaskCi.bind(this);
  refreshChecks = diagnostics.refreshChecks.bind(this);
  verify = diagnostics.verify.bind(this);
  releaseNext = diagnostics.releaseNext.bind(this);
  ghRead = diagnostics.ghRead.bind(this);
  diagnosticThread = diagnostics.diagnosticThread;
  dropped = diagnostics.dropped.bind(this);
  ownerApproved = diagnostics.ownerApproved.bind(this);
  boardStatus = board.boardStatus.bind(this);
  boardInit = board.boardInit.bind(this);
  boardMigrate = board.boardMigrate.bind(this);
  boardItem = board.boardItem.bind(this);
  boardSet = board.boardSet.bind(this);
  boardSetIssue = board.boardSetIssue.bind(this);
  boardSetAssignees = board.boardSetAssignees.bind(this);
  boardAdd = board.boardAdd.bind(this);
  boardArchive = board.boardArchive.bind(this);
  issueCreate = issues.issueCreate.bind(this);
  upstreamIssue = issues.upstreamIssue.bind(this);
  upstreamComment = issues.upstreamComment.bind(this);
  issueEdit = issues.issueEdit.bind(this);
  staleMessage = issues.staleMessage;
  staleScopeApproval = issues.staleScopeApproval;
  openTaskPr = issues.openTaskPr;
  scopeReview = issues.scopeReview.bind(this);
  scopeSummary = issues.scopeSummary;
  scopeReviewCore = issues.scopeReviewCore;
  issueClose = issues.issueClose.bind(this);
  issueReopen = issues.issueReopen.bind(this);
  preDoneStatus = issues.preDoneStatus;
  issueParent = issues.issueParent.bind(this);
  issueUnparent = issues.issueUnparent.bind(this);
  issueBlock = issues.issueBlock.bind(this);
  issueUnblock = issues.issueUnblock.bind(this);
  issueEstimate = issues.issueEstimate.bind(this);
  issueNodeId = issues.issueNodeId;
  subIssueParentRef = issues.subIssueParentRef;
  subIssueParent = issues.subIssueParent;
  parentLabel = issues.parentLabel;
  relateSubIssue = issues.relateSubIssue;
  parentMatchesEpic = issues.parentMatchesEpic;
  writeSubIssueRelation = issues.writeSubIssueRelation;
  autopilotStop = tasks.autopilotStop.bind(this);
  autopilotInherit = tasks.autopilotInherit.bind(this);
  openTask = tasks.openTask.bind(this);
  prOpen = tasks.prOpen.bind(this);
  prEdit = tasks.prEdit.bind(this);
  prMerge = tasks.prMerge.bind(this);
  reviewTask = tasks.reviewTask.bind(this);
  askIssue = tasks.askIssue.bind(this);
  mergeTask = tasks.mergeTask.bind(this);
  closeTask = tasks.closeTask.bind(this);
  linkTask = tasks.linkTask.bind(this);
  releaseHold = tasks.releaseHold.bind(this);
  workerStatus = tasks.workerStatus.bind(this);
  resolveTask = tasks.resolveTask.bind(this);
  task = tasks.task.bind(this);
  checkedTask = tasks.checkedTask;
  flowThread = threads.flowThread;
  flowComments = threads.flowComments;
  flowComment = threads.flowComment;
  node = threads.node;
  thread = threads.thread;
  collection = threads.collection;
  reviewThreadComments = threads.reviewThreadComments;
  threadEntry = threads.threadEntry;
  prThread = threads.prThread;
  issueThread = threads.issueThread;
  threadReport = threads.threadReport;
  checks = threads.checks;
  read = threads.read.bind(this);
  post = threads.post.bind(this);
  ownerReplyTurn = threads.ownerReplyTurn;
  push = push.push.bind(this);

  constructor(
    public root: string,
    public env: NodeJS.ProcessEnv,
    public deps: Dependencies
  ) {
    this.config = getConfig(root, env);
    this.models = new ModelRegistry(root);
    this.watchStateConfig = this.config;
    this.peopleMtime = this.watchMtime("people");
    this.configMtime = this.watchMtime("vmethod");
    this.digest = new Digest(
      env,
      this.config.stateName ?? this.config.repo.replace("/", "-"),
      deps.now
    );
    this.filter = new PeopleFilter(loadYaml(root, "people"), this.config.org, this.digest);
    this.authentication = new TokenAuthentication(
      () => this.github,
      () => this.config,
      this.filter,
      this.env
    );
  }

  get workerWorktrees(): WorkerWorktrees {
    return new WorkerWorktrees(this.root, this.config, this.env, this.deps);
  }

  get workers(): WorkerService {
    return (this.workersClient ??= new WorkerService(
      this.root,
      this.config,
      this.env,
      this.deps,
      {
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
          await this.github.rest(`/repos/${this.config.repo}/issues/${pr}/comments`, "POST", {
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
          await this.github.rest(`/repos/${this.config.repo}/issues/${issue}/comments`, "POST", {
            body,
          });
        },
        modelApproval: (pr, issue, family) => this.evidence.modelApproval(family, { pr, issue }),
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
            await this.github.rest(`/repos/${this.config.repo}/compare/${base}...${head}`)
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
      },
      this.models
    ));
  }

  get worktrees(): WorktreeService {
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

  get ci(): ChecksService {
    return new ChecksService(this.config, this.github, this.filter, this.deps);
  }

  get conflicts(): ConflictService {
    return new ConflictService(this.root, this.config, this.env, eventDeps(this.deps), {
      snapshot: async (pr) => {
        await this.flow.conflictTask(String(pr));
        return this.ci.snapshot(String(pr));
      },
      approved: async (pr, head) =>
        (await this.evidence.approvalFor(String(pr), head)) === true ||
        (await this.evidence.autopilotApprovalFor(String(pr), head)),
      update: async (pr, head) => {
        await this.github.rest(
          `/repos/${this.config.repo}/pulls/${pr}/update-branch`,
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
        return (
          !!latest &&
          !!parseFirstLine(latest.body, { role: "worker", tags: ["BLOCKED", "QUESTION"] })
        );
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

  get verification(): VerificationService {
    return new VerificationService(
      this.root,
      this.env,
      this.config,
      this.deps,
      this.ci,
      (input, taskPr) => this.push(input, { role: "orchestrator", taskPr }),
      // #373: refresh-checks holds the same per-PR lock the watcher's dispatch uses.
      (pr, run) => this.conflicts.guard(pr, run)
    );
  }

  get board(): BoardService {
    return (this.boardClient ??= new BoardService(
      this.config,
      this.github,
      this.deps,
      undefined,
      undefined,
      this.filter
    ));
  }

  get flow(): TaskFlow {
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
    return new TaskFlow(
      this.root,
      this.env,
      this.config,
      deps,
      {
        github: this.github,
        board: () => this.board,
        people: loadYaml(this.root, "people"),
        autopilot: async (ref, kind) =>
          this.evidence.autopilotFor(await this.flowThread(ref, kind)),
        copyAutopilot: async (issue, pr) => {
          if (
            (object(issue.labels).nodes as ObjectData[]).some((label) => label.name === "autopilot")
          ) {
            await inheritAutopilot(this.github, this.filter, this.config, issue, pr);
          }
        },
        autopilotApproved: (ref, head) => this.evidence.autopilotApprovalFor(ref, head),
        thread: (ref, kind) => this.flowThread(ref, kind),
        // #373: closes a recoverable blocked record at once (mergeable head, stopped
        // fixer) before reporting whether an active record still blocks the handover.
        conflictPending: async (ref) => this.conflicts.recover(Number(ref)),
        comments: (id, kind) => this.flowComments(id, kind === "issue" ? "Issue" : "PullRequest"),
        replyTarget: (id) => this.flowComment(id),
        approved: (ref, historical) => this.evidence.approvalFor(ref, historical),
        approvalRefusal: async (ref) => {
          let reason = `Owner approval is missing or cannot be verified for current head; hand over with review ${ref} owner`;
          await this.evidence.approvalFor(ref, undefined, (text) => {
            reason = text;
          });
          return reason;
        },
        scopeRefusal: async (item) =>
          scopeReasons.get(String(item.id)) ??
          `scope not approved: run scope-review ${String(item.number)} <file>`,
        candidates: (ref) => this.evidence.candidates(ref),
        issueApproved: async (item) => {
          const state = await this.evidence.scopeState(item);
          if (state?.refusal) {
            scopeReasons.set(String(item.id), state.refusal);
          }
          return state?.approved === true;
        },
        modelApproval: (issue, family) => this.evidence.modelApproval(family, { issue }),
        // #339: open-task's advisory lines reuse suggest-model's recommendation and the
        // per-family learnings aggregate; informational only, never a refusal source.
        modelSuggestion: async (issue) => {
          const { model, reason } = await this.workers.recommend(issue);
          return { family: model.family, tier: model.tier, reason };
        },
        learningEvidence: (family) => this.learningService().familyEvidence(family),
        modelHeadroom: (family) => this.workers.headroom(family),
        modelQuotaWarning: (family) => this.workers.quotaWarning(family),
        ownerAgreement: (ref, url, since, handback, kind) =>
          this.evidence.ownerAgreed(ref, url, since, handback, kind),
      },
      this.models
    );
  }

  /** Fresh readers share the gateway's existing filtered transport helpers. */
  get evidence(): EvidenceReader {
    return new EvidenceReader(this.github, this.filter, this.config, {
      board: () => this.board,
      thread: (ref, kind) => this.thread(ref, kind),
      node: (id, fields, type) => this.node(id, fields, type),
      collection: (id, type, field) => this.collection(id, type, field),
      flowThread: (ref, kind) => this.flowThread(ref, kind),
      flowComments: (id, type) => this.flowComments(id, type),
      projectCard: (item) => this.projectCard(item),
    });
  }

  get github(): GitHubClient {
    return (this.client ??= new GitHubClient(this.config, this.env, this.deps));
  }
}

export function createGateway(root: string, env: NodeJS.ProcessEnv, deps: Dependencies): Transport {
  const server = new GatewayServices(root, env, deps);
  const config = server.config;
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
    issueReopen: server.issueReopen,
    boardSetIssue: server.boardSetIssue,
    boardSetAssignees: server.boardSetAssignees,
    boardAdd: server.boardAdd,
    worker: server.worker,
    grade: server.grade,
    suggestModel: server.suggestModel,
    limits: server.limits,
    openTask: server.openTask,
    prOpen: server.prOpen,
    prEdit: server.prEdit,
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
  return inProcess(
    handlers,
    authorizeGateway(config, env, server.authentication.authenticate.bind(server.authentication))
  );
}

export type ReadInput = Operations["read"]["input"];
