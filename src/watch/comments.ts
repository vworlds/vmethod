import { createHash } from "node:crypto";
import { hasRolePrefix, parseFirstLine, roundText } from "../core/protocol.js";
import { progressGuards } from "../core/progress.js";
import { restActor } from "../github/diagnostic.js";
import { pages } from "../github/pages.js";
import { reviewCommentFields } from "../github/selections.js";
import type { GitHubClient } from "../gateway/client.js";
import { object, type ObjectData, type PeopleFilter, type Person } from "../gateway/people.js";
import type { WriteJournal } from "../gateway/write-journal.js";
import type { LoopState, Marker } from "./state.js";

interface InlineComment {
  comment: ObjectData;
  inline: { person: Person; id: number; location: string };
}

/** Loop facilities shared with the other pollers; no EventLoop instance crosses this seam. */
interface CommentDeps {
  state: LoopState;
  github: GitHubClient;
  filter: PeopleFilter;
  writes: WriteJournal;
  own: string;
  subscriptions: readonly string[];
  preview: boolean;
  known: ReadonlySet<number>;
  subjectPreviews: Map<string, { title: string; person: Person | undefined }>;
  now(): number;
  /** Read live cycle/session values rather than capturing constructor-time baselines. */
  current(): {
    me: string | null;
    meId: number | null;
    firstRun: boolean;
    taskIssues: ReadonlyMap<number, number[]>;
  };
  isOwn(repo: string): boolean;
  inScope(number: number): boolean;
  trackOne(number: number): Promise<void>;
  readCursor(): string | null;
  restRead<T>(action: () => Promise<T>): Promise<T>;
  restPages<T>(path: (page: number) => string, collect: (data: unknown) => T[]): Promise<T[]>;
  marked(marker: Marker): boolean;
  mark(marker: Marker): void;
  pending(): { id: string }[];
  muted(repo: string, number: number): boolean;
  mentionsMe(body: string): boolean;
  unmuteThread(repo: string, number: number): void;
  touchActivity(number: number, at: string): void;
  conflictFixing?(number: number): boolean;
  queueProgress(
    number: number,
    change: {
      status?: string;
      state?: string | null;
      round?: number | null;
      if?: string[];
    }
  ): void;
  previewText(person: Person | undefined, text: string | undefined): string;
  ref(repo: string, number: number): string;
  threadUrl(repo: string, number: number, kind: "PR"): string;
  produceOnce(id: string, kind: string, line: string): boolean;
  quietOnce(id: string, line: string): void;
  sanitizeLine(text: string): string;
}

const CURSOR_OVERLAP_MS = 10 * 60_000;
const PAGE_LIMIT = 20;
const key = (text: string): string => createHash("md5").update(text).digest("hex").slice(0, 16);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): ObjectData[] => (Array.isArray(value) ? value.map(object) : []);

