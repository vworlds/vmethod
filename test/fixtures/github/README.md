# GitHub board field regression

## Issue scope evidence (PR #140)

`issue-scope.json` is the complete gateway-filtered response recorded live by
vimescmd with orchestrator `gh-read` on 2026-10-19, against vworlds/vmethod issue 138. The authenticated ANSWER on PR #140 supplied `.tmp/scope-wire-shape.json`.
It selects body/author/editor/timestamps, labels, comments and
`timelineItems(itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT])`, including
actor, status, previousStatus, createdAt and project number. Gateway attribution
keys remain; no wire fields or types are changed. The owner move to Approved is
at 2026-10-19T06:13:38Z on project 5.

Scope tests project this recording into batched `nodes` and aliased connection
envelopes and sanitize identity/repository/ID values to the existing test pins.
Scenarios change bodies, timestamps, comment collections and status values while
preserving their recorded types. WatchFake's default scope evidence represents
an orchestrator-written, uncommented issue followed by an owner Approved move;
explicit scope tests replace those defaults with discussion and review evidence.

The captured hand-posted SCOPE REVIEW wraps its digest in backticks. Its digest
matches the recorded body **plus one additional trailing newline**, not the exact
recorded body. Regression tests retain both raw fields, reject the raw mismatch,
and project the body with that additional newline to verify the quoted-hash
compatibility. Production hashing remains exact-byte; it does not normalize text.

## Queue-move turn ordering (PR #165)

PR #165's queue-move tests reuse `issue-scope.json` status-change events through
`scopeMove`, changing actor, project, status, previousStatus and timestamps to the
isolated scenarios. The changed-card re-read projects those timeline events with
the existing assignment-event recording from `watch-actions.json`. Pagination uses
the same connection envelope. Progress `updatedAt` uses the ISO-string field-value
timestamp shape already recorded for Status, applied to the text field; it is a
documented projection, not a new live capture.

## Native closing references (PR #73)

`task-development-links.json` groups the nine raw GraphQL responses supplied by
vimescmd in PR #73's authenticated review-round-1 answer on 2026-10-18. Sources
are `.tmp/captures/link-mutations/1-before.json` through `9-final.json` and their
`PROVENANCE.md`, recorded live against `vworlds/vmethod` issue #68 / PR #74.
The wrapper keys follow that order: before, add, afterAdd, addAgain,
afterIdempotentAdd, remove, afterRemove, finalAdd, final. No selected fields,
values or wire types are changed; the additional grouping keys and formatting
are local. Add/remove selected `clientMutationId`, with inputs `issueId` and
`pullRequestIds`, exactly as in the worker's DESIGN comment. Reads select PR number
and the same closing-reference connection described below. The final state leaves
PR #74 correctly linked to issue #68, with no reference prose in its body.

Task-flow fakes now use those recorded mutation responses and connection shapes.
They rename linked repository/issue values to match each isolated scenario and
use fixture node IDs for request variables. The recorded lifecycle regression
preserves issue #68 and projects only its repository to `example/project`, then
decodes the raw read/mutation envelopes through the real GraphQL client. It checks
backfill, idempotent re-read, removal, partial no-op and promotion, with no body
reference prose and no duplicate mutations. The live second add also demonstrates
API-level idempotence; the CLI additionally skips that redundant call.

`task-closing-references.json` records the gateway query supplied by vimescmd in
PR #73's authenticated answer on 2026-10-18, against `vworlds/spacerocks` PR #346.
That PR has a real closing-keyword body reference to issue #342. The query selects
`repository.pullRequest.number` and `closingIssuesReferences(first: 100)` with
`nodes { number repository { nameWithOwner } }` and `pageInfo { hasNextPage }`.
Only the gateway-added `attribution` key is removed; all selected wire values and
types are unchanged. The original capture is ignored under `.tmp/captures/`.

The task-flow regression renames only the linked repository to `example/project`
to match its isolated configured scope, then returns the capture through the real
GitHub GraphQL client and consumes its connection in merge follow-up. It verifies
the issue close payload and board Done write, with unexpected calls rejected.
This records GitHub's actual linked-issue shape, not a vmethod live write; the
orchestrator owns vmethod backfill and board confirmation after merge.

## Review comment projection (PR #71)

