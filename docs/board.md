# Board

Keep each card's status, next actor and progress synchronized through the wrappers.

## Status and assignee

Status options are ordered **Backlog, Scoping, Spec review, Executing, Owner review, Approved, Done**.
Issues start on the left; task PRs start in Executing:

| Status       | Issue                                                                | Task PR                                         |
| ------------ | -------------------------------------------------------------------- | ----------------------------------------------- |
| Backlog      | Idea with initial Estimate                                           | Not used                                        |
| Scoping      | Discussion; blocked cards may be discussed here                      | Not used                                        |
| Spec review  | Final body and revised Estimate await owner go                       | Not used                                        |
| Executing    | Waits for task PRs, or all epic sub-issues, to finish                | Worker builds; orchestrator reviews and answers |
| Owner review | Not used                                                             | Owner reviews delivery                          |
| Approved     | Not used                                                             | Approved delivery must be merged                |
| Done         | Last delivery integrated, all sub-issues Done, or closed not planned | Merged or closed                                |

**Assignee means whose move it is**, not who wrote the code. Assign the owner when
they must read, try, answer or decide. Assign the orchestrator when it must act,
even if only to reply. No assignee means a worker has it or no human action is pending.
Remove yourself or hand over when done. Every Status or Assignee change also sets
Progress; do not leave stale state or manually patch Progress.
Spec review and Owner review have exactly one turn assignee. Linked issues wait in
Executing with no Progress or management assignee; they never mirror their PR's review
columns. An explicit issue summons may retain its own owner turn. See
[protocol transitions](protocol.md). Use `board set` only for
explicit housekeeping with validated Progress, not as a substitute for the
[tracked owner-question commands](orchestrator-guide.md).

The owner moves Backlog → Scoping to start discussion, then Scoping → Spec review
to agree conclusions. The orchestrator gets `🧭🔍` to rewrite the scope. After
SCOPE REVIEW the owner gets `👤🔍`; Spec review → Executing approves the exact body.
The only bounces are Spec review → Scoping and Owner review → Executing, both
returning the turn to the orchestrator with reset Progress. A newer owner question
survives a stale queue move: missing or same-second ordering evidence never cancels it.
A move back to Backlog clears an older management turn and Progress, preserving worker
assignments. Journalled gateway moves retain their deliberate turn.

