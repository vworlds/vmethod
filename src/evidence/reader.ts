import { autopilotHead, heading, parseFirstLine } from "../core/protocol.js";
import type { Config } from "../config.js";
import type { BoardService } from "../gateway/board.js";
import type { GitHubClient } from "../gateway/client.js";
import { object, type ObjectData, type PeopleFilter, type Person } from "../gateway/people.js";
import { reference } from "../gateway/refs.js";
import { taskIssueNumbers } from "../gateway/task-flow-types.js";
import { repoOf } from "../github/diagnostic.js";
import { pages } from "../github/pages.js";
import { actorFields, identityFields } from "../github/selections.js";
import { approvalRefusal, isOwnerApproved } from "./approval.js";
import { AutopilotReader, type AutopilotState } from "./autopilot.js";
import { isModelApproved } from "./model-gate.js";
import { ownerAgreement } from "./owner-agreement.js";
import { ScopeReader, legacyScopeCutoff } from "./scope.js";

/** Shared gateway reads retain their existing request shapes and identity checks. */
export interface EvidenceHost {
  board(): BoardService;
  thread(
    ref: string,
    kind: "pr" | "issue"
  ): Promise<{ item: ObjectData; link: string; person?: Person }>;
  node(id: string, fields: string, type: string): Promise<ObjectData>;
  collection(id: string, type: string, field: "comments" | "reviews"): Promise<ObjectData[]>;
  flowThread(ref: string, kind: "pr" | "issue"): Promise<ObjectData>;
  flowComments(id: string, type?: "Issue" | "PullRequest"): Promise<ObjectData[]>;
  projectCard(item: ObjectData): ObjectData;
}

/** Recompute approval, delegation, scope and model gates from fresh, filtered evidence.
 * No result is cached: historical approvals never substitute for a current grant. */
export class EvidenceReader {
  constructor(
    private readonly github: GitHubClient,
    private readonly filter: PeopleFilter,
    private readonly config: Config,
    private readonly host: EvidenceHost
  ) {}

