import { containsScopeHeading, heading } from "../../core/protocol.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { assertEstimate } from "../../board/estimate.js";
import { object, type ObjectData } from "../people.js";
import { repoOf } from "../../github/diagnostic.js";
import { identityFields } from "../../github/selections.js";
import { pages } from "../../github/pages.js";
import {
  checkMarkdown,
  guardClosingKeywords,
  guardDependencyText,
  guardProtocolHeader,
} from "../markdown.js";
import { bodyHash } from "../../evidence/scope.js";
import { taskIssueNumbers } from "../../tasks/markers.js";
import { ownerForTurn, setTurn, turnAssignees } from "../turn.js";
import { renderProgress } from "../../core/progress.js";
import { workflowColumns } from "../../board/runner.js";
import { resolve } from "node:path";
import {
  blockerLabel,
  blockerReference,
  parentReference,
  reference,
  type ThreadRef,
} from "../refs.js";
import { central } from "../learnings.js";
import { upstreamCaller, upstreamFooter } from "../upstream.js";
import type { GatewayServices } from "../server.js";
import type { Handler } from "./types.js";

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
export const issueCreate: Handler<"issueCreate"> = async function ({
  title,
  file,
  labels = [],
  estimate,
  status,
  parent,
}) {
  if (
    Array.isArray(labels) &&
    labels.some((label) => typeof label === "string" && label.trim().toLowerCase() === "autopilot")
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
  const boardEnabled = this.config.board?.enabled !== false;
  if (!boardEnabled && (estimate !== undefined || status !== undefined)) {
    throw new Error("Board is disabled; estimate/status require a configured board");
  }
  const body = readFileSync(file, "utf8");
  guardDependencyText(body);
  await checkMarkdown(this.root, `${title}\n\n${body}`);
  guardClosingKeywords(`${title}\n\n${body}`);
  const created = object(
    await this.github.rest(
      `/repos/${this.config.repo}/issues`,
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
        { repo: this.config.repo, number: Number(created.number) },
      ]);
      const membership = await board.ensureCard(created.node_id);
      // One ordered board mutation, Status last with its progress companion (#199);
      // the created issue's default Status files it in the first workflow column (#231).
      await board.setIssueFields(
        created.node_id,
        [
          ...(estimate !== undefined ? [{ name: "Estimate", value: String(estimate) }] : []),
          { name: "Status", value: status ?? workflowColumns[0] },
        ],
        membership
      );
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
export const upstreamIssue: Handler<"upstreamIssue"> = async function ({ title, file }) {
  if (typeof title !== "string" || !title.trim() || /[\r\n]/.test(title)) {
    throw new Error("Invalid upstream issue title");
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) {
    throw new Error("Post must contain nonempty Markdown");
  }
  const body = `${raw.trimEnd()}\n\n${upstreamFooter(this.config.repo)}`;
  await checkMarkdown(this.root, `${title}\n\n${body}`);
  guardClosingKeywords(`${title}\n\n${body}`);
  await upstreamCaller(this.github, this.config.repo);
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
export const upstreamComment: Handler<"upstreamComment"> = async function ({ ref, file }) {
  if (typeof ref !== "string" || !/^[1-9]\d*$/.test(ref) || !Number.isSafeInteger(Number(ref))) {
    throw new Error("Invalid upstream issue reference");
  }
  const number = Number(ref);
  const body = readFileSync(file, "utf8");
  await checkMarkdown(this.root, body);
  guardClosingKeywords(body);
  await upstreamCaller(this.github, this.config.repo);
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

/** Close an accepted own-repository issue, optionally posting a validated file comment first. */
/** Rewrite only the exact body previously returned by read issue. */
export const issueEdit: Handler<"issueEdit"> = async function ({ ref, file, scopeReview }) {
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
    throw new Error("Issue body changed since read (or not read); read issue again before editing");
  }
  // #359: the current, pre-edit approval is what the edit voids; read it before writing.
  // The paired --scope-review flow voids and re-approves in one verb, so it skips the warning.
  const stale = summary === undefined ? await this.staleScopeApproval(number, item) : undefined;
  // Journal the body write as the verb's operation (#199) so a poll between it and
  // a sibling write cannot report the card.
  this.github.writes.beginOperation("issue edit", [{ repo: this.config.repo, number }]);
  await this.github.rest(`/repos/${this.config.repo}/issues/${number}`, "PATCH", { body }, false);
  writeFileSync(snapshot, bodyHash(body));
  if (summary !== undefined) {
    return `Updated issue #${number}; ${await this.scopeReviewCore(number, summary)}`;
  }
  return `Updated issue #${number}${stale === undefined ? "" : `\n${stale}`}`;
};

/** Publish checked summary with the live digest, then assign scope review to the owner. */
export const scopeReview: Handler<"scopeReview"> = async function ({ ref, file }) {
  return this.scopeReviewCore(this.localNumber(ref), this.scopeSummary(file));
};

/** Close an issue after checking all native blockers; force explicitly bypasses that guard. */
export const issueClose: Handler<"issueClose"> = async function ({ ref, comment, force }) {
  const number = this.localNumber(ref);
  const body = comment === undefined ? undefined : readFileSync(comment, "utf8");
  if (body !== undefined) {
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
  }
  const issue = await this.flowThread(ref, "issue");
  if (!force) {
    const data = await this.node(
      String(issue.id),
      "blockedBy(first: 100) { nodes { state } pageInfo { hasNextPage } }",
      "Issue"
    );
    if (!this.filter.accept(data, repoOf(data).owner, reference(ref, this.config).link)) {
      throw new Error("Task identity changed");
    }
    const blockers = object(data.blockedBy);
    if (
      !Array.isArray(blockers.nodes) ||
      object(blockers.pageInfo).hasNextPage !== false ||
      blockers.nodes.some((node) => !["OPEN", "CLOSED"].includes(String(object(node).state)))
    ) {
      throw new Error("Missing or incomplete blocked-by metadata; cannot close issue");
    }
    if (blockers.nodes.some((node) => object(node).state === "OPEN")) {
      throw new Error("Issue has an open blocker; use --force to close it anyway");
    }
  }
  this.github.writes.beginOperation("issue-close", [{ repo: this.config.repo, number }]);
  const path = `/repos/${this.config.repo}/issues/${number}`;
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

/** Reopen an issue and restore its pre-Done column, falling back to Backlog.
 * All effects use the gateway journal, including the multi-write handoff. */
export const issueReopen: Handler<"issueReopen"> = async function ({ ref, comment }) {
  const number = this.localNumber(ref);
  const body = comment === undefined ? undefined : readFileSync(comment, "utf8");
  if (body !== undefined) {
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
  }
  const issue = await this.flowThread(ref, "issue");
  if (issue.state !== "CLOSED") {
    throw new Error("Reopening requires a closed issue");
  }
  const previous = await this.preDoneStatus(issue, ref);
  const snapshot = await this.board.snapshot();
  const status = snapshot.fields
    .find((field) => field.name === "Status")
    ?.options.some((option) => option.name === previous)
    ? previous
    : "Backlog";
  this.github.writes.beginOperation("issue-reopen", [{ repo: this.config.repo, number }]);
  const path = `/repos/${this.config.repo}/issues/${number}`;
  if (body !== undefined) {
    await this.github.rest(`${path}/comments`, "POST", { body }, false);
  }
  const reopened = object(await this.github.rest(path, "PATCH", { state: "open" }));
  if (reopened.state !== "open" || reopened.node_id !== issue.id) {
    throw new Error("Issue reopening not confirmed");
  }
  await this.board.setIssueField(String(issue.id), "Status", status);
  return `Reopened issue #${number}`;
};

/** Attach a configured-repository sub-issue to a configured-repository epic through
 * GitHub's addSubIssue (#327): a parent outside the configured repository is refused
 * before any write, an issue already attached to that epic is a read-only no-op, and
 * an issue parented elsewhere is refused, naming its current parent, before the write. */
export const issueParent: Handler<"issueParent"> = async function ({ ref, epic }) {
  const number = this.localNumber(ref);
  const epicRef = this.subIssueParentRef(epic);
  const child = await this.flowThread(String(number), "issue");
  return this.relateSubIssue({ number, id: String(child.id) }, epicRef, "add");
};

/** Detach a configured-repository sub-issue from a configured-repository epic through
 * GitHub's removeSubIssue (#327): an issue not attached to that epic is a read-only
 * no-op, naming the current parent when there is one. */
export const issueUnparent: Handler<"issueUnparent"> = async function ({ ref, epic }) {
  const number = this.localNumber(ref);
  const epicRef = this.subIssueParentRef(epic);
  const child = await this.flowThread(String(number), "issue");
  return this.relateSubIssue({ number, id: String(child.id) }, epicRef, "remove");
};

/** Set a blocked-by relation; the target is in the configured repository, the blocker may be elsewhere. */
export const issueBlock: Handler<"issueBlock"> = async function ({ ref, blocker }) {
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
export const issueUnblock: Handler<"issueUnblock"> = async function ({ ref, blocker }) {
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
export const issueEstimate: Handler<"issueEstimate"> = async function ({ ref, points }) {
  assertEstimate(points);
  this.localNumber(ref);
  const issue = await this.flowThread(ref, "issue");
  return this.board.setIssueField(String(issue.id), "Estimate", String(points));
};

/** The edit-time scope warning (#359): an edit voids a body-bound approval or an open
 * task PR's merge-time scope recheck, which merge-task would only refuse at the end. */
export function staleMessage(this: GatewayServices, number: number): string {
  return `scope approval for #${number} is now stale; run scope-review ${number} <summary-file> before merging`;
}

export async function staleScopeApproval(
  this: GatewayServices,
  number: number,
  item: ObjectData
): Promise<string | undefined> {
  if ((await this.evidence.scopeState(item))?.approved === true) {
    return this.staleMessage(number);
  }
  return (await this.openTaskPr(number)) ? this.staleMessage(number) : undefined;
}

/** One open pull request whose task header or marker lists this issue (#359). */
export async function openTaskPr(this: GatewayServices, number: number): Promise<boolean> {
  for (let page = 1; ; page++) {
    const pulls = await this.github.rest(
      `/repos/${this.config.repo}/pulls?state=open&per_page=100&page=${page}`
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

/** Read and validate a change summary before any write: the posted comment already
 * opens with `[orchestrator] SCOPE REVIEW`, so the summary must not forge a header. */
export function scopeSummary(this: GatewayServices, file: string): string {
  const summary = readFileSync(file, "utf8");
  if (!summary.trim() || summary.includes("body sha256:") || containsScopeHeading(summary)) {
    throw new Error("Provide a nonempty change summary, without a review tag or body hash");
  }
  guardProtocolHeader(summary, "scope-review");
  return summary;
}

export async function scopeReviewCore(
  this: GatewayServices,
  number: number,
  summary: string
): Promise<string> {
  const issue = await this.flowThread(String(number), "issue");
  if (issue.state !== "OPEN" || typeof issue.body !== "string") {
    throw new Error("Scope review requires an open issue with a readable body");
  }
  const snapshot = await this.board.snapshot();
  const card = (await this.board.cards(snapshot.id)).find((card) => card.contentId === issue.id);
  const estimate = card?.values.Estimate;
  assertEstimate(estimate);
  const autopilot = (await this.evidence.autopilotFor(issue)).active;
  const body = `${heading("SCOPE REVIEW")}\n\nI have updated the main body to the final scope.\n\nEstimate: ${estimate}\n\n${summary.trim()}\n\n${autopilot ? "Autopilot: scope approved.\n\nScoping → Spec review under autopilot.\n\n" : ""}body sha256: ${bodyHash(String(issue.body))}`;
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
      `https://github.com/${this.config.repo}`
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
    this.config.repo,
    current,
    "owner",
    await ownerForTurn(this.github, this.filter.people, this.config.repo, number)
  );
  // One operation for the assignment, summary comment and board handoff writes (#199).
  this.github.writes.beginOperation("scope-review", [{ repo: this.config.repo, number }]);
  await setTurn(this.github, this.config.repo, number, current, next);
  await this.github.rest(
    `/repos/${this.config.repo}/issues/${number}/comments`,
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
  if (autopilot && (await this.evidence.autopilotFor(issue)).active) {
    await this.github.rest(
      `/repos/${this.config.repo}/issues/${number}/comments`,
      "POST",
      {
        body: `${heading("AUTOPILOT")}\n\nSpec review → Executing under autopilot, on my scope review.`,
      },
      false
    );
    await setTurn(
      this.github,
      this.config.repo,
      number,
      next,
      turnAssignees(this.filter.people, this.config.repo, next, null)
    );
    await this.board.setIssueField(String(issue.id), "Status", "Executing");
    return `Scope approved under autopilot for #${number}`;
  }
  return `Scope review requested for #${number}`;
}

export async function preDoneStatus(
  this: GatewayServices,
  issue: ObjectData,
  ref: string
): Promise<string> {
  let status = "Backlog";
  for await (const connection of pages(
    async (cursor) => {
      const data = object(
        await this.github.graphql(
          `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue { ${identityFields} timelineItems(first: 100, after: $cursor, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]) { nodes { __typename ... on ProjectV2ItemStatusChangedEvent { status previousStatus createdAt project { number } } } pageInfo { hasNextPage endCursor } } } } }`,
          { id: issue.id, cursor }
        )
      );
      const parent = object(data.node);
      if (!this.filter.accept(parent, repoOf(parent).owner, reference(ref, this.config).link)) {
        throw new Error("Task identity changed");
      }
      return parent.timelineItems;
    },
    {
      connectionError: "Missing timeline nodes",
      cursorError: "Invalid timeline pagination cursor",
    }
  )) {
    for (const node of connection.nodes) {
      const event = object(node);
      if (
        event.__typename === "ProjectV2ItemStatusChangedEvent" &&
        object(event.project).number === (this.config.board?.number ?? NaN) &&
        event.status === "Done"
      ) {
        status =
          typeof event.previousStatus === "string" &&
          event.previousStatus &&
          event.previousStatus !== "Done"
            ? event.previousStatus
            : "Backlog";
      }
    }
  }
  return status;
}

export async function issueNodeId(
  this: GatewayServices,
  ref: ThreadRef,
  missing = "Blocker issue"
): Promise<string> {
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
export function subIssueParentRef(this: GatewayServices, epic: string): ThreadRef {
  const ref = parentReference(epic, this.config);
  if (ref.repo.toLowerCase() !== this.config.repo.toLowerCase()) {
    throw new Error(
      `Sub-issue parent must be in the configured repository, not ${ref.repo}#${ref.number}`
    );
  }
  return ref;
}

/** The sub-issue's current parent relation: structural node fields only (id, number,
 * repository), never the parent's content — this read never delivers a thread (#327). */
export async function subIssueParent(
  this: GatewayServices,
  childNumber: number
): Promise<ObjectData | null> {
  const [owner, name] = this.config.repo.split("/");
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
export function parentLabel(this: GatewayServices, parent: ObjectData): string {
  const repo = String(object(parent.repository).nameWithOwner ?? "");
  const number = Number(parent.number);
  if (!repo || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("Incomplete sub-issue parent read");
  }
  return repo.toLowerCase() === this.config.repo.toLowerCase() ? `#${number}` : `${repo}#${number}`;
}

/** One sub-issue relation move shared by `issue parent`/`issue unparent` and
 * `issue create --parent` (#327): the child arrives already authenticated (an
 * accept-filtered thread for the verbs, the fresh creation response for the flag).
 * The parent is refused outside the configured repository, already-attached adds are
 * a read-only no-op, and a child parented elsewhere is refused before any write. */
export async function relateSubIssue(
  this: GatewayServices,
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
  await this.writeSubIssueRelation("add", await this.issueNodeId(epicRef, "Epic issue"), child.id);
  return `Added sub-issue #${child.number} to epic ${epicLabel}`;
}

export function parentMatchesEpic(
  this: GatewayServices,
  parent: ObjectData,
  epicRef: ThreadRef
): boolean {
  const repo = String(object(parent.repository).nameWithOwner ?? "");
  return (
    repo.toLowerCase() === this.config.repo.toLowerCase() &&
    Number(parent.number) === epicRef.number
  );
}

/** GitHub's sub-issue relation mutation: `issueId` is the parent/epic node, `subIssueId` the child's. */
export async function writeSubIssueRelation(
  this: GatewayServices,
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