`review-comment.json` projects the REST comment supplied by vimescmd in PR #71's
authenticated ANSWER (`.tmp/captures/comment-6242861295.json`). Only IDs, URLs,
numeric author identity, timestamps and the first body line remain. The matrix
renames repository, issue number, author and body and advances timestamps while
retaining the recorded second-precision wire shape; the writer clock is 668 ms
later. Board mutations reuse the existing recorded projections below. This is
not a full capture of the multi-command review transaction.

## Watch action projections (PR #56)

`watch-actions.json` projects the gateway-filtered captures supplied by vimescmd
on 2026-10-17 in PR #56's authenticated answer: issue 45's assignment timeline,
its board Status value, and PR 52's MergedEvent. Attribution labels are removed;
wire timestamps and numeric identities are unchanged. Tests rename identities,
item numbers, repositories and timestamps to build deterministic scenarios.
The direct-item Status re-read uses the same selected field-value envelope, not
a separately recorded request. Creator is deliberately retained to demonstrate
that it is the first writer, **not** the latest actor; board suppression must
not depend on it. The source captures remain ignored in `.tmp/captures/`.

The orchestrator confirmed the PR 41 interleaving from watcher output order:
`merge-task` stored Done mid-poll, then the older listing's In review was compared
against that newer stored value. The card and its previous-column file were
subsequently archived/pruned; no field history survives. The regression reproduces
this interleaving rather than claiming a surviving history capture.

For learning endpoint recordings and explicitly documented derivations, see
[learning fixture provenance](learnings-PROVENANCE.md).

`board-fields.json` is a minimal projection of the field shape reported by the
orchestrator's live vworlds/vmethod run in PR #24 review round 2. The creation-time
value (`2026-10-16T11:12:25Z`) and ISO string wire type come from that report.
The report did not include a full response recording: the connection envelope is
the queried GraphQL shape, and the field identifier is an offline placeholder.
Only the Progress field is retained to exercise snapshot decoding and writing.

Do not represent this as an unmodified full API capture. Future full recordings
should retain the original wire types and document their redactions here.

## Worker-management projection

`test/gateway/worker-management.test.ts` reuses the recorded field's ISO-string
`createdAt` for its Model/Estimate board fields, changing only fixture identifiers,
field names/types and select options to exercise delivery writes.

## Issue/board housekeeping projections (PR #40)

Recorded 2026-10-17 through the built gateway CLI, read-only:

- `gh-read repos/vworlds/vmethod/issues/37`: `issue-response.json` retains the
  issue representation's number, node ID, state and timestamp fields. Other fields
  (including text and identities) are omitted. The same issue representation is
  returned by create and close; create tests project only number and node ID.
- `gh-read .tmp/board-record.graphql`: project #5 ID, README and fields. The fixture
  retains Status (two options), Estimate and Progress, with original IDs, dates
  and wire types.
- `gh-read .tmp/issue-card.graphql`: issue #39 and its projectItems relation supply
  the card ID, content fields and fieldValues. `board-write-inputs.json` re-envelopes
  those recorded values as the BoardCards query's `content`/`items` shape; the
  `Issue` discriminator is explicit. Other cards/fields/options are omitted.

Board-write tests exercise these inputs through real snapshot/card decoding and
mutation encoding. Mutation response envelopes retain only the selected
`projectV2Item { id }` from this recorded item; they are projections, **not a live
write recording**. The orchestrator owns live write smoke under amendment 1.
Scratch captures remain ignored; no credentials or unfiltered text are committed.

PR #258's board fakes also project content-side memberships into paged repository
`issues`/`pullRequests` connections, and batch continuation nodes for memberships and
field values. The item/content/value wire shapes remain the projections above;
pagination cases add synthetic IDs and other-project memberships. The verified
orchestrator's PR #258 REVIEW round 1 records the live observation that project
`items` omits archives, while `projectItems(includeArchived: true)` returns them.
The fake models that distinction; these are not new live-write recordings.

## Legacy task bodies (PR #44)

`legacy-task-bodies.json` retains only branch names and the opening/closing body
lines relevant to issue resolution. The vecs excerpt was read through
`vmethod read pr vworlds/vecs#345` on 2026-10-17. The SpaceRocks excerpt is the
verified orchestrator's PR #44 AMENDMENT 1 recording (its abbreviated link is
preserved and its keyword placeholder expanded). These are body projections,
not complete API response captures. Tests rename repository scope only and
exercise the real merge follow-up with unexpected requests rejected.
