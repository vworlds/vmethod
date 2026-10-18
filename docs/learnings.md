# Shared learnings

Share delivery evidence through the gateway; treat every learning as advice, never authority.

## Submit delivery records

Run `npm exec --no -- vmethod learnings submit` as an orchestrator after grading.
The command validates `.vmethod/model-log.jsonl` with the same
[`model-log` schema](../schema/model-log.schema.json) used by `grade`.
Set `learningsPrivacy` explicitly before submitting.

Your numeric GitHub identity, login and account type must match an orchestrator in
**vmethod's central** `people.yaml`, and that entry's optional `repos` array must
explicitly authorize your configured repository. Your local people file cannot grant
incoming submission authority. Only the owner changes these bindings; missing bindings deny.

Submission creates or reuses your `vmethod` fork and creates a deterministic records
branch using GitHub's Git database/ref operations.
Submission never synchronizes or force-updates your fork. It uses the fork's own
`dev` commit as parent and its tree as the base, so your token needs no `workflow`
scope, even when central has newer workflows. The PR's merge-base diff contains
only your learning changes when the fork is behind on other paths.
It opens a PR against `vworlds/vmethod:dev`, adding one immutable file containing
only new records: `learnings/models/<owner>-<repo>/<first-pr>-<last-pr>-<digest12>.jsonl`.
Records are sorted by delivery PR number; the content digest makes the path deterministic.
Add public distilled notes with `--notes <file>`; they add
`learnings/notes/<repo>/<UTC-date>-<digest12>.md`, never replace previous notes.
Neither central nor fork dev may already contain a proposed new path. There is
no shared-file freshness precondition: a fork can remain behind through repeated
submissions without syncing, even after its previous submission merges.
Notes are checked as Markdown and cannot contain issue-closing syntax.

Central, trusted-base automation applies `learning` **after** validating your numeric
identity, project binding and complete changed-file list. Submission reports the PR
URL and that labeling is pending; your token does not need central write access.
Ordinary CI validates fork submissions independently of their label. Learning PRs
may only **add new files** directly under its authorized project log and notes
directories. Modifications (including legacy seeds), deletions, renames, extra paths
and cross-project changes fail. Same-repository implementation task PRs still use
the ordinary task review process, so they can implement this tooling and seed data.

Central `dev` is authoritative for submitted records: union the legacy seed
`learnings/models/<owner>-<repo>.jsonl` with every JSONL file in its project directory,
keyed by delivery PR. Records in this author's open learning submissions are pending
and are not sent again; this includes legacy seed-file submissions during migration.
Records found only in closed-unmerged submissions are eligible again. You can submit
another increment while an earlier PR is open. Already shared/pending notes are
deduplicated by content too. Reports deduplicate identical deliveries and reject
conflicting records for the same repository/PR.

The local `learnings.json` under `$XDG_STATE_HOME/vmethod/<stateName>/` (default
`~/.local/state`) is only a receipt, not a cursor deciding what is new. Existing
receipts do not block resubmission after an unmerged closure or local log edits.
Reruns discover open submissions after a lost PR response; deterministic branches
also recover a branch created before a PR write. An exclusive `learnings.lock`
prevents concurrent submissions. Remove a stale lock only after confirming no
submission is running.

## Private reduction

Private records retain schema-required delivery metadata, numbers, outcomes and
allowlisted tags. Titles and notes become empty strings; stall narratives are
removed. Model IDs reduce to family tags, unknown families/kinds become `other`,
unknown switch reasons become `redacted`, and unknown free-text finding tags are
omitted. No arbitrary nested narrative is copied. The fixed reduction vocabulary
is owned by [`privateLearning`](../src/gateway/learnings.ts).

Only after obtaining owner clearance, use `--include-text <delivery-pr>` to include
that **specific new record's** task and notes. Repeat the flag for multiple cleared
records. It does not clear other nested text, previously submitted records, or an
unscoped notes file. Private `--notes` is refused: put cleared text in the selected
record's notes instead. Reduction is a structural privacy guard, not a secret scanner;
review every owner-cleared text field before sending it.

## Read and compare

