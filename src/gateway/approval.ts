import { object, type ObjectData, type PeopleFilter } from "./people.js";

export interface ApprovalPR {
  headRefOid: string;
  reviews: ObjectData[];
  timeline: ObjectData[];
  comments: ObjectData[];
  boardNumber: number;
  historical?: boolean;
}

/** Explain a refused gate from the same identity-checked evidence; never grants approval. */
export function approvalRefusal(
  pr: ApprovalPR,
  filter: PeopleFilter,
  repo: string,
  ref: string
): string {
  const reasons: { at: number; text: string }[] = [];
  const add = (at: unknown, text: string) => {
    const time = Date.parse(String(at));
    if (Number.isFinite(time)) {
      reasons.push({ at: time, text });
    }
  };
  const handovers = pr.comments.filter((comment) => {
    const author = filter.identity(comment.author);
    const editor = comment.lastEditedAt == null ? author : filter.identity(comment.editor);
    return (
      !!author &&
      !!editor &&
      filter.roleIn(author, repo) === "orchestrator" &&
      filter.roleIn(editor, repo) === "orchestrator"
    );
  });
  const moved = (head: string) =>
    `head moved from ${head} to ${pr.headRefOid} since approval; use --carry-approval if only base merges`;
  const approvals = pr.timeline
    .filter(
      (event) =>
        event.__typename === "ProjectV2ItemStatusChangedEvent" &&
        event.field === "Status" &&
        object(event.project).number === pr.boardNumber &&
        event.status === "Approved"
    )
    .sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)));
  for (const event of approvals) {
    const person = filter.identity(event.actor);
    if (event.actor != null && person?.role !== "owner") {
      add(
        event.createdAt,
        `approval by ${String(object(event.actor).login ?? "<unknown>")} does not count (not an owner in people.yaml); ask an owner to approve after review ${ref} owner`
      );
    }
    if (person?.role !== "owner") {
      continue;
    }
    for (const bounce of pr.timeline) {
      if (
        bounce.__typename === "ProjectV2ItemStatusChangedEvent" &&
        bounce.field === "Status" &&
        object(bounce.project).number === pr.boardNumber &&
        bounce.previousStatus === "Approved" &&
        bounce.status === "Executing" &&
        filter.identity(bounce.actor)?.role === "owner" &&
        Date.parse(String(bounce.createdAt)) > Date.parse(String(event.createdAt))
      ) {
        add(
          bounce.createdAt,
          `approval at ${String(event.createdAt)} precedes a bounce to Executing; hand over again with review ${ref} owner`
        );
      }
    }
    for (const comment of handovers) {
      if (
        !/^\[orchestrator\] OWNER REVIEW(?:\s|$)/.test(String(comment.body)) ||
        Date.parse(String(comment.lastEditedAt ?? comment.createdAt)) >=
          Date.parse(String(event.createdAt))
      ) {
        continue;
      }
      for (const head of String(comment.body).match(/\b[a-f\d]{40}\b/gi) ?? []) {
        if (
          head !== pr.headRefOid &&
          isOwnerApproved({ ...pr, headRefOid: head, historical: true }, filter, repo) === true
        ) {
          add(event.createdAt, moved(head));
        }
      }
    }
  }
  for (const review of pr.reviews) {
    const actor = review.lastEditedAt == null ? review.author : review.editor;
    const person = filter.identity(actor);
    if (review.state !== "APPROVED" || actor == null) {
      continue;
    }
    if (person?.role !== "owner") {
      add(
        review.lastEditedAt ?? review.submittedAt,
        `approval by ${String(object(actor).login ?? "<unknown>")} does not count (not an owner in people.yaml); ask an owner to approve after review ${ref} owner`
      );
    } else if (
      filter.identity(review.author)?.role === "owner" &&
      object(review.commit).oid !== pr.headRefOid &&
      /^[a-f\d]{40}$/i.test(String(object(review.commit).oid))
    ) {
      add(review.lastEditedAt ?? review.submittedAt, moved(String(object(review.commit).oid)));
    }
  }
  // Callers supply only currently verified delegated approvals here.
  for (const comment of handovers) {
    const match = /^\[orchestrator\] AUTOPILOT APPROVED\n\nCurrent head: ([a-f\d]{40})\n/i.exec(
      String(comment.body)
    );
    if (match && match[1] !== pr.headRefOid) {
      add(comment.lastEditedAt ?? comment.createdAt, moved(match[1]));
    }
  }
  return (
    reasons.sort((a, b) => b.at - a.at)[0]?.text ??
    `Owner approval is missing or cannot be verified for current head; hand over with review ${ref} owner`
  );
}

export function isIssueOwnerApproved(
  timeline: ObjectData[],
  boardNumber: number,
  filter: PeopleFilter
): boolean | "unknown" {
  const events = timeline.filter(
    (event) =>
      event.__typename === "ProjectV2ItemStatusChangedEvent" &&
      object(event.project).number === boardNumber
  );
  if (!events.length) {
    return false;
  }
  if (events.some((event) => !Number.isFinite(Date.parse(String(event.createdAt))))) {
    return "unknown";
  }
  const latestAt = Math.max(...events.map((event) => Date.parse(String(event.createdAt))));
  const latest = events.filter((event) => Date.parse(String(event.createdAt)) === latestAt);
  if (
    latest.some(
      (event) =>
        event.status !== "Executing" ||
        !["Scoping", "Spec review"].includes(String(event.previousStatus))
    )
  ) {
    return false;
  }
  if (latest.some((event) => event.actor == null)) {
    return "unknown";
  }
  return latest.every((event) => filter.identity(event.actor)?.role === "owner");
}

