import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { assertEstimate } from "../board/estimate.js";
import { getConfig, loadYaml, type Config } from "../config.js";
import { workerWorktree } from "./worker-path.js";
import { WorktreeService, type WorktreeTask } from "./worktrees.js";
import { GitHubClient, type Dependencies } from "./client.js";
import { Digest } from "./digest.js";
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
  filterDiagnostic,
  identityFields,
  readQuery,
  renderItem,
  repoOf,
  restActor,
} from "./queries.js";
import { checkMarkdown, guardClosingKeywords } from "./markdown.js";
import {
  inProcess,
  type CallContext,
  type Handlers,
  type Operations,
  type Transport,
} from "./transport.js";
import { tokenIdentity, tokenViewer } from "./identity.js";
import { isOwnerApproved } from "./approval.js";
import { bodyHash, ScopeReader } from "./scope.js";
import { setTurn, turnAssignees } from "./turn.js";
import { renderProgress } from "../board/progress.js";
import { legacyIssueHeaders, TaskFlow } from "./task-flow.js";
import { isTaskPrompt } from "./task-flow-types.js";
import { GitTransport, taskBranch, validateBranch } from "./git.js";
import { realpathSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { BoardService } from "./board.js";
import { WorkerService, type TaskMetadata } from "./workers.js";
import { workerAccess } from "./access.js";
import { startTask } from "./worker-verbs.js";
import {
  EventLoop,
  eventDeps,
  resolveSession,
  muteThread,
  unmuteThread,
  listMutes,
} from "./events.js";

import { ChecksService } from "./checks.js";
import { VerificationService } from "./verify.js";
import { reference } from "./refs.js";
import { LearningsService } from "./learnings.js";
import { checkLearningPr } from "./learning-check.js";
import { backfillCosts } from "./cost-backfill.js";
import type { Price, PriceTier } from "../cost.js";

class GatewayServer {
  private readonly config: Config;
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
    // The CI-only learning validator retains its pinned-base registry and write gates.
    // Neither an environment flag alone nor a system identity grants any other verb.
    if (person.role === "system" && actionsLearningCheck) {
      return true;
    }
    if (person.role !== "orchestrator" && person.role !== "worker") {
      throw new Error(
        `Gateway token refused: ${person.login} (${person.role}) is not an orchestrator or worker identity`
      );
    }
    if (ctx.taskPr !== undefined && person.role !== "worker") {
      throw new Error(
        `worker session holds a non-worker token (${person.login}); fix the worker environment`
      );
    }
    if (ctx.role === "orchestrator" && person.role !== "orchestrator") {
      throw new Error(
        `VMETHOD_ROLE=orchestrator refused: token belongs to ${person.login} (${person.role})`
      );
    }
    return false;
  }

  private get workers(): WorkerService {
    return (this.workersClient ??= new WorkerService(this.root, this.config, this.env, this.deps, {
      metadata: (pr) => this.workerMetadata(pr),
      prepare: async (pr) => {
        const task = await this.task({ ref: String(pr) }, { role: "orchestrator" });
        const directory = workerWorktree(this.root, this.config, task.branch);
        // Keep dependency installation/dirty-tree guards in the existing preparation path.
        if (!existsSync(directory)) {
          await startTask(
            {
              call: async (operation, input) => {
                if (operation === "workerAccess") {
                  return this.workerAccess(input as Operations["workerAccess"]["input"], {
                    role: "orchestrator",
                  }) as never;
                }
                if (operation !== "task") {
                  throw new Error("Unexpected preparation operation");
                }
                return this.task(input as Operations["task"]["input"], {
                  role: "orchestrator",
                }) as never;
              },
            },
            this.root,
            String(pr),
            this.env,
            { role: "orchestrator" },
            {
              exec: this.deps.exec,
              report: this.deps.report,
            }
          );
        }
        const git = (...args: string[]) =>
          this.deps.exec(
            "git",
            [...(this.config.workerUser ? ["-c", `safe.directory=${directory}`] : []), ...args],
            {
              cwd: directory,
              env: { PATH: this.env.PATH, HOME: this.env.HOME },
            }
          );
        if (
          realpathSync((await git("rev-parse", "--show-toplevel")).trim()) !==
            realpathSync(directory) ||
          (await git("rev-parse", "--abbrev-ref", "HEAD")).trim() !== task.branch
        ) {
          throw new Error("Worker directory is not the PR's worktree/branch");
        }
        if (
          resolve(directory, (await git("rev-parse", "--git-common-dir")).trim()) ===
          resolve(directory, (await git("rev-parse", "--git-dir")).trim())
        ) {
          throw new Error("Worker start requires a linked task worktree, not a main checkout");
        }
        await workerAccess(this.root, directory, this.config, this.deps);
        return directory;
      },
      setModel: (pr, family) => this.setWorkerField(pr, "pr", "Model", family),
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
      submitLearnings: () => this.learningService().command({ action: "submit" }),
      workerIdentity: () => this.workerIdentity(),
      issue: (issue) => this.workerIssue(issue),
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
      return `${stopped}\nWorktree cleanup ${(await this.worktrees.cleanup(task)) ? "complete" : "skipped; see safety report"}`;
    }
    return this.workers.command(args);
  };

  private get worktrees(): WorktreeService {
    return new WorktreeService(this.root, this.config, this.env, this.deps, (pr) =>
      this.deps.workers ? this.deps.workers.status(pr) : this.workers.mergeStatus(pr)
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
  costBackfill: Handlers["costBackfill"] = async ({ dryRun, prs }) => {
    if (dryRun !== undefined && typeof dryRun !== "boolean") {
      throw new Error("Invalid dryRun");
    }
    if (
      prs !== undefined &&
      (!Array.isArray(prs) || prs.some((pr) => !Number.isSafeInteger(pr) || pr < 1))
    ) {
      throw new Error("Invalid PR numbers");
    }
    const models = loadYaml(this.root, "models") as {
      family: string;
      model: string;
      price?: Price;
      tiers?: PriceTier[];
    }[];
    return backfillCosts(
      {
        root: this.root,
        config: this.config,
        env: this.env,
        models,
        readSession: (id) => this.workers.readSessionForCost(id),
        inspectCard: async (pr) => {
          const item = await this.richThread(pr, "pr");
          const value = this.projectValue(item, "Cost");
          return {
            cost: typeof value === "string" ? value : null,
            archived: this.projectCard(item).isArchived === true,
          };
        },
        setCost: (pr, cost) => this.setWorkerField(pr, "pr", "Cost", cost),
        listPrs: async () => {
          const snapshot = await this.board.snapshot();
          return (await this.board.cards(snapshot.id))
            .filter(
              (card) =>
                card.kind === "PullRequest" &&
                card.repo?.toLowerCase() === String(this.config.repo).toLowerCase() &&
                Number.isSafeInteger(card.number)
            )
            .map((card) => card.number!);
        },
        report: this.deps.report,
      },
      { dryRun, prs }
    );
  };
  suggestModel: Handlers["suggestModel"] = async ({ ref }) => {
    const suggestion = await this.workers.suggest(this.localNumber(ref));
    const family = suggestion.split(":", 1)[0];
    return `${suggestion}\n${await this.learningService().show(family)}`;
  };
  learnings: Handlers["learnings"] = async (input) => this.learningService().command(input);
  learningCheck: Handlers["learningCheck"] = async ({ ref, label }) => {
    if (String(this.config.repo).toLowerCase() !== "vworlds/vmethod") {
      throw new Error("Learning PR checks run only in the central repository");
    }
    return checkLearningPr(this.github, this.localNumber(ref), label);
  };

  private learningService(): LearningsService {
    return new LearningsService(this.root, this.config, this.env, this.deps, () => this.github);
  }
  workerAccess: Handlers["workerAccess"] = async ({ directory }, ctx) => {
    if (ctx.role === "worker") {
      const task = await this.task({ ref: String(ctx.taskPr) }, ctx);
      if (resolve(directory) !== workerWorktree(this.root, this.config, task.branch)) {
        throw new Error("Worker access requires its own worktree");
      }
    }
    return workerAccess(this.root, directory, this.config, this.deps);
  };

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
    const fields = `title body state ${kind === "pr" ? "isDraft merged headRefName closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } }" : "labels(first: 100) { nodes { name } } blockedBy(first: 100) { nodes { state } pageInfo { hasNextPage } }"} projectItems(first: 100) { nodes { id isArchived project { number owner { ... on Organization { login } ... on User { login } } } fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }`;
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
  ): Promise<void> {
    const item = await this.richThread(ref, kind);
    const card = this.projectCard(item);
    if (typeof card.id !== "string") {
      throw new Error("Task has no card on configured board");
    }
    if (field === "Cost" && this.projectValue(item, field) === value) {
      return;
    }
    if (field === "Cost" && card.isArchived === true) {
      throw new Error("The item is archived and cannot be updated");
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
      blocked = false;
    if (issue) {
      const linked = await this.richThread(issue, "issue");
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
      const comment = await this.node(String(meta.id), "body createdAt", "IssueComment");
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
        comments.push({ body: comment.body, role: author.role, date });
      }
    }
    const snapshot =
      /<!--\s*points_open:\s*(\d+(?:\.\d+)?)\s*-->/.exec(body) ??
      /\*\*Estimate:\*\*\s*(\d+(?:\.\d+)?)/.exec(body);
    const model = this.projectValue(item, "Model") ?? /\*\*Model:\*\*\s*`?([\w-]+)/.exec(body)?.[1];
    const progress = this.projectValue(item, "Progress");
    return {
      pr,
      issue,
      branch: String(item.headRefName),
      title: String(item.title),
      body,
      state: String(item.state),
      draft: item.isDraft === true,
      blocked,
      progress: typeof progress === "string" ? progress : undefined,
      estimate,
      pointsOpen: snapshot ? Number(snapshot[1]) : undefined,
      model: typeof model === "string" ? model : undefined,
      kind,
      merged: item.merged === true,
      comments,
    };
  }
  private async workerIdentity(): Promise<NodeJS.ProcessEnv> {
    if (this.config.workerUser) {
      const run = (...args: string[]) =>
        this.deps.exec("id", args, { cwd: this.root, env: { PATH: this.env.PATH } });
      const current = (await run("-u")).trim();
      const worker = (await run("-u", String(this.config.workerUser))).trim();
      if (!/^\d+$/.test(current) || current !== worker) {
        throw new Error(
          `Claude launch must run as the worker user ${String(this.config.workerUser)}; use that user's login`
        );
      }
    }
    const name = object(this.config.credentials).workerGithubToken;
    const token = typeof name === "string" ? this.env[name] : undefined;
    if (!token) {
      throw new Error(
        "Claude workers require credentials.workerGithubToken naming a worker-scoped token environment variable"
      );
    }
    const client = new GitHubClient(
      { ...this.config, credentials: { githubToken: name } },
      this.env,
      this.deps
    );
    const viewer = object(
      object(await client.graphql(`query WorkerIdentity { viewer { ${actorFields} } }`)).viewer
    );
    if (this.filter.identity(viewer, false)?.role !== "worker") {
      throw new Error(
        "Configured Claude GitHub identity is not a pinned worker; refusing orchestrator identity"
      );
    }
    const env: NodeJS.ProcessEnv = { GH_TOKEN: token, GITHUB_TOKEN: token, VMETHOD_ROLE: "worker" };
    const githubName = object(this.config.credentials).githubToken;
    if (typeof githubName === "string") {
      env[githubName] = token;
    }
    for (const key of ["PATH", "HOME", "TMPDIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      if (this.env[key]) {
        env[key] = this.env[key];
      }
    }
    // Credentials for the gateway/opencode/orchestrator are deliberately not inherited.
    return env;
  }
  private readonly loops = new Map<string, EventLoop>();

  nextEvents: Handlers["nextEvents"] = async (input) => {
    const name = resolveSession(this.config, input).stateName;
    let loop = this.loops.get(name);
    if (!loop) {
      const methodology = String(object(this.config.vmethod).repo ?? "vworlds/vmethod");
      loop = new EventLoop(
        {
          root: this.root,
          config: this.config,
          env: this.env,
          deps: eventDeps(this.deps),
          filter: new PeopleFilter(
            this.filter.people,
            this.filter.org,
            this.digest,
            methodology === "off" ? [] : [methodology]
          ),
          github: this.github,
          workerStatus: (pr) => this.workers.watchStatus(pr),
          workerSend: (pr, text) => this.workers.resume(pr, text),
          board: { set: (input) => this.board.set(input) },
          digest: this.digest,
        },
        input
      );
      this.loops.set(name, loop);
    }
    return loop.nextEvents(input);
  };
  watchMute: Handlers["watchMute"] = async ({ ref }) => muteThread(this.config, this.env, ref);
  watchUnmute: Handlers["watchUnmute"] = async ({ ref }) =>
    unmuteThread(this.config, this.env, ref);
  watchMutes: Handlers["watchMutes"] = async () => listMutes(this.config, this.env);

  private get ci(): ChecksService {
    return new ChecksService(this.config, this.github, this.filter, this.deps);
  }

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

  private get board(): BoardService {
    return (this.boardClient ??= new BoardService(this.config, this.github, this.deps));
  }

  boardStatus: Handlers["boardStatus"] = async ({ fix }) =>
    fix ? this.board.fixStatus() : this.board.status();
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

  /** Create an own-repository issue from checked content and ensure readable configured-board
   * membership. Optional estimate/status use the shared board field writer; estimates must
   * use the shared points scale and labels may repeat.
   * Board follow-up failures identify the created issue so callers do not create a duplicate.
   */
  issueCreate: Handlers["issueCreate"] = async ({ title, file, labels = [], estimate, status }) => {
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
    const boardEnabled = object(this.config.board).enabled !== false;
    if (!boardEnabled && (estimate !== undefined || status !== undefined)) {
      throw new Error("Board is disabled; estimate/status require a configured board");
    }
    const body = readFileSync(file, "utf8");
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
        const itemId = await board.ensure(created.node_id);
        const snapshot = await board.snapshot();
        for (let attempt = 0; ; attempt++) {
          const card = (await board.cards(snapshot.id)).find(
            (card) => card.id === itemId && card.contentId === created.node_id
          );
          if (card) {
            break;
          }
          if (attempt === 5) {
            throw new Error("Board item not readable after 6 reads");
          }
          await this.deps.sleep(1000 * 2 ** attempt);
        }
        if (estimate !== undefined) {
          await board.setIssueField(created.node_id, "Estimate", String(estimate));
        }
        if (status !== undefined) {
          await board.setIssueField(created.node_id, "Status", status);
        }
      } catch (error) {
        throw new Error(
          `Created issue #${String(created.number)}; board follow-up failed: ${error instanceof Error ? error.message : String(error)}. Do not recreate; inspect this issue and retry board operations only.`,
          { cause: error }
        );
      }
    }
    return `Created issue #${String(created.number)}`;
  };

  /** Close an accepted own-repository issue, optionally posting a validated file comment first. */
  /** Rewrite only the exact body previously returned by read issue. */
  issueEdit: Handlers["issueEdit"] = async ({ ref, file }) => {
    const number = this.localNumber(ref);
    const body = readFileSync(file, "utf8");
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    const item = await this.flowThread(String(number), "issue");
    const snapshot = resolve(this.root, ".tmp", `issue-read-${number}.sha256`);
    if (!existsSync(snapshot) || readFileSync(snapshot, "utf8") !== bodyHash(String(item.body))) {
      throw new Error(
        "Issue body changed since read (or not read); read issue again before editing"
      );
    }
    await this.github.rest(
      `/repos/${String(this.config.repo)}/issues/${number}`,
      "PATCH",
      { body },
      false
    );
    writeFileSync(snapshot, bodyHash(body));
    return `Updated issue #${number}`;
  };

  /** Publish checked summary with the live digest, then assign scope review to the owner. */
  scopeReview: Handlers["scopeReview"] = async ({ ref, file }) => {
    const number = this.localNumber(ref);
    const summary = readFileSync(file, "utf8");
    if (!summary.trim() || /body sha256:|\[orchestrator\] SCOPE REVIEW/.test(summary)) {
      throw new Error("Provide a nonempty change summary, without a review tag or body hash");
    }
    const issue = await this.flowThread(String(number), "issue");
    if (issue.state !== "OPEN" || typeof issue.body !== "string") {
      throw new Error("Scope review requires an open issue with a readable body");
    }
    const body = `[orchestrator] SCOPE REVIEW\n\nI have updated the main body to the final scope.\n\n${summary.trim()}\n\nbody sha256: ${bodyHash(String(issue.body))}`;
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
      loadYaml(this.root, "people") as Person[],
      String(this.config.repo),
      current,
      "owner"
    );
    await this.github.rest(
      `/repos/${String(this.config.repo)}/issues/${number}/comments`,
      "POST",
      { body },
      false
    );
    await this.board.setIssueField(String(issue.id), "Status", "In review");
    await this.board.setIssueField(
      String(issue.id),
      "Progress",
      renderProgress({ state: "owner-review", round: null, red: false })
    );
    await setTurn(this.github, String(this.config.repo), number, current, next);
    return `Scope review requested for #${number}`;
  };

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
  boardArchive: Handlers["boardArchive"] = async ({ itemId }) => this.board.archive(itemId);

  private get flow(): TaskFlow {
    const deps: Dependencies = {
      ...this.deps,
      workers: this.deps.workers ?? {
        status: (pr, forMerge) => this.workers.mergeStatus(pr, forMerge),
        stop: (pr) => this.workers.command(["stop", String(pr)]),
        resume: (pr, prompt) => this.workers.resume(pr, prompt),
      },
    };
    return new TaskFlow(this.root, this.env, this.config, deps, {
      github: this.github,
      board: () => this.board,
      people: loadYaml(this.root, "people") as Person[],
      thread: (ref, kind) => this.flowThread(ref, kind),
      comments: (id) => this.flowComments(id),
      approved: (ref, historical) => this.approvalFor(ref, historical),
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
          if (/^\[orchestrator\] OWNER REVIEW(?:\s|$)/.test(String(comment.body))) {
            for (const head of String(comment.body).match(/\b[a-f\d]{40}\b/gi) ?? []) {
              candidates.add(head);
            }
          }
        }
        return [...candidates];
      },
      issueApproved: async (item) =>
        (
          await new ScopeReader(this.github, this.filter, this.config).approved([String(item.id)])
        ).get(String(item.id)) === true,
    });
  }
  openTask: Handlers["openTask"] = async (input) => this.flow.open(input);
  reviewTask: Handlers["reviewTask"] = async (input) => this.flow.review(input);
  askIssue: Handlers["askIssue"] = async (input) => this.flow.ask(input.ref, input.file);
  mergeTask: Handlers["mergeTask"] = async (input) =>
    this.flow.merge(input.ref, input.mergeCommit, input.carryApproval);
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
      `title body state labels(first: 100) { nodes { name } pageInfo { hasNextPage } } ${kind === "pr" ? "headRefOid headRefName baseRefName baseRefOid isDraft mergeable headRepository { nameWithOwner } closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } }" : ""}`,
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
  private async flowComments(id: string): Promise<ObjectData[]> {
    const output: ObjectData[] = [];
    for (const meta of await this.collection(id, "PullRequest", "comments")) {
      if (this.filter.identity(meta.author)?.role !== "orchestrator") {
        continue;
      }
      const comment = await this.node(String(meta.id), "body createdAt", "IssueComment");
      if (
        this.filter.identity(comment.author)?.role === "orchestrator" &&
        this.filter.accept(
          comment,
          repoOf(comment).owner,
          `https://github.com/${String(this.config.repo)}`
        )?.role === "orchestrator"
      ) {
        output.push(comment);
      }
    }
    return output;
  }
  constructor(
    private root: string,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies
  ) {
    this.config = getConfig(root, env);
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
        ? `... on Issue { ${identityFields} } ... on PullRequest { ${identityFields} }`
        : `${identityFields} ${kind === "pr" ? "headRefOid headRefName baseRefName state headRepository { nameWithOwner }" : ""}`;
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
          `query($id: ID!, $cursor: String) { node(id: $id) { ... on ${type} { ${identityFields} ${field}(first: 100, after: $cursor) { nodes { ${identityFields} ${field === "reviews" ? "state commit { oid }" : ""} } pageInfo { hasNextPage endCursor } } } } }`,
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
        (kind !== "pr" || !["--files", "--diff", "--reviews", "--checks"].includes(option)))
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
    const type = kind === "issue" ? "Issue" : "PullRequest";
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
    const output: string[] = [];
    if (option !== "--reviews") {
      const content = await this.node(String(item.id), "title body", type);
      const body = renderItem(content, this.filter, link);
      if (!body) {
        return "No accepted thread";
      }
      if (kind === "issue" && reference(ref, this.config).repo === String(this.config.repo)) {
        mkdirSync(resolve(this.root, ".tmp"), { recursive: true });
        writeFileSync(
          resolve(this.root, ".tmp", `issue-read-${reference(ref, this.config).number}.sha256`),
          bodyHash(String(content.body))
        );
      }
      output.push(body);
    }
    const field = option === "--reviews" ? "reviews" : "comments";
    if (field === "reviews" && kind !== "pr") {
      throw new Error("Reviews require a PR");
    }
    for (const meta of await this.collection(String(item.id), type, field)) {
      if (!this.filter.accept(meta, repoOf(meta).owner, link)) {
        continue;
      }
      const body = renderItem(
        await this.node(
          String(meta.id),
          "body",
          field === "reviews" ? "PullRequestReview" : "IssueComment"
        ),
        this.filter,
        link
      );
      if (body) {
        output.push(body);
      }
    }
    return output.join("\n\n") || "No accepted content";
  };

  post: Handlers["post"] = async ({ ref, file }) => {
    const target = reference(ref, this.config);
    const body = readFileSync(file, "utf8");
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    const { person } = await this.thread(ref, "any");
    // REST issue comments also support PRs, but the metadata query must accept both.
    if (!person) {
      throw new Error("Refusing to post on an unaccepted thread");
    }
    await this.github.rest(`/repos/${target.repo}/issues/${target.number}/comments`, "POST", {
      body,
    });
    return `Posted to ${target.link}`;
  };

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
    const { item, person } = await this.thread(ref, "pr");
    if (!person) {
      throw new Error("No accepted task PR");
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
    if (fetch) {
      if (
        !(await new GitTransport(this.config, this.env, this.deps, this.root).transfer("fetch", [
          `+refs/heads/${base}:refs/remotes/origin/${base}`,
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ]))
      ) {
        throw new Error("error: fetch failed");
      }
    }
    return { branch, base };
  };

  push: Handlers["push"] = async ({ worktree, branch, commit: selected }, ctx) => {
    if (
      selected !== undefined &&
      (ctx.role !== "orchestrator" || !/^[a-f\d]{40}$/i.test(selected))
    ) {
      throw new Error("Only orchestrators may push a frozen commit");
    }
    taskBranch(branch, this.config);
    if (!Number.isSafeInteger(ctx.taskPr) || Number(ctx.taskPr) < 1) {
      throw new Error("Push requires its own taskPr");
    }
    const task = await this.task({ ref: String(ctx.taskPr) }, ctx);
    if (selected && task.branch !== branch) {
      throw new Error("Frozen push must match its task PR branch");
    }
    if (ctx.role === "worker") {
      if (task.branch !== branch) {
        throw new Error("Worker may push only its own task branch");
      }
    }
    if (realpathSync(worktree) !== realpathSync(this.root)) {
      throw new Error("Push worktree must be the gateway checkout");
    }
    const git = new GitTransport(this.config, this.env, this.deps, resolve(worktree));
    const commit = (
      await git.run(
        "rev-parse",
        "--verify",
        selected ? `${selected}^{commit}` : `refs/heads/${branch}^{commit}`
      )
    ).trim();
    if (!/^[a-f\d]{40}$/i.test(commit)) {
      throw new Error("Invalid local commit");
    }
    const base = task.base;
    // Validate config refs before allowing them into fetch refspecs.
    validateBranch(base);
    if (!(await git.transfer("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
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
    if (!(await git.transfer("push", [`${commit}:refs/heads/${branch}`]))) {
      throw new Error("error: the remote branch moved: fetch and merge it (never force-push)");
    }
    await git.run("update-ref", `refs/remotes/origin/${branch}`, commit);
    return `pushed ${branch} at ${commit.slice(0, 7)}`;
  };

  ghRead: Handlers["ghRead"] = async ({ source }) => {
    const counts = { dropped: 0, redacted: 0 };
    if (source.endsWith(".graphql")) {
      const query = readQuery(readFileSync(source, "utf8"));
      const data = await this.github.graphql(query);
      const output = untrusted(
        JSON.stringify(
          filterDiagnostic(
            data,
            this.filter,
            String(this.config.repo),
            `https://github.com/${String(this.config.repo)}`,
            counts
          ),
          null,
          2
        ) ?? "null"
      );
      return `${output}\n${counts.dropped} items dropped by the people filter${counts.redacted ? `\n${counts.redacted} nested values redacted` : ""}`;
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
    return `${output}\n${counts.dropped} items dropped by the people filter${counts.redacted ? `\n${counts.redacted} nested values redacted` : ""}`;
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

  private async approvalFor(ref: string, historical?: string): Promise<boolean | "unknown"> {
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
        this.filter
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
    return isOwnerApproved(
      {
        headRefOid: historical ?? String(item.headRefOid),
        reviews,
        timeline,
        comments,
        boardNumber: Number(object(this.config.board).number),
        historical: historical !== undefined,
      },
      this.filter
    );
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
    issueEdit: server.issueEdit,
    scopeReview: server.scopeReview,
    issueClose: server.issueClose,
    boardSetIssue: server.boardSetIssue,
    worker: server.worker,
    grade: server.grade,
    costBackfill: server.costBackfill,
    suggestModel: server.suggestModel,
    workerAccess: server.workerAccess,
    openTask: server.openTask,
    reviewTask: server.reviewTask,
    askIssue: server.askIssue,
    mergeTask: server.mergeTask,
    linkTask: server.linkTask,
    releaseHold: server.releaseHold,
    workerStatus: server.workerStatus,
    nextEvents: server.nextEvents,
    watchMute: server.watchMute,
    watchUnmute: server.watchUnmute,
    watchMutes: server.watchMutes,
    waitChecks: server.waitChecks,
    checkTaskCi: server.checkTaskCi,
    refreshChecks: server.refreshChecks,
    verify: server.verify,
    boardStatus: server.boardStatus,
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
    issueEdit: ["orchestrator"],
    scopeReview: ["orchestrator"],
    issueClose: ["orchestrator"],
    boardSetIssue: ["orchestrator"],
    worker: ["orchestrator"],
    grade: ["orchestrator"],
    costBackfill: ["orchestrator"],
    suggestModel: ["orchestrator"],
    workerAccess: ["worker", "orchestrator"],
    openTask: ["orchestrator"],
    reviewTask: ["orchestrator"],
    askIssue: ["orchestrator"],
    mergeTask: ["orchestrator"],
    linkTask: ["orchestrator"],
    releaseHold: ["orchestrator"],
    workerStatus: ["orchestrator"],
    nextEvents: ["orchestrator"],
    watchMute: ["orchestrator"],
    watchUnmute: ["orchestrator"],
    watchMutes: ["orchestrator"],
    waitChecks: ["worker", "orchestrator"],
    checkTaskCi: ["orchestrator"],
    refreshChecks: ["orchestrator"],
    verify: ["orchestrator"],
    boardStatus: ["orchestrator"],
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
        (input as Operations["learnings"]["input"]).action === "submit" &&
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
        "Gateway operation denied for client role; check VMETHOD_ROLE and VMETHOD_TASK_PR in the command prefix"
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
          "Worker may post only to its own taskPr in the configured repository; use VMETHOD_ROLE=worker VMETHOD_TASK_PR=<assigned PR number> on every vmethod command"
        );
      }
    }
  });
}

export type ReadInput = Operations["read"]["input"];
