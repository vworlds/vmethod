# Board

Keep each card's status, next actor and progress synchronized through the wrappers.

## Status and assignee

Status options are ordered **Backlog, Ready, In progress, In review, Approved, Done**.
Issues and PRs use the same columns for different stages:

| Status      | Issue                                              | Task PR                                    |
| ----------- | -------------------------------------------------- | ------------------------------------------ |
| Backlog     | Idea, initially estimated; no implementation       | Not used                                   |
| Ready       | Owner wants it developed; blocked items wait       | Not used                                   |
| In progress | Its deliveries are open                            | Worker builds                              |
| In review   | Specification conversation                         | Orchestrator verification or owner review  |
| Approved    | Owner agrees to specification                      | Owner agrees to delivery; verify and merge |
| Done        | Last delivery integrated, or closed as not planned | Merged or closed                           |

**Assignee means whose move it is**, not who wrote the code. Assign the owner when
they must read, try, answer or decide. Assign the orchestrator when it must act,
even if only to reply. No assignee means a worker has it or no human action is pending.
Remove yourself or hand over when done. Every Status or Assignee change also sets
Progress; do not leave stale state or manually patch Progress.

## Estimate belongs to the issue

Every issue gets an Estimate **in Backlog**, before the owner takes work into Ready.
Revise it whenever new information changes the work: specification development,
design questions, closed blockers or final grading. **Never set an Estimate on a PR.**
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

## Model

On an issue, Model is an optional, evidence-backed hint, not an estimate-to-model
formula. On a PR it names the family actually doing the delivery. Launch and switch
actions maintain it, never speculative watcher writes. `models.yaml` maps families
to ids, backend kind and owner gate; families must match board options.

The baseline options are sol, luna, astra, sonnet, opus, glm, big-pickle, glm-flash,
other. Use `other` only with an explicit id. Owner gates apply even when a model is
selected by full id or inherited from a hint. See [model selection](orchestrator-guide.md#models-and-grading).

## Progress

Format: `<state>[ 🔁<round>][ 🔴]`. Round digits use keycaps, for example `🔁1️⃣`.
Red CI is an independent suffix for the current head. Watcher updates are eventual;
a worker reports by comments rather than writing the board.

| Key            | State | Meaning / setter                                 |
| -------------- | ----- | ------------------------------------------------ |
| hold           | ⛔    | Opened on hold; task opener                      |
| working        | 🤖🔨  | Worker building; launch, GO, changes or answer   |
| question       | 🤖❓  | Worker QUESTION; watcher                         |
| design         | 🤖📐  | Worker DESIGN; watcher                           |
| blocked        | 🤖🚫  | Worker BLOCKED; watcher                          |
| ready          | 🤖👍  | Worker READY with round; watcher                 |
| verifying      | 🧭🔍  | Orchestrator verifying; verification action      |
| owner-review   | 👤🔍  | Owner reads, tries or decides; handover          |
| owner-question | 👤❓  | Owner must answer; question action               |
| conflict       | 💥    | Branch conflicts with its base; watcher          |
| silent         | ⏳    | Worker has no recent commit or comment; watcher  |
| permission     | 🔑    | Worker waiting for permission; watcher           |
| failed         | 🪫    | Worker turn failed; watcher                      |
| idle           | 💤    | Worker has not picked up review; watcher         |
| handoff        | 🤖🤝  | Worker HANDOFF, awaiting a model switch; watcher |

The stuck states are silent, permission, failed, idle and conflict. A new worker
comment or commit returns stalled work to working, and clears `handoff` the same
way; clear conflict only when the
branch merges cleanly again. Approval and issue answers clear the active state;
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

`board status` and `board migrate` (vmethod 1.0, #5) report and apply ordered,
append-only migrations. Review the pending diff and dry run, especially built-in
Status automations, before applying it after every upgrade. The board README holds
the managed version block; do not hand-edit it. Migration writes preserve human
README text, require unique markers and use a board-wide lock.

Migrations resume idempotently after interruption. A budget pause releases the lock
and records its position; a failed verification stops at the last verified version.
Use explicit stale-lock recovery only after checking the holder. They never downgrade.

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
response never assumes ownership; it reports through the same age rule.

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
Operations are objects discriminated by `op`:

- `add_field { field, type, options? }`
- `add_option { field, option, color?, description? }`
- `rename_option { field, from, to }`: add the destination and move cards; retain
  the old option until a contract removes it.
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
