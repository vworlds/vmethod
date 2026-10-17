import { readFileSync } from "node:fs";
import { getConfig, loadYaml, type Config } from "../config.js";
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
import { inProcess, type Handlers, type Operations, type Transport } from "./transport.js";
import { isOwnerApproved } from "./approval.js";
import { GitTransport, taskBranch, validateBranch } from "./git.js";
import { realpathSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { BoardService } from "./board.js";
import { ChecksService } from "./checks.js";
import { VerificationService } from "./verify.js";
import { reference } from "./refs.js";

class GatewayServer {
  private readonly config: Config;
  private readonly filter: PeopleFilter;
  private readonly digest: Digest;
  // Lazy: local digest reads and refused operations never need credentials.
  private client?: GitHubClient;
  private boardClient?: BoardService;

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

  boardStatus: Handlers["boardStatus"] = async () => this.board.status();
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
  boardArchive: Handlers["boardArchive"] = async ({ itemId }) => this.board.archive(itemId);

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
      const body = renderItem(
        await this.node(String(item.id), "title body", type),
        this.filter,
        link
      );
      if (!body) {
        return "No accepted thread";
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

  waitReview: Handlers["waitReview"] = async ({ ref, pollSeconds }) => {
    if (!Number.isFinite(pollSeconds) || pollSeconds <= 0 || pollSeconds > 86400) {
      throw new Error("poll-seconds must be between 0 and 86400");
    }
    for (;;) {
      try {
        const { item, person, link } = await this.thread(ref, "pr");
        if (!person) {
          throw new Error("No accepted task PR");
        }
        if (!["OPEN", "CLOSED", "MERGED"].includes(String(item.state))) {
          throw new Error("Invalid PR state");
        }
        if (item.state !== "OPEN") {
          return `PR #${reference(ref, this.config).number} is ${String(item.state)}: you are dismissed`;
        }
        const comments: {
          body: string;
          date: string;
          role: string;
          rendered: string;
        }[] = [];
        for (const meta of await this.collection(String(item.id), "PullRequest", "comments")) {
          if (!this.filter.accept(meta, repoOf(meta).owner, link)) {
            continue;
          }
          const comment = await this.node(String(meta.id), "body createdAt", "IssueComment");
          const author = this.filter.accept(comment, repoOf(comment).owner, link);
          const original = this.filter.identity(comment.author);
          if (
            !author ||
            original?.role !== author.role ||
            typeof comment.body !== "string" ||
            typeof comment.createdAt !== "string" ||
            !Number.isFinite(Date.parse(comment.createdAt))
          ) {
            continue;
          }
          comments.push({
            body: comment.body,
            date: String(comment.lastEditedAt ?? comment.createdAt),
            role: author.role,
            rendered: labelled(author, comment.body),
          });
        }
        const mine =
          comments
            .filter((comment) => comment.role === "worker" && comment.body.startsWith("[worker]"))
            .map((comment) => comment.date)
            .sort()
            .at(-1) ?? "";
        const replies = comments
          .filter(
            (comment) =>
              comment.role === "orchestrator" &&
              comment.body.startsWith("[orchestrator]") &&
              comment.date > mine
          )
          .sort((a, b) => a.date.localeCompare(b.date));
        if (replies.length) {
          return replies.map((comment) => comment.rendered).join("\n\n---\n\n");
        }
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("GitHub ")) {
          throw error;
        }
        this.deps.report("wait-review: GitHub read failed; retrying after poll interval");
      }
      await this.deps.sleep(pollSeconds * 1000);
    }
  };

  ghRead: Handlers["ghRead"] = async ({ source }) => {
    if (source.endsWith(".graphql")) {
      const query = readQuery(readFileSync(source, "utf8"));
      const data = await this.github.graphql(query);
      return untrusted(
        JSON.stringify(
          filterDiagnostic(
            data,
            this.filter,
            String(this.config.repo),
            `https://github.com/${String(this.config.repo)}`
          ),
          null,
          2
        ) ?? "null"
      );
    }
    // Only scoped repository endpoints. No URLs, alternate methods, redirects or encoded paths.
    const match =
      /^\/?repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[A-Za-z0-9_./-]+)?(?:\?([A-Za-z0-9_=&,.-]+))?$/.exec(
        source
      );
    if (
      !match ||
      source.includes("..") ||
      match[1].toLowerCase() !== String(this.config.org).toLowerCase()
    ) {
      throw new Error(
        "gh-read permits scoped repository GET endpoints or a query .graphql file only"
      );
    }
    const repo = `${match[1]}/${match[2]}`;
    const data = await this.github.rest(source.startsWith("/") ? source : `/${source}`);
    return untrusted(
      JSON.stringify(
        filterDiagnostic(data, this.filter, repo, `https://github.com/${repo}`),
        null,
        2
      ) ?? "null"
    );
  };

  dropped: Handlers["dropped"] = async ({ since }) => this.digest.read(since);

  ownerApproved: Handlers["ownerApproved"] = async ({ ref }) => {
    const { item, person } = await this.thread(ref, "pr");
    if (!person) {
      return false;
    }
    const reviews = await this.collection(String(item.id), "PullRequest", "reviews");
    // A review is authoritative without needing a usable project timeline API.
    if (
      isOwnerApproved(
        {
          headRefOid: String(item.headRefOid),
          reviews,
          timeline: [],
          comments: [],
          boardNumber: Number(object(this.config.board).number),
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
        headRefOid: String(item.headRefOid),
        reviews,
        timeline,
        comments,
        boardNumber: Number(object(this.config.board).number),
      },
      this.filter
    );
  };
}

export function createGateway(root: string, env: NodeJS.ProcessEnv, deps: Dependencies): Transport {
  const server = new GatewayServer(root, env, deps);
  const config = getConfig(root, env);
  const handlers: Handlers = {
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
    waitReview: server.waitReview,
    ghRead: server.ghRead,
    dropped: server.dropped,
    ownerApproved: server.ownerApproved,
  };
  const policy = {
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
    task: ["worker", "orchestrator"],
    waitReview: ["worker", "orchestrator"],
    ghRead: ["orchestrator"],
    dropped: ["orchestrator"],
    ownerApproved: ["orchestrator"],
  } as const;
  return inProcess(handlers, (operation, input, ctx) => {
    if (
      !ctx ||
      !Object.hasOwn(policy, operation) ||
      !(policy[operation] as readonly string[]).includes(ctx.role)
    ) {
      throw new Error("Gateway operation denied for client role");
    }
    if (ctx.role === "worker" && ["post", "task", "waitReview", "waitChecks"].includes(operation)) {
      const target = reference((input as Operations["post"]["input"]).ref, config);
      if (
        !Number.isSafeInteger(ctx.taskPr) ||
        Number(ctx.taskPr) < 1 ||
        target.number !== ctx.taskPr ||
        target.repo.toLowerCase() !== String(config.repo).toLowerCase()
      ) {
        throw new Error("Worker may post only to its own taskPr in the configured repository");
      }
    }
  });
}

export type ReadInput = Operations["read"]["input"];