function count(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** Conversation and review replies form one chronological stream per repository.
 * The loop still owns step success and cursor advancement, including the settling poll.
 */
export class CommentStream {
  private cycleInlineComments: InlineComment[] = [];

  constructor(private readonly deps: CommentDeps) {}

  /** Discard staged inline replies at the same poll boundary as the other cycle caches. */
  beginPoll(): void {
    this.cycleInlineComments = [];
  }

  isSelf(comment: ObjectData): boolean {
    const id = count(restActor(comment.user).databaseId);
    return id !== null && id === this.deps.current().meId;
  }

  async pollComments(): Promise<void> {
    const cursor = this.deps.readCursor();
    const since = cursor
      ? new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString()
      : this.deps.state.listingBaseline.text() || new Date(this.deps.now()).toISOString();
    for (const repo of this.deps.subscriptions) {
      const incoming: { comment: ObjectData; inline?: InlineComment["inline"] }[] = this.deps.isOwn(
        repo
      )
        ? [...this.cycleInlineComments]
        : [];
      const comments = await this.deps.restPages(
        (page) =>
          `/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100&page=${page}`,
        (data) => list(data)
      );
      for (const comment of comments) {
        if (
          Date.parse(str(comment.created_at)) <=
          Date.parse(
            this.deps.state.listingBaseline.text() || (this.deps.current().firstRun ? since : "")
          )
        ) {
          this.deps.mark(this.deps.state.once(`c-${key(str(comment.html_url))}`));
          continue;
        }
        incoming.push({ comment });
      }
      // Conversation and inline comments share one chronological turn stream.
      for (const { comment, inline } of incoming.sort(
        (a, b) => Date.parse(str(a.comment.created_at)) - Date.parse(str(b.comment.created_at))
      )) {
        await this.processComment(repo, comment, inline);
      }
    }
  }

  async pollReviewThreads(number: number): Promise<void> {
    const [owner, name] = this.deps.own.split("/");
    const threads: ObjectData[] = [];
    for await (const connection of pages(
      async (cursor) => {
        const data = object(
          await this.deps.github.graphql(
            `query WatchReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id isResolved path line comments(first: 100) {
              pageInfo { hasNextPage endCursor } nodes { ${reviewCommentFields} }
            } }
          }
        } }
      }`,
            { owner, name, number, cursor }
          )
        );
        return object(object(data.repository).pullRequest).reviewThreads;
      },
      {
        connectionError: "Invalid review-thread connection",
        pageInfoError: "Invalid review-thread connection",
        cursorError: "Invalid review-thread cursor",
        nonempty: true,
        repeats: "previous",
        validateFirst: true,
        limit: PAGE_LIMIT,
        limitError: "Watcher review-thread pagination limit reached",
      }
    )) {
      threads.push(...list(connection.nodes));
    }
    const observed: string[] = [];
    const entries: { comment: ObjectData; thread: ObjectData; suppress: boolean }[] = [];
    for (const thread of threads) {
      if (
        !str(thread.id) ||
        typeof thread.isResolved !== "boolean" ||
        typeof thread.path !== "string" ||
        (thread.line !== null && count(thread.line) === null)
      ) {
        throw new Error("Invalid review-thread payload");
      }
      const comments = await this.reviewThreadComments(thread);
      const seen = `rt-${key(str(thread.id))}`;
      const suppress = thread.isResolved && !this.deps.marked(this.deps.state.once(seen));
      observed.push(seen);
      entries.push(...comments.map((comment) => ({ comment, thread, suppress })));
    }
    // Stage accepted replies; pollComments orders them together with conversation
    // comments before applying turns, independently of thread connection order.
    for (const { comment, thread, suppress } of entries) {
      const id = count(comment.databaseId);
      if (
        id === null ||
        !str(comment.createdAt) ||
        !Number.isFinite(Date.parse(str(comment.createdAt)))
      ) {
        throw new Error("Invalid inline comment payload");
      }
      const commentKey = `rc-${id}`;
      // Unlike cursor-window conversation markers, these IDs persist: the whole
      // reviewThreads connection is read again on subsequent polls and restarts.
      if (
        suppress ||
        Date.parse(str(comment.createdAt)) <= Date.parse(this.deps.state.listingBaseline.text())
      ) {
        this.deps.mark(this.deps.state.once(commentKey));
        continue;
      }
      if (
        this.deps.marked(this.deps.state.once(commentKey)) ||
        this.deps.pending().some((event) => event.id === commentKey)
      ) {
        continue;
      }
      const url = `${this.deps.threadUrl(this.deps.own, number, "PR")}#discussion_r${id}`;
      const person = this.deps.filter.accept(
        {
          ...comment,
          repository: {
            nameWithOwner: this.deps.own,
            owner: { login: owner },
          },
        },
        owner,
        url
      );
      if (!person) {
        continue;
      }
      this.cycleInlineComments.push({
        comment: {
          id,
          node_id: comment.id,
          html_url: url,
          issue_url: `https://api.github.com/repos/${this.deps.own}/issues/${number}`,
          user: { id: person.id, login: person.login, type: person.type },
          body: comment.body,
          created_at: comment.createdAt,
          updated_at: comment.lastEditedAt ?? comment.createdAt,
        },
        inline: {
          person,
          id,
          location: `${this.deps.sanitizeLine(str(thread.path))}:${String(thread.line)}`,
        },
      });
    }
    for (const seen of observed) {
      this.deps.mark(this.deps.state.once(seen));
    }
  }

  readReview(number: number): { at: string; id: string } | null {
    const parsed = this.deps.state.pr(number).review.read();
    return typeof parsed.at === "string" && typeof parsed.id === "string"
      ? { at: parsed.at, id: parsed.id }
      : null;
  }

  /** First run records the current comments of each task PR: activity and my last review. */
  async seedPrComments(number: number): Promise<void> {
    const comments = await this.deps.restPages(
      (page) =>
        `/repos/${this.deps.own}/issues/${number}/comments?per_page=100&sort=created&direction=desc&page=${page}`,
      (data) => list(data)
    );
    for (const comment of comments) {
      const created = str(comment.created_at);
      if (!created) {
        continue;
      }
      this.deps.touchActivity(number, created);
      this.rememberWorkerProtocol(number, comment, this.deps.own);
      if (this.isSelf(comment)) {
        const first = str(comment.body).split(/\r?\n/)[0];
        this.rememberWorkerPrompt(number, first, created, str(comment.html_url));
      }
    }
  }

  private async processComment(
    repo: string,
    comment: ObjectData,
    inline?: InlineComment["inline"]
  ): Promise<void> {
    const number = count(str(comment.issue_url).split("/").at(-1));
    const url = str(comment.html_url);
    const body = str(comment.body);
    const created = str(comment.created_at);
    const login = str(object(comment.user).login);
    if (number === null || !url || !created) {
      throw new Error("Invalid comment payload");
    }
    const own = this.deps.isOwn(repo);
    if (own && !this.deps.known.has(number)) {
      await this.deps.trackOne(number);
    }
    if (own && !this.deps.inScope(number)) {
      return;
    }
    let person =
      inline?.person ??
      this.deps.filter.accept(
        {
          author: restActor(comment.user),
          editor: null,
          lastEditedAt: null,
          repository: { nameWithOwner: repo, owner: { login: repo.split("/")[0] } },
        },
        repo.split("/")[0],
        url
      );
    if (!person && !this.isSelf(comment)) {
      return;
    }
    const commentKey = inline ? `rc-${inline.id}` : `c-${key(url)}`;
    if (
      !this.isSelf(comment) &&
      (this.deps.marked(this.deps.state.once(commentKey)) ||
        this.deps.pending().some((event) => event.id === commentKey))
    ) {
      return;
    }
    if (this.deps.muted(repo, number)) {
      if (this.deps.mentionsMe(body)) {
        this.deps.unmuteThread(repo, number);
      } else {
        return;
      }
    }
    const firstLine = body.split(/\r?\n/)[0];
    const edited =
      created !== str(comment.updated_at)
        ? inline
          ? " (edited)"
          : " (edited: verify editor)"
        : "";
    const taskPr = own && this.deps.marked(this.deps.state.pr(number).open);
    if (taskPr) {
      // Task PRs always belong to the configured repository; the role is per repo (#186).
      this.rememberWorkerProtocol(number, comment, repo);
    }
    const selfWrite =
      this.isSelf(comment) &&
      this.deps.writes.matches(
        {
          kind: inline ? "review-comment" : "comment",
          repo,
          number,
          ...(count(comment.id) !== null ? { commentId: Number(comment.id) } : {}),
          ...(typeof comment.node_id === "string" ? { nodeId: comment.node_id } : {}),
        },
        created
      );
    if (this.isSelf(comment)) {
      // Only the watching orchestrator's own comments are skipped; matched by id.
      if (taskPr) {
        this.deps.touchActivity(number, created);
        this.rememberWorkerPrompt(number, firstLine, created, url);
      }
      // Separate from delivery acknowledgement: even journaled own comments
      // must apply Progress once, but never replay it over a later human move.
      const progressKey = inline ? `rc-progress-${inline.id}` : `c-${key(`progress:${url}`)}`;
      if (
        own &&
        !this.deps.marked(this.deps.state.once(progressKey)) &&
        parseFirstLine(firstLine, { role: "orchestrator", tags: ["ANSWER", "GO"] })
      ) {
        this.deps.queueProgress(number, {
          state: taskPr ? "working" : null,
          ...(taskPr ? { status: "Executing" } : {}),
        });
        this.deps.mark(this.deps.state.once(progressKey));
      }
      if (
        own &&
        !edited &&
        !this.deps.marked(this.deps.state.once(progressKey)) &&
        parseFirstLine(firstLine, {
          role: "orchestrator",
          tags: ["OWNER QUESTION", "OWNER REVIEW"],
        })
      ) {
        this.deps.queueProgress(number, {
          state: firstLine.includes("QUESTION") ? "owner-question" : "owner-review",
          ...(taskPr
            ? { status: firstLine.includes("QUESTION") ? "Executing" : "Owner review" }
            : {}),
        });
        this.deps.mark(this.deps.state.once(progressKey));
      }
      if (selfWrite) {
        return;
      }
      person ??= {
        login: this.deps.current().me ?? login,
        id: this.deps.current().meId!,
        type: "User",
        role: "orchestrator",
        repos: [this.deps.own],
      };
    }
    if (!person) {
      return;
    }
    if (
      own &&
      (!edited || inline) &&
      person.role === "owner" &&
      !hasRolePrefix(firstLine, "orchestrator")
    ) {
      let linked = false;
      for (const [pr, issues] of this.deps.current().taskIssues) {
        if (issues.includes(number)) {
          linked = true;
          this.deps.queueProgress(pr, { state: "verifying" });
        }
      }
      if (!linked) {
        this.deps.queueProgress(number, { state: "verifying" });
      }
    }
    if (taskPr && person.role === "worker") {
      this.deps.touchActivity(number, created);
      if (!this.deps.conflictFixing?.(number)) {
        this.deps.queueProgress(number, { state: "working", if: progressGuards.revive });
      }
    }
    let subject = this.deps.subjectPreviews.get(`${repo.toLowerCase()}#${number}`);
    if (this.deps.preview && !subject) {
      const item = object(
        await this.deps.restRead(() => this.deps.github.rest(`/repos/${repo}/issues/${number}`))
      );
      subject = { title: str(item.title), person };
      this.deps.subjectPreviews.set(`${repo.toLowerCase()}#${number}`, subject);
    }
    const preview = edited
      ? ""
      : this.deps.previewText(person, `${subject?.title ?? ""} ${firstLine}`);
    const commentLine = `COMMENT ${this.deps.ref(repo, number)}${inline ? ` ${inline.location}` : ""} from ${login} (${person.role})${this.isSelf(comment) ? " (this account, another session)" : ""}${edited}${preview} ${url}`;
    // REST cannot identify the editor. Wake for verification, never execute an edited tag.
    const workerTag = edited
      ? null
      : parseFirstLine(firstLine, {
          role: "worker",
          tags: ["READY", "QUESTION", "DESIGN", "BLOCKED", "HANDOFF"],
        });
    const round = roundText(firstLine);
    if (taskPr && person.role === "worker" && workerTag) {
      if (
        this.deps.produceOnce(
          commentKey,
          inline ? "comment" : workerTag.tag.toLowerCase(),
          inline
            ? commentLine
            : `PR #${number} (${this.deps.state.pr(number).branch.text()}): worker ${workerTag.tag}${round ? ` (round ${round})` : ""} from ${login} (${person.role})${preview} ${url}`
        )
      ) {
        this.deps.touchActivity(number, created);
        // A dispatched fixer's protocol turn must not move the resolution's card.
        if (!this.deps.conflictFixing?.(number)) {
          if (workerTag.tag === "READY") {
            this.deps.queueProgress(number, {
              status: "Executing",
              state: "ready",
              ...(round ? { round: count(round) } : {}),
            });
          } else {
            this.deps.queueProgress(number, { state: workerTag.tag.toLowerCase() });
          }
        }
      }
      return;
    }
    if (
      !inline &&
      !edited &&
      hasRolePrefix(firstLine, "worker") &&
      person.role === "worker" &&
      !workerTag
    ) {
      this.deps.touchActivity(number, created);
      if (taskPr) {
        if (!this.deps.conflictFixing?.(number)) {
          this.deps.queueProgress(number, { state: "working", if: progressGuards.revive });
        }
        this.deps.quietOnce(
          `c-${key(url)}`,
          `NOTE PR #${number} (${this.deps.state.pr(number).branch.text()}): worker note from ${login} (${person.role})${preview} ${url}`
        );
      } else {
        this.deps.quietOnce(
          `c-${key(url)}`,
          `NOTE ${this.deps.ref(repo, number)}: worker note from ${login} (${person.role})${preview} ${url}`
        );
      }
      return;
    }
    // Peer orchestrators wake on our threads too: a peer may ask, never approve.
    if (this.deps.produceOnce(commentKey, "comment", commentLine) && taskPr) {
      this.deps.touchActivity(number, created);
    }
  }

  private rememberWorkerPrompt(number: number, firstLine: string, at: string, id: string): void {
    // This historical prefix reader accepts arbitrary tags, but requires a literal space.
    if (!hasRolePrefix(firstLine, "orchestrator") || firstLine["[orchestrator]".length] !== " ") {
      return;
    }
    const previous = this.deps.state.pr(number).prompt.read();
    if (at >= str(previous.at)) {
      this.deps.state.pr(number).prompt.write({ at, id });
    }
  }

  /** Persist the newest verified worker reply tag, independently of activity/CI. */
  private rememberWorkerProtocol(number: number, comment: ObjectData, repo: string): void {
    const at = str(comment.created_at);
    if (!at) {
      return;
    }
    const person = this.deps.filter.identity(restActor(comment.user));
    const role = this.isSelf(comment)
      ? "orchestrator"
      : person
        ? this.deps.filter.roleIn(person, repo)
        : undefined;
    if (at !== str(comment.updated_at)) {
      return;
    }
    const first = str(comment.body).split(/\r?\n/)[0];
    const requestTag =
      role === "worker"
        ? parseFirstLine(first, { role: "worker", tags: ["READY", "QUESTION", "BLOCKED"] })?.tag
        : undefined;
    const reply =
      role === "orchestrator" &&
      parseFirstLine(first, {
        role: "orchestrator",
        tags: ["REVIEW", "OWNER REVIEW", "ANSWER", "AMENDMENT", "GO"],
      });
    if (requestTag || reply) {
      const previous = this.deps.state.pr(number).unhandledWorker.read();
      if (at >= str(previous.at)) {
        this.deps.state.pr(number).unhandledWorker.write({
          at,
          ...(requestTag ? { tag: requestTag } : { handled: true }),
        });
      }
    }
    let active: boolean;
    let workerTag: string | undefined;
    if (role === "worker") {
      workerTag = parseFirstLine(first, {
        role: "worker",
        tags: ["READY", "QUESTION", "BLOCKED", "DESIGN", "HANDOFF"],
      })?.tag;
      active = !workerTag;
    } else if (
      role === "orchestrator" &&
      parseFirstLine(first, {
        role: "orchestrator",
        tags: ["REVIEW", "CHANGES", "ANSWER", "AMENDMENT", "GO"],
      })
    ) {
      active = true;
      if (at >= (this.readReview(number)?.at ?? "")) {
        this.deps.state.pr(number).review.write({ at, id: str(comment.html_url) });
      }
    } else if (role === "owner") {
      active = true;
    } else {
      return;
    }
    const previous = this.deps.state.pr(number).protocol.read();
    if (at >= str(previous.at)) {
      this.deps.state
        .pr(number)
        .protocol.write({ at, active, role, ...(workerTag ? { tag: workerTag } : {}) });
      this.deps.touchActivity(number, at);
    }
  }

  private async reviewThreadComments(thread: ObjectData): Promise<ObjectData[]> {
    const comments: ObjectData[] = [];
    for await (const connection of pages(
      async (cursor) => {
        if (cursor === null) {
          return thread.comments;
        }
        const data = object(
          await this.deps.github.graphql(
            `query WatchReviewThreadComments($id: ID!, $cursor: String!) {
        node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor } nodes { ${reviewCommentFields} }
        } } }
      }`,
            { id: thread.id, cursor }
          )
        );
        return object(data.node).comments;
      },
      {
        connectionError: "Invalid review-thread connection",
        pageInfoError: "Invalid review-thread connection",
        cursorError: "Invalid review-thread cursor",
        nonempty: true,
        repeats: "previous",
        validateFirst: true,
        limit: PAGE_LIMIT,
        limitError: "Watcher inline-comment pagination limit reached",
      }
    )) {
      comments.push(...list(connection.nodes));
    }
    return comments;
  }
}