In Executing you may summon the owner with `👤❓` or `👤🔍` and owner assignment
without changing columns. The worker stays paused until an explicitly attested owner
agreement is quoted in the hand-back, or the owner unassigns themself. A plain owner
comment does not release the pause. See [the summons procedure](orchestrator-guide.md#owner-summons-inside-executing).

## Card order

GitHub keeps one manual order per project: `updateProjectV2ItemPosition` moves an
item after another (`afterId: null` moves it to the top) and the item listing
returns that order. What the top card means differs by column; vmethod only orders
the two columns it owns:

| Column               | Top means                   | Who orders            | vmethod does                                                                                                                 |
| -------------------- | --------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Backlog              | most important to the owner | owner                 | never reorders                                                                                                               |
| Scoping, Spec review | deal with first             | owner                 | never reorders; the orchestrator works these top-down, and the watcher lists pending Scoping/Spec review work in board order |
| Executing            | most recent activity        | vmethod               | moves the card to the top whenever its Progress or assignee changes, through a verb or the watcher                           |
| Owner review         | oldest handover (FIFO)      | vmethod               | moves a card to the bottom (after the column's last card) when it enters Owner review                                        |
| Approved             | merge first                 | owner (drop position) | the orchestrator merges top-down, and the watcher lists approved PRs in board order                                          |

Position writes are best effort: a failure is reported and never blocks the verb
or board move that triggered it, and like those writes a reorder is journaled
automatically at the gateway boundary. The watcher keeps Scoping, Spec review and
Approved lists in board order but derives no event from card position, so a
reorder silently settles into the next poll. Hand-drag a card when _you_ are
ordering a column; vmethod imposes the two rules above again only on its next
write, never while just reading the board.

`board status` lists cards whose open/closed state disagrees with Status, and cards
with an empty Status, which otherwise appear in no column. Use `board status --fix`
to move closed cards to Done and open cards to Backlog, clearing stale Progress as it
reconciles each card. Closing an issue also
moves its card to Done and clears its assignee.

The watcher also reconciles closures made in GitHub's UI: closed issues and closed
or merged task PRs move to Done, with Progress and owner/orchestrator turn assignees
cleared (worker assignments remain). External issue closures report the reason and
actor unless covered by a merged PR's closing reference; PR and own-account or
journalled closures are silent. Peer not-planned requests instead prompt a requester
notification. These notices flag any open task PR left for the issue. Foreign cards
and muted or out-of-scope threads are not changed.

## Autopilot

Apply `autopilot` yourself as the pinned owner to delegate the task's decisions
to the orchestrator until Done. Label presence alone is not authority: the gateway
checks the label event's numeric actor identity. The next scoped watcher poll removes
and reports unauthorized additions, including additions by the orchestrator.
`open-task` alone may copy a verified issue grant onto its task PR, recording the
exact copy event rather than granting new authority.

The orchestrator settles the proposal, requests scope review, approves its own scope
and delivery reviews, and merges through the ordinary wrappers. Each transition has
a thread comment identifying autopilot. Adding or removing the label on either task
card takes effect at the next poll; removing it returns the current step to the
owner without reverting completed work. A later owner addition can grant control
again. The watcher's own cleanup of an unauthorized label is the exception: it does
not revoke, and the task's remaining owner grant keeps the delegation. Every poll
judges a task group as a whole: a gateway write on any member (the PR or one of its
linked issues) within the two-minute in-flight window leaves the whole group
unjudged, because the copy's owner grant sits on another member's history; a copy
whose grant is unreadable is skipped the same way. Unknown history removes nothing
and never reports the task stopped. A copied task-PR label whose issue grant is live
can be restored with `autopilot inherit`.
The watcher reports these changes without making engineering decisions.

The owner gate for expensive models applies unchanged. Releases, permissions and
`people.yaml` remain the owner's decisions. CI, worker stopping, scope hashes and
exact-head delivery review are still required. See the
[orchestrator procedure](orchestrator-guide.md#autopilot).

## Issue scope approval

In Spec review the watcher emits `SCOPE #n` when the final scope review is not yet
pending. Rewrite the body and revise Estimate from the discussion, explaining the
new estimate in the summary. `scope-review` records the live Estimate and body hash,
keeps Spec review, assigns the owner and sets `👤🔍`. The owner's move to Executing
approves that hash. `open-task` requires both Executing and valid scope evidence.
A changed body needs a new
review and approval; an unchanged body covers all part PRs. See the
[scope procedure and shortcuts](orchestrator-guide.md#scope-review).

## Estimate belongs to the issue

Every issue gets an Estimate **in Backlog**, before the owner takes work into Scoping.
Revise it whenever new information changes the work: specification development,
design questions, closed blockers or final grading. Set it at filing with
`issue create --estimate` and set or revise it on an existing issue with
`vmethod issue estimate <n> <points>` (orchestrator only), validated against the
scale below before any write. **Never set an Estimate on a PR.**
Delivery grading writes `points_final` back to the issue; the model log retains
`points_open` from task opening and `points_final` for calibration. Points measure
work, not punishment for worker mistakes. Normalize numeric representations before
comparison. An empty value is not zero; explain uncertainty rather than omitting
the initial estimate indefinitely.

| Points | Meaning                                                    |
| ------ | ---------------------------------------------------------- |
| 0      | Already done; explain why it remains open                  |
| 0.5    | Trivial action                                             |
| 1      | Small, localized and clear                                 |
| 2      | Small multi-step change                                    |
| 3      | Medium task with several callers or tests                  |
| 5      | Several interacting concerns                               |
| 8      | Hard cross-package or lifecycle work                       |
| 13     | Design or feasibility uncertainty, or a hard investigation |
| 20     | Several dependent deliveries; split before launch          |
| 40     | Epic; decompose and estimate its issues                    |
| 100    | Vision-sized, not a worker task                            |
| 999    | Impossible as things stand; record the external constraint |

Use only this scale. `issue create --estimate`, `issue estimate` and `board set`
reject off-scale
values and list the allowed points; `open-task` also refuses to freeze an off-scale
opening Estimate. Clearing an issue Estimate remains distinct from assigning zero.

## Cost

`Cost` is per PR: text in `$0.00` format (or `≥ $0.00` for totals-only/partial
history) at configured API prices, not subscription
charges. The existing worker poll updates the task PR's card from that PR's own
segments; `grade` sets its final Cost. There is no rollup across PRs, even when they
deliver the same issue. Unknown usage or missing prices clear the field rather than
writing zero. Cost is formatted to two decimal places only for board writes; model-log
and GRADE USD retain full precision. Both issue-card field-write paths refuse Cost,
including null writes.

Migration 0004 replaces the shipped numeric Cost field with text, clearing legacy
issue rollups as part of the field replacement. Preview with `board migrate --dry-run`;
it lists both the delete and add operations.

Expand-only migration `0003` adds this field without changing existing cards or
raising minimum compatibility, including on shared boards. Run the normal board
migration before enabling cost writes. See [cost accounting](learnings.md#worker-cost-and-model-log-migration)
for configuration, provider mappings and report semantics.

Preview with `board migrate --dry-run` before applying a shared-board migration.
The message lists each pending migration's operations and the version change, for
example `Dry run: 2 → 3; v3: add field Cost (number)`. It says `no changes` only when
there are no pending operations or version bump; dry runs never write board state.

## Model

On an issue, Model is an optional, evidence-backed hint, not an estimate-to-model
formula. On a PR it names the family actually doing the delivery. Launch and switch
actions maintain it, never speculative watcher writes. `models.yaml` maps families
to ids, backend kind and owner gate; families must match board options.

The baseline options are sol, luna, astra, sonnet, opus, glm, big-pickle, glm-flash,
other; migration 0005 appends fable. Use `other` only with an explicit id. Owner gates
apply even when a model is
selected by full id or inherited from a hint. See [model selection](orchestrator-guide.md#models-and-grading).

## Progress

Format: `<state>[ 🔁<round>][ 🔴]`. Round digits use keycaps, for example `🔁1️⃣`.
Red CI is an independent suffix for the current head. Watcher updates are eventual;
a worker reports by comments rather than writing the board.

| Key            | State | Meaning / setter                                  |
| -------------- | ----- | ------------------------------------------------- |
| hold           | ⛔    | Opened on hold; task opener                       |
| working        | 🤖🔨  | Worker building; launch, GO, changes or answer    |
| question       | 🤖❓  | Worker QUESTION; watcher                          |
| design         | 🤖📐  | Worker DESIGN; watcher                            |
| blocked        | 🤖🚫  | Worker BLOCKED; watcher                           |
| ready          | 🤖👍  | Worker READY with round; watcher                  |
| verifying      | 🧭🔍  | Orchestrator verifying; verification action       |
| owner-review   | 👤🔍  | Owner reads, tries or decides; handover           |
| owner-question | 👤❓  | Owner must answer; question action                |
| conflict       | 💥    | Branch conflicts with its base; conflict dispatch |
| silent         | ⏳    | Worker has no recent commit or comment; watcher   |
| permission     | 🔑    | Worker waiting for permission; watcher            |
| failed         | 🪫    | Worker turn failed; watcher                       |
| idle           | 💤    | Worker has not picked up review; watcher          |
| handoff        | 🤖🤝  | Worker HANDOFF, awaiting a model switch; watcher  |

The stuck states are silent, permission, failed, idle and conflict. A new worker
comment or commit returns stalled work to working, and clears `handoff` the same
way; clear conflict only when the
branch merges cleanly again, except while a dispatched conflict fixer owns the
card: its activity keeps 💥, and the resolution then restores the stored
pre-dispatch turn or hands the PR to the orchestrator. Approval and issue answers
clear the active state;
merge or close clears the entire field. Budget-delayed writes are queued, not lost.

## Done-6 and cross-repository scope

Done retains the **six most recently closed cards across the whole board**. Each
repository archives only its own cards ranked after those six. Archived cards are
restorable; this is not deletion. A failed archive must be logged and retried, not
hidden or treated as a reason to repeat the merge.

Use `repo` to scope ordinary writes: Progress, grading, launch, Done capping and
archiving never alter another repository's cards. A foreign card assigned to you
asks for a reply there, not authority to run its workflow. Board migrations alone
operate on the whole `board.repos` set.

## Migrations: what adopters see

Migration 0006 changes the workflow columns. Its dry run lists **every card's old and
new column and deciding evidence**. It remaps legacy queue/execution names, splits
issue review by pending authenticated SCOPE REVIEW, maps issue approval by valid
scope evidence, and splits PR review by the pinned owner's turn. PR approval is
unchanged. Destination options expand first; card writes are batched; obsolete
options contract last. Rerunning a completed migration writes nothing. Historical
scope approvals remain valid only before the migration timestamp and while the
reviewed body is unchanged; new issue moves to Approved are not scope approval.

`board status` and `board migrate` (vmethod 1.0, #5) report and apply ordered,
append-only migrations. Review the pending diff and dry run, especially built-in
Status automations, before applying it after every upgrade. The board README holds
the managed version block; do not hand-edit it. Migration writes preserve human
README text, require unique markers and use a board-wide lock.

Migrations resume idempotently after interruption. A budget pause releases the lock
and records its position; a failed verification stops at the last verified version.
Use explicit stale-lock recovery only after checking the holder. They never downgrade.

`board status` mismatch detection and `board status --fix` consider only active
cards. Archived cards are out of the workflow, including closed cards whose Status
was previously lost; status repair never writes to them. Migration planning and
value-preservation checks still include archived issues and PRs as described below.

Planning, dry runs, card moves and post-update checks include archived issues and
PRs from every repository in `board.repos`, even on shared boards. GitHub's project
`items` listing excludes archived items, so enumeration also pages through **every
issue and PR, open or closed, in each configured repository**, reading their
`projectItems(includeArchived: true)` memberships. It keeps only this project's
memberships and merges them with the active listing by item ID. These batched,
paged reads add cost proportional to repository history and repeat during migration
verification and recovery; allow for the additional GraphQL budget. Nested membership
and field-value pages are batched too, not fetched with a request per card. Keep
`board.repos` complete: archived content outside that list, and archived draft items
without issue/PR content, cannot be discovered through this route.

Dry runs mark archived cards `(archived)` and show their moves. GitHub
refuses field writes to archived items, so an explicit migration move journals its
intent in the managed README block (`archived_move`) before unarchiving the card,
setting its value and archiving it again. Both the value and archive state must
verify before the journal is cleared. Unchanged archived cards need no item writes;
ID-preserving option renames and metadata changes also leave them archived.

If a move fails, the runner attempts to rearchive immediately and retains the
intent. If the process dies or the transport is unavailable, resume the migration
with the normal lock-recovery rules: it finishes the pending move and restores
the archive state **before replanning**, even if the field value already changed.
An in-flight archived move may use the request reserve to finish safely; budget
pauses happen between cards, not between unarchiving and rearchiving. This narrow
explicit-move journal is not an option-value snapshot or a general restore mechanism.

Do not run `board migrate` on rc.6: upgrade directly to its successor rc first.
GitHub's API treats options without IDs as new options and clears values referencing
removed IDs. Option updates pass every existing option's ID, including through renames.
The runner snapshots values before each option-list write and checks every item
(including archived and unset items) afterwards. Any mismatch fails visibly; it never
automatically restores values or journals a snapshot for replay. On resume, legacy
restore journals are discarded and current live values are used, so cards moved since
a failed attempt cannot be reverted. Explicit workflow remaps still write changed
cards in batches (archived cards use the journaled sequence above); unchanged cards
are never rewritten. Dry runs list each item to check and
each changed option's color and description. Migration 0007 applies the seven Status
colors and descriptions through this same path. Already-lost values cannot be recovered
without an earlier snapshot.

Shared boards **expand, then contract** across releases. Contract waits until every
repository in `board.repos`, including open tracks and packs, has adopted the
required version. An ahead but compatible board gives a notice; an incompatible
board refuses writes while allowing reads. Upgrade instead of bypassing that guard.

Run `npm exec --no -- vmethod board status` to inspect the current version,
pending migrations and owned-field drift. Preview with `board migrate --dry-run`;
apply with `board migrate`. These operations require `VMETHOD_ROLE=orchestrator`.
`--steal` is only for a stale lock (a holder line over one hour old) or an
orphan. A lock field younger than a minute with no holder line is still being
acquired: it is refused (`Migration lock being acquired`) and never stealable,
so a concurrent run cannot mistake an in-flight acquisition for an orphan. A
lock field with no holder line for a minute or more is an orphan
(`LOCK ORPHANED (no holder)`), and `--steal` may take it. A lost create
response never assumes ownership; it reports through the same age rule. New holder
lines record host, boot, PID and process start time. A provably dead same-host holder
(including a reused PID) can be taken over immediately without `--steal`; live,
remote, unreadable and legacy identities retain the age/explicit recovery rules.
Every `board migrate` failure prints a JSON object with an `error` field to stderr
and exits nonzero, leaving the last verified version and operation progress resumable.

The README's `migrating: N→M by <login> since <time>` window is the authoritative
quiet signal for watchers. Migrations do not stamp card Progress. A contract's
explicit `rewrite_progress` may replace a state emoji, preserving the exact suffix.
Optionally configure `board.announce: owner/repo#123` to post a human-readable
`[vmethod] board migration N→M` announcement; omitting it is not an error.

### Authoring migrations

Append `board/migrations/NNNN-name.json`; never edit a released migration. Files
are validated against `schema/board-migration.schema.json`. The package embeds
the complete ordered list into its single bundle at build time. Its `boardVersion`
must equal the last migration's version. `0001-baseline.json` is verification-only:
an unmanaged board must already have the baseline fields to adopt it.

Each file contains `version`, `up`, `expect: { fields, policy: { doneKeeps: 6 } }`
and optionally `requires` (an exact minimum package version). Field shapes use
`type: text|number|single_select` and ordered `options` for single selects.
Use `{ name, color, description }` option objects for new migrations, including in
`expect`; legacy name-only lists remain readable for append-only compatibility.
Metadata in `expect` is verified as well as option order and names. Every option-list
write must use the runner's ID-preserving snapshot/check path, including new operation types.
Operations are objects discriminated by `op`:

- `add_field { field, type, options? }`
- `add_option { field, option, color?, description? }`: order options by the field's
  `expect` list even if the option already exists; retain existing IDs and metadata.
- `rename_option { field, from, to }`: carry the source ID to a new destination,
  retaining an empty old option until contract; if the destination already exists,
  explicitly move source cards to it instead.
- `set_option_meta { field, option, color?, description? }`
- `add_progress_alias { from, to }`: persist the expand alias in the managed block.
- `rewrite_progress { from, to }`: requires an alias from an earlier migration.
- `remove_option { field, option }`: refuses an occupied option.
- `remove_field { field }`

Removal and Progress rewrite operations require `requires`. Contract checks exact
lockfile pins on each repository's configured base branch and all extant track/pack
refs, including branches without PRs. Failed adoption releases the lock; a failed
operation or verification retains it for diagnosis. Budget pauses record the
operation in `paused at`, release the lock, and report the remaining cards.