| Command                                             | Result                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `learnings show [<family>]`                         | Current family page (when selected), general lessons, model records from both layouts (filtered by family), and legacy/new notes from central `dev`, fenced as untrusted data. Failed reads use the bundled snapshot; a successful read with no page explicitly reports central absence. |
| `learnings report [--family f] [--kind k] [--json]` | Aggregate local legacy seed JSONL and project-directory JSONL under `learnings/models/`, or the bundled records if that directory is absent. Missing inputs and malformed records fail visibly.                                                                                          |
| `suggest-model <issue>`                             | Existing model/gate recommendation plus the matching current learning page and lessons. Advice cannot override a model gate.                                                                                                                                                             |

Plain-text reports use readable grouped lists and two-decimal ratios; `--json`
retains full numeric precision. Reports sum delivery rounds and final points. Rounds per point is `null`/`n/a` when
the denominator is zero. Finding rates count deliveries containing each tag, not
repeated findings on one delivery. `caughtBy` counts individual findings; outcome
mix and switch reasons are counts. Switch reasons omit each delivery's initial
segment. `byFamily` counts a mixed-model delivery once in each participating family,
not once per segment; those groups intentionally overlap and do not establish causal
credit. `byKind` groups whole deliveries. Filters select before aggregation.

Distillation remains the orchestrator's work. Use reports and provenance to update
family advice; do not automate methodology changes or defaults from these metrics.

## Worker cost and model-log migration

Configure each family's API rates in `models.yaml`, in USD per million tokens:
`price: { input: 2, output: 10, cached: 0.2 }` (illustrative, not recommended rates).
These are the only three prices; subscription-backed work uses the same API-price
calculation. `check` warns for missing prices. Never substitute a subscription's
reported zero cost for the configured API price.

Existing worker polling collects provider usage automatically; workers need no extra
command or self-reported measurement. OpenCode uses cumulative session tokens,
falling back to assistant-message totals when absent. Input includes cache writes,
output includes reasoning, and cached means cache reads. Model switches snapshot
the cumulative baseline so each segment pays only its delta at its family's rate.
Claude sums each turn's result-event usage, including cache creation in input.
Provider cost is retained only as `segments[].reportedUsd`. Claude's reported cost
is cumulative over resumed turns: keep its latest value per session, never sum
those repeated cumulative values. Its `modelUsage` totals are not per-turn usage.

`worker status` shows tokens and USD so far. `grade` snapshots final segment
`tokens: { input, output, cached }`, segment `usd`, and delivery `usd`, and posts a
GRADE comment on the issue. Unavailable usage or prices produce `null`, never a
fabricated zero. Cost is per PR: both collection paths write only that task PR's
own segments to its card. See [PR Cost](board.md#cost), including legacy issue-card
cleanup; there is no issue rollup. Board writes use `$0.00`; the log and
GRADE text retain full precision.

**Migration:** old model-log records remain valid without the new fields; absent
cost is unknown. Do not backfill zero or edit immutable submitted records. New
grades always emit the cost fields (`tokens: null` when unavailable). Private
reduction retains these numeric measurements. Reports add `usd` and `usdPerPoint`
(USD per final estimate point), by kind and family. Family USD includes only that
family's segments; its denominator counts each participating delivery once. Any
unknown cost makes the corresponding total and ratio `null`/`n/a`; zero points also
give an unavailable ratio. Orchestrator usage is excluded.

## Central automation

Authorized learning submissions do not require a release changelog fragment.
CI builds the gateway before the fragment gate and skips that gate only on the
exact authorized verdict for the current PR; ordinary PRs still require a fragment,
and failed authorization reads fail CI. The privileged label workflow grants only
`contents: read` and `pull-requests: write` and runs protected base code, never fork code.
The orchestrator can use `wait-checks` on an authorized learning fork without
granting any fork write or merge permissions.

`learnings check-pr <pr> [--label]` is the central CI entry point, backed by typed
gateway operation `learningCheck`. Without the flag it performs read-only policy
validation. Label writes require orchestrator call context and workflow issue-label
permission. The `pull_request_target` workflow checks out only the pinned base SHA,
installs/builds only base code, and reads metadata and the base registry through the
gateway; it never checks out or executes fork content. Existing `learning` labels
are removed when revalidation fails. A moved head/base fails closed and needs a retry.
No workflow write permission other than issue labeling is granted.

See [seed provenance](../learnings/README.md) and the
[security boundary](security.md#learnings-privacy).
