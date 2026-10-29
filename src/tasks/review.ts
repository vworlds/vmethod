import { heading as protocolHeading, parseFirstLine, wakeText } from "../core/protocol.js";
import { readFileSync } from "node:fs";
import { renderProgress, reviewProgress, expectedTurn } from "../core/progress.js";
import { object } from "../gateway/people.js";
import { checkMarkdown, guardProtocolHeader } from "../gateway/markdown.js";
import type { ReviewInput } from "../gateway/task-flow-types.js";
import { taskHeld, taskIssueNumbers, withoutHold } from "./markers.js";
import { TaskCommon, sha } from "./common.js";

/** Review, owner questions and hold release with the existing turn and wake ordering. */
export class TaskReview extends TaskCommon {
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
    const board = this.config.board?.enabled === false ? undefined : this.host.board();
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
    const progress = reviewProgress(input.outcome, round);
    await this.turn(input.ref, expectedTurn(progress.state, "Executing"));
    await this.card(
      item,
      input.outcome === "owner"
        ? "Owner review"
        : input.outcome === "approve" && card?.values.Status === "Approved"
          ? "Approved"
          : "Executing",
      renderProgress(progress)
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
}