  /** Current or exact historical-head approval; unverifiable evidence stays unknown. */
  async approvalFor(
    ref: string,
    historical?: string,
    explain?: (reason: string) => void
  ): Promise<boolean | "unknown"> {
    const { item, person } = await this.host.thread(ref, "pr");
    if (!person) {
      return false;
    }
    const reviews = await this.host.collection(String(item.id), "PullRequest", "reviews");
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
      const current = await this.host.thread(ref, "pr");
      return current.person && current.item.headRefOid === item.headRefOid ? true : "unknown";
    }
    const comments: ObjectData[] = [];
    const target = reference(ref, this.config);
    for (const meta of await this.host.collection(String(item.id), "PullRequest", "comments")) {
      const person = this.filter.accept(meta, repoOf(meta).owner, target.link);
      if (
        person?.role !== "orchestrator" ||
        this.filter.identity(meta.author)?.role !== "orchestrator"
      ) {
        continue;
      }
      const comment = await this.host.node(String(meta.id), "body createdAt", "IssueComment");
      if (
        this.filter.accept(comment, repoOf(comment).owner, target.link)?.role === "orchestrator"
      ) {
        comments.push(comment);
      }
    }
    // Timeline shape is normalized here; current card status is never queried.
    const timeline: ObjectData[] = [];
    let stopped: false | "unknown" | undefined;
    for await (const connection of pages(
      async (cursor) => {
        const data = object(
          await this.github.graphql(
            `query($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequest { ${identityFields} headRefOid timelineItems(first: 100, after: $cursor, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]) { nodes { __typename ... on ProjectV2ItemStatusChangedEvent { actor { ${actorFields} } status previousStatus createdAt project { number } } } pageInfo { hasNextPage endCursor } } } } }`,
            { id: item.id, cursor }
          )
        );
        return object(data.node);
      },
      {
        connectionError: "Missing timeline nodes",
        cursorError: "Invalid timeline pagination cursor",
        stop: (parent) => {
          if (!this.filter.accept(parent, repoOf(parent).owner, reference(ref, this.config).link)) {
            stopped = false;
            return true;
          }
          if (parent.headRefOid !== item.headRefOid) {
            stopped = "unknown";
            return true;
          }
          return false;
        },
        connection: (parent) => parent.timelineItems,
      }
    )) {
      for (const node of connection.nodes) {
        timeline.push({ ...object(node), field: "Status" });
      }
    }
    if (stopped !== undefined) {
      return stopped;
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
      const delegated = comments.filter((comment) => autopilotHead(String(comment.body)));
      const state = delegated.length
        ? await this.autopilotFor(await this.host.flowThread(ref, "pr"))
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

  /** Historical exact-head review evidence never replaces a current delegation. */
  async autopilotApprovalFor(ref: string, head: string): Promise<boolean> {
    const pr = await this.host.flowThread(ref, "pr");
    const state = await this.autopilotFor(pr);
    const reviews = (await this.host.flowComments(String(pr.id))).filter((comment) =>
      String(comment.body).startsWith(`${heading("AUTOPILOT APPROVED")}\n\nCurrent head: ${head}\n`)
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

  /** Read live delegation, including the task issues that may supply a copied grant. */
  async autopilotFor(item: ObjectData): Promise<AutopilotState> {
    const items = [item];
    if (item.__typename === "PullRequest") {
      for (const issue of taskIssueNumbers(String(item.body)) ?? []) {
        items.push(await this.host.flowThread(String(issue), "issue"));
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

  /** Candidate heads still need the approval-carry proofs before use. */
  async candidates(ref: string): Promise<string[]> {
    const { item, person } = await this.host.thread(ref, "pr");
    if (!person) {
      return [];
    }
    const candidates = new Set<string>();
    for (const review of await this.host.collection(String(item.id), "PullRequest", "reviews")) {
      if (
        this.filter.identity(review.author)?.role === "owner" &&
        (review.lastEditedAt == null || this.filter.identity(review.editor)?.role === "owner") &&
        review.state === "APPROVED"
      ) {
        const head = object(review.commit).oid;
        if (typeof head === "string" && /^[a-f\d]{40}$/i.test(head)) {
          candidates.add(head);
        }
      }
    }
    for (const comment of await this.host.flowComments(String(item.id))) {
      const delegated = autopilotHead(String(comment.body));
      if (delegated) {
        candidates.add(delegated);
      }
      if (
        parseFirstLine(String(comment.body), {
          role: "orchestrator",
          tags: ["OWNER REVIEW"],
          boundary: "whitespace",
        })
      ) {
        for (const head of String(comment.body).match(/\b[a-f\d]{40}\b/gi) ?? []) {
          candidates.add(head);
        }
      }
    }
    return [...candidates];
  }

  /** The verifiable owner gate (#218): a `gate: owner` family honorably launches or
   * switches only when the task issue or task PR carries the owner's
   * `APPROVE MODEL <family>` comment, posted after the issue body's last edit and
   * verified by identity, not display name. #242 adds the card path: the owner's own
   * Model value on the issue's or task PR's board card counts through the value's
   * recorded creator, while a value written by anyone else never counts. */
  async modelApproval(family: string, task: { pr?: number; issue?: number }): Promise<boolean> {
    let since: number | undefined;
    if (task.issue !== undefined) {
      const { item, link, person } = await this.host.thread(String(task.issue), "issue");
      if (!person) {
        throw new Error("No accepted task issue");
      }
      // Re-read edit times so the bound is the issue's current body state
      // (identityFields already carries lastEditedAt).
      const current = await this.host.node(String(item.id), "createdAt", "Issue");
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
      const { item, link, person } = await this.host.thread(String(task.pr), "pr");
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

  /** Bind an exact quotation to a verified owner comment after the summons. */
  async ownerAgreed(
    ref: string,
    url: string,
    since: number,
    handback: string,
    kind: "pr" | "issue" = "pr"
  ): Promise<boolean> {
    const match =
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/([1-9]\d*)#issuecomment-([1-9]\d*)$/.exec(
        url
      );
    if (!match || match[1] !== String(this.config.repo) || match[2] !== ref) {
      return false;
    }
    const item = await this.host.flowThread(ref, kind);
    const comments = await this.ownerModelComments(
      String(item.id),
      kind === "issue" ? "Issue" : "PullRequest",
      url
    );
    return comments.some((comment) =>
      ownerAgreement(comment, this.filter, String(this.config.repo), ref, url, since, handback)
    );
  }

  /** The batched scope read for one issue; open-task and merge-task's approval checks
   * share it, so the edit-time warning and the merge gate see the same evidence. */
  async scopeState(item: ObjectData) {
    return (
      await new ScopeReader(
        this.github,
        this.filter,
        this.config,
        object(this.config.board).enabled === false
          ? Infinity
          : legacyScopeCutoff((await this.host.board().snapshot()).readme)
      ).read([String(item.id)])
    ).get(String(item.id));
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
    const data = await this.host.node(String(item.id), fields, type);
    if (!this.filter.accept(data, repoOf(data).owner, link)) {
      throw new Error("Task identity changed during read");
    }
    if (object(object(data.projectItems).pageInfo).hasNextPage === true) {
      throw new Error("Too many project memberships; refusing incomplete metadata");
    }
    const card = object(this.host.projectCard(data).fieldValues);
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

  /** One thread's verified-owner comments: bodies are read only after the effective
   * author (author, or an edited comment's editor) identifies as the pinned owner,
   * so foreign approval text never leaves the people filter. */
  private async ownerModelComments(
    id: string,
    type: "Issue" | "PullRequest",
    link: string
  ): Promise<ObjectData[]> {
    const output: ObjectData[] = [];
    for (const meta of await this.host.collection(id, type, "comments")) {
      if (this.filter.accept(meta, repoOf(meta).owner, link)?.role !== "owner") {
        continue;
      }
      const comment = await this.host.node(
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
}