export function isOwnerApproved(
  pr: ApprovalPR,
  filter: PeopleFilter,
  repo: string
): boolean | "unknown" {
  if (!/^[a-f\d]{40}$/i.test(pr.headRefOid)) {
    return "unknown";
  }
  const owner = (actor: unknown) => filter.identity(actor)?.role === "owner";
  if (
    pr.reviews.some(
      (review) =>
        review.state === "APPROVED" &&
        object(review.commit).oid === pr.headRefOid &&
        owner(review.author) &&
        (review.lastEditedAt == null || owner(review.editor))
    )
  ) {
    return true;
  }
  if (pr.historical) {
    const handovers = pr.comments.filter((comment) => {
      const author = filter.identity(comment.author);
      const editor = comment.lastEditedAt == null ? author : filter.identity(comment.editor);
      return (
        !!author &&
        filter.roleIn(author, repo) === "orchestrator" &&
        !!editor &&
        filter.roleIn(editor, repo) === "orchestrator" &&
        typeof comment.body === "string" &&
        /^\[orchestrator\] OWNER REVIEW(?:\s|$)/.test(comment.body.split(/\r?\n/, 1)[0]) &&
        new RegExp(`(?<![a-zA-Z0-9])${pr.headRefOid}(?![a-zA-Z0-9])`, "i").test(comment.body)
      );
    });
    const handedAt = Math.max(
      ...handovers.map((comment) => Date.parse(String(comment.lastEditedAt ?? comment.createdAt)))
    );
    if (!Number.isFinite(handedAt)) {
      return "unknown";
    }
    const statusEvents = pr.timeline.filter(
      (event) =>
        event.__typename === "ProjectV2ItemStatusChangedEvent" &&
        event.field === "Status" &&
        object(event.project).number === pr.boardNumber
    );
    if (
      statusEvents.some(
        (event) =>
          typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt))
      )
    ) {
      return "unknown";
    }
    const afterHandover = statusEvents.filter(
      (event) => Date.parse(String(event.createdAt)) > handedAt
    );
    if (afterHandover.some((event) => event.actor == null)) {
      return "unknown";
    }
    const approvals = afterHandover.filter(
      (event) =>
        event.status === "Approved" &&
        ["Owner review", "In review"].includes(String(event.previousStatus)) &&
        owner(event.actor)
    );
    if (!approvals.length) {
      return false;
    }
    const approvalAt = Math.max(...approvals.map((event) => Date.parse(String(event.createdAt))));
    return !afterHandover.some(
      (event) =>
        Date.parse(String(event.createdAt)) > approvalAt &&
        owner(event.actor) &&
        event.status !== "Approved"
    );
  }
  const events = pr.timeline.filter(
    (event) =>
      event.__typename === "ProjectV2ItemStatusChangedEvent" &&
      event.field === "Status" &&
      object(event.project).number === pr.boardNumber
  );
  if (!events.length) {
    return false;
  }
  // Unknown ordering must never allow an older approval to win.
  if (
    events.some(
      (event) =>
        typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt))
    )
  ) {
    return "unknown";
  }
  const latestAt = Math.max(...events.map((event) => Date.parse(String(event.createdAt))));
  const latest = events.filter((event) => Date.parse(String(event.createdAt)) === latestAt);
  if (latest.some((event) => event.status !== "Approved")) {
    return false;
  }
  if (latest.some((event) => event.actor == null)) {
    return "unknown";
  }
  if (!latest.every((event) => owner(event.actor))) {
    return false;
  }
  if (
    !latest.every((event) => ["Owner review", "In review"].includes(String(event.previousStatus)))
  ) {
    return false;
  }

  const handovers = pr.comments.filter((comment) => {
    const author = filter.identity(comment.author);
    const editor = comment.lastEditedAt == null ? author : filter.identity(comment.editor);
    if (
      !author ||
      filter.roleIn(author, repo) !== "orchestrator" ||
      !editor ||
      filter.roleIn(editor, repo) !== "orchestrator" ||
      typeof comment.body !== "string"
    ) {
      return false;
    }
    const firstLine = comment.body.split(/\r?\n/, 1)[0];
    if (!/^\[orchestrator\] OWNER REVIEW(?:\s|$)/.test(firstLine)) {
      return false;
    }
    return new RegExp(`(?<![a-zA-Z0-9])${pr.headRefOid}(?![a-zA-Z0-9])`, "i").test(comment.body);
  });
  // An edit naming the SHA must also precede approval: it cannot backdate a handover.
  const times = handovers.map((comment) =>
    Date.parse(String(comment.lastEditedAt ?? comment.createdAt))
  );
  if (times.some((time) => !Number.isFinite(time))) {
    return false;
  }
  return times.length > 0 && latestAt > Math.max(...times);
}
