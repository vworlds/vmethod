import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { GitHubHttpError } from "../client.js";
import {
  labelled,
  object,
  untrusted,
  checkFacts,
  type ObjectData,
  type Person,
} from "../people.js";
import { renderItem, repoOf, restActor } from "../../github/diagnostic.js";
import { identityFields } from "../../github/selections.js";
import { pages } from "../../github/pages.js";
import { checkMarkdown, guardClosingKeywords } from "../markdown.js";
import { bodyHash } from "../../evidence/scope.js";
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
} from "../thread.js";
import { ownerReplyProgress } from "../../core/progress.js";
import { resolve } from "node:path";
import { reference, type ThreadRef } from "../refs.js";
import type { GatewayServices } from "../server.js";
import type { Handler } from "./types.js";
import type { ReadInput } from "../server.js";

export const read: Handler<"read"> = async function ({ kind, ref, option }) {
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
export const post: Handler<"post"> = async function ({ ref, file, replyTo }, ctx) {
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
    target.repo === this.config.repo &&
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

export async function flowThread(
  this: GatewayServices,
  ref: string,
  kind: "pr" | "issue"
): Promise<ObjectData> {
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

export async function flowComments(
  this: GatewayServices,
  id: string,
  type: "Issue" | "PullRequest" = "PullRequest"
): Promise<ObjectData[]> {
  const output: ObjectData[] = [];
  for (const meta of await this.collection(id, type, "comments")) {
    const author = this.filter.identity(meta.author);
    if (!author || this.filter.roleIn(author, this.config.repo) !== "orchestrator") {
      continue;
    }
    const comment = await this.node(String(meta.id), "body createdAt url", "IssueComment");
    const effective = this.filter.accept(
      comment,
      repoOf(comment).owner,
      `https://github.com/${this.config.repo}`
    );
    if (
      this.filter.identity(comment.author)?.role === "orchestrator" &&
      effective &&
      this.filter.roleIn(effective, this.config.repo) === "orchestrator"
    ) {
      output.push(comment);
    }
  }
  return output;
}

/**
 * The comment with this REST id: its verified pinned author (an editor replaces the
 * author, as PeopleFilter.accept decides for delivery), its issue number and the
 * body's first line. Only ever the protocol tag of a write verb's target leaves
 * this process, so unknown authors return undefined without a digest drop.
 */
export async function flowComment(
  this: GatewayServices,
  id: string
): Promise<{ author: Person; issue: number; firstLine: string } | undefined> {
  let comment: ObjectData;
  try {
    comment = object(await this.github.rest(`/repos/${this.config.repo}/issues/comments/${id}`));
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
    repoOf(node).repo !== this.config.repo ||
    !Number.isSafeInteger(issue) ||
    Number(issue) < 1
  ) {
    return undefined;
  }
  return {
    author: { ...author, role: this.filter.roleIn(author, this.config.repo) },
    issue: Number(issue),
    firstLine: typeof node.body === "string" ? node.body.split(/\r?\n/)[0] : "",
  };
}

export async function node(
  this: GatewayServices,
  id: string,
  fields: string,
  type: string
): Promise<ObjectData> {
  const result = object(
    await this.github.graphql(
      `query($id: ID!) { node(id: $id) { ... on ${type} { ${identityFields} ${fields} } } }`,
      { id }
    )
  );
  return object(result.node);
}

export async function thread(
  this: GatewayServices,
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

export async function collection(
  this: GatewayServices,
  id: string,
  type: string,
  field: "comments" | "reviews"
): Promise<ObjectData[]> {
  const nodes: ObjectData[] = [];
  let rejected = false;
  for await (const connection of pages(
    async (cursor) => {
      const result = object(
        await this.github.graphql(
          `query($id: ID!, $cursor: String) { node(id: $id) { ... on ${type} { ${identityFields} ${field}(first: 100, after: $cursor) { nodes { ${identityFields} ${field === "reviews" ? "submittedAt state commit { oid }" : ""} } pageInfo { hasNextPage endCursor } } } } }`,
          { id, cursor }
        )
      );
      return object(result.node);
    },
    {
      connectionError: "Missing GitHub connection nodes",
      cursorError: "Invalid GitHub pagination cursor",
      stop: (parent) => {
        const scope = repoOf(parent);
        const link = `https://github.com/${scope.repo || this.config.repo}`;
        rejected = !this.filter.accept(parent, scope.owner, link);
        return rejected;
      },
      connection: (parent) => parent[field],
    }
  )) {
    for (const node of connection.nodes) {
      nodes.push(object(node));
    }
  }
  return rejected ? [] : nodes;
}

/** The pull request's review comments, one listing per resolved review thread; item
 * identity is filtered per comment exactly like the conversation comments. */
export async function reviewThreadComments(
  this: GatewayServices,
  prId: string
): Promise<ObjectData[]> {
  const comments: ObjectData[] = [];
  for await (const connection of pages(
    async (cursor) => {
      const result = object(
        await this.github.graphql(
          `query($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequest { reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { comments(first: 100) { nodes { ${identityFields} } pageInfo { hasNextPage endCursor } } } } } } }`,
          { id: prId, cursor }
        )
      );
      return object(result.node).reviewThreads;
    },
    {
      connectionError: "Missing GitHub connection nodes",
      cursorError: "Invalid GitHub pagination cursor",
    }
  )) {
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
  }
  return comments;
}

/** One thread item's body read: verified identity, REST id, time and fenced body. */
export async function threadEntry(
  this: GatewayServices,
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
export async function prThread(
  this: GatewayServices,
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
export async function issueThread(
  this: GatewayServices,
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
  if (target.repo === this.config.repo) {
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
export async function threadReport(
  this: GatewayServices,
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
  const base = snapshotBase(target, this.config.repo);
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

export async function checks(
  this: GatewayServices,
  item: ObjectData,
  link: string
): Promise<string> {
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

export async function ownerReplyTurn(
  this: GatewayServices,
  item: ObjectData,
  link: string
): Promise<boolean> {
  if (this.config.board?.enabled === false) {
    return false;
  }
  const board = this.board;
  const snapshot = await board.snapshot();
  const card = (await board.cards(snapshot.id)).find((card) => card.contentId === item.id);
  if (
    !card ||
    !["Owner review", "Executing"].includes(String(card.values.Status)) ||
    (!ownerReplyProgress(card.values.Progress, String(card.values.Status)) &&
      !card.assignees.some((login) =>
        this.filter.people.some(
          (person) =>
            this.filter.roleIn(person, this.config.repo) === "orchestrator" &&
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
