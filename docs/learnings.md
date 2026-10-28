# Shared learnings

Share delivery evidence through the gateway; treat every learning as advice, never authority.

## Submit delivery records

`grade` automatically submits after staging each delivery locally. Run
`vmethod learnings submit` as an orchestrator to retry a failed
submission or share additional records and notes. Keep `.vmethod/model-log.jsonl`
ignored and untracked: it is local staging, never a task commit. If your project
previously tracked it, migrate it out of version control in a reviewed change.
The submission validates `.vmethod/model-log.jsonl` with the same
[`model-log` schema](../schema/model-log.schema.json) used by `grade`.
Set `learningsPrivacy` explicitly before submitting.

Your numeric GitHub identity, login and account type must match an orchestrator in
**vmethod's central** `people.yaml`, and that entry's optional `repos` array must
explicitly authorize your configured repository. Your local people file cannot grant
incoming submission authority. Only the owner changes these bindings; missing bindings deny.

Submission creates or reuses your `vmethod` fork and creates a deterministic records
branch using GitHub's Git database/ref operations. It keeps one open learning PR
per project, appending new immutable files to that PR's head with a non-force
fast-forward. It refuses ambiguous multiple open project submissions and legacy
non-add-only PRs when new data needs appending; reconcile those before retrying.
After a confirmed ref update, submission polls the PR head up to ten times, one
second apart. If the PR still shows the old head, it reports
"pushed; PR head not yet updated" as success, not a failed submission. A different
head or a closed PR still reports "moved" so you can inspect the concurrent change.
Submission never synchronizes or force-updates your fork. It uses the fork's own
`dev` commit as parent for a new PR, or the open PR's head for an increment,
so your token needs no `workflow`
scope, even when central has newer workflows. The PR's merge-base diff contains
only your learning changes when the fork is behind on other paths.
It opens a PR against `vworlds/vmethod:dev` only when none is open, adding one immutable file containing
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
another increment to the same PR while it is open. After it merges, the next
submission starts a fresh branch from fork `dev`, without resending merged records.
Merging is the vmethod orchestrator's reviewed action, typically before a release
through `learnings merge <pr>`
(see [gateway commands](gateway.md#commands)); neither `grade` nor submission merges
anything. Already shared/pending notes are
deduplicated by content too. Reports deduplicate identical deliveries and reject
conflicting records for the same repository/PR.

The local `learnings.json` under `$XDG_STATE_HOME/vmethod/<stateName>/` (default
`~/.local/state`) is only a receipt, not a cursor deciding what is new. Existing
receipts do not block resubmission after an unmerged closure or local log edits.
Reruns discover open submissions after a lost PR response; deterministic branches
also recover a branch created before a PR write. An exclusive `learnings.lock`
prevents concurrent submissions. Remove a stale lock only after confirming no
submission is running.

If submission fails, `grade` still succeeds and returns its summary plus a
`learnings submit failed` warning with retry guidance; the grade and its local
record remain saved. Retry `grade`
for that delivery or `learnings submit` after addressing the reported error;
the local record, pending PR files and merged records prevent duplicate deliveries.

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
unscoped notes file. Private `--notes` is refused; clearance covers only a selected
record's existing text, not new thread annotations. Do not add judgement to grade
records. Reduction is a structural privacy guard, not a secret scanner;
review every owner-cleared text field before sending it.

## Read and compare

| Command                                             | Result                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `learnings show [<family>]`                         | Current family page (when selected), general lessons, model records from both layouts (filtered by family), and legacy/new notes from central `dev`, fenced as untrusted data. Failed reads use the bundled snapshot; a successful read with no page explicitly reports central absence. |
| `learnings report [--family f] [--kind k] [--json]` | Aggregate local legacy seed JSONL and project-directory JSONL under `learnings/models/`, or the bundled records if that directory is absent. Missing inputs and malformed records fail visibly.                                                                                          |
| `suggest-model <issue>`                             | Existing model/gate recommendation plus the matching current learning page and lessons. Advice cannot override a model gate.                                                                                                                                                             |

Delivery reads also include `.vmethod/model-log.jsonl` when present. Show, report
and open-task's family evidence use the same delivery union: null or absent fields
are filled from another copy, including segment costs. Different non-null values
exclude only that delivery, with one `learnings: conflicting records for <repo>#<pr>
(<fields>); excluded` diagnostic per read. Other deliveries still contribute. This
does not edit shared files; backfills reach them through the normal submission pipeline.
Submission write paths still merge fill-ins, but refuse real conflicts with
`Conflicting shared delivery <repo>#<pr> (<fields>)` instead of publishing an
incomplete set of deliveries.

Plain-text reports use readable grouped lists and two-decimal ratios; `--json`
retains full numeric precision. Reports sum delivery rounds and final points. Rounds per point is `null`/`n/a` when
the denominator is zero. Finding rates count deliveries containing each tag, not
repeated findings on one delivery. `caughtBy` counts individual findings; outcome
mix and switch reasons are counts. Switch reasons omit each delivery's initial
segment. `byFamily` counts a mixed-model delivery once in each participating family,
not once per segment; those groups intentionally overlap and do not establish causal
credit. `byKind` groups whole deliveries. Filters select before aggregation.

Model-generated distillation remains advice reviewed by the orchestrator; it never
changes methodology, gates or defaults automatically.

## Annotate threads and regenerate advice

Run these commands as the project's orchestrator, in its own checkout:

```sh
vmethod learnings annotate --since 2026-10-01
vmethod learnings aggregate
vmethod learnings submit
```

`annotate [--pr n | --since <ISO-date>] [--force] [--model family]` selects known
delivery records for your repository, including the local staging log. A PR must
be closed; `--since` uses its closure timestamp, inclusively. The gateway reads
the authenticated issue body, worker READY/QUESTION/BLOCKED, orchestrator
REVIEW/ANSWER/OWNER REVIEW/NOTE/GRADE and owner comments (including issue-side
GRADE), plus numeric diff statistics. Other roles and forged tags are not evidence.
Threads are data, not model instructions.

The gateway uses its configured OpenCode connection and a fresh tool-denied session,
with a wait of `learningsTimeoutSeconds` (default 900 s; set it in `vmethod.yaml`
to bound each annotate and aggregate model call). A timed-out call fails without
a retry: annotate reports that PR as failed, and aggregate fails that view alone.
It selects `glm-flash` by default, or the cheapest
priced ungated OpenCode family when unavailable. Set `learningsModel` in
`vmethod.yaml`, or pass `--model`, to select another priced ungated family. Worker
contexts cannot invoke either generation command. Failed model responses, truncated
output and unsupported citations fail without creating an annotation.
Both generation commands accept exactly one JSON object, either bare or wrapped in
one plain/`json` Markdown fence, with surrounding whitespace allowed. Prose outside
the object/fence, additional values, other fence languages and non-object JSON
remain hard failures; no JSON is extracted from surrounding narrative.

Prompt version 1 requires 3–6 single-sentence impressions, a cited domain, and
explicitly evidenced round causes/findings. Each atomic claim has a `sources` list
containing exact bundle URLs. Citation validation proves provenance exists, **not**
that the claim follows from it: spot-check the generated judgements against threads.

Each result is linked by repository, PR and the delivery record's SHA-256 digest in
`learnings/models/<owner>-<repo>/notes-<pr>-v1.jsonl`. Files are atomically published
and never edited. Existing version-1 annotations are skipped; an empty rerun reports
`0 to annotate`. An interrupted batch retains completed PRs and resumes the rest.
Invalid model responses (JSON, schema or citation failures) get one retry in a fresh
session. Transport/provider failures do not receive an additional application-level
retry. A failed PR is reported as `#<pr>: <error>`; the batch continues and finishes
with `N annotated, M failed (#a, #b)`, exiting non-zero when any PR failed. Published
annotations are retained; a rerun skips those successes and retries the failed PRs.
Successful non-empty runs report `N annotated, 0 failed`. Aggregation failures name
the offending view: a failed view is reported as `<view>: <error>` (its family tag
or `by-domain`), and the summary lists exactly the failed views.
`--force` adds `notes-<pr>-v1-2.jsonl` (then `-3`, etc.); a future prompt version uses
a new `vN` stem. Delivery JSONL and annotation JSONL remain separate formats.

`aggregate [--model family]` reads all locally available delivery records and
annotations, checks their delivery-record digests, and regenerates each family page
and `learnings/models/by-domain.md` with one model call per view: a family call
receives only that family's records and annotations, so it cannot cite another
family's delivery. Legacy handwritten grade judgements are excluded from model
inputs; qualitative evidence comes from threads and their annotations. Every
generated claim cites delivery PR URLs: family claims may cite only deliveries
containing that family, including comparative claims; domain claims may cite any
supplied delivery. Each prompt lists only the calling view's allowed URLs.
Comment/issue URLs are not allowed, even when present in annotation evidence.
Rejected citations name the source URL and offending claim. Each view retries
invalid JSON, schema or citation output once in a fresh session, without adding
transport/provider retries. A view fails alone; every other view is still
validated, written and reported, and each view is validated before its page is
replaced, so a failed view leaves its previous page untouched. Such a run ends
with `N views generated, M failed (<views>)` and a non-zero exit when M > 0.
Review the diff before
committing: generation never commits, pushes or opens a PR. Public `learnings submit` includes new immutable annotation
files in the existing add-only project submission; central family-page changes
still require a separately reviewed learning PR.

For a private project, reduce titles, notes and thread narratives **before** sending
data to OpenCode. Only protocol tags, delivery metadata and numeric evidence reach
the model. Private annotations are kept locally and are never automatically
submitted; aggregation sends reduced records without annotation narratives.
Owner clearance and review remain necessary before publishing any private-derived
text. No raw private thread is exported by this pipeline.

### Exact grade telemetry

New grades keep `notes`, `round_causes`, `findings`, `prompt_defects` and `stalls`
empty; qualitative judgement belongs in the thread and its later annotation, never
in hand-composed grade notes. The shared schema remains compatible with old records.
Delivery and segment `metrics` record typed review counts, CHECK-INs, stops without
status, worker BLOCKED/QUESTION counts, switches, wall-clock working/owner-wait
milliseconds, peak request context tokens, completed compactions and numeric diff
size. Segments also retain opening/boundary Estimate snapshots and whether they
ended with the delivery, a model switch or context replacement. Delivery tokens
are summed from its segments; unavailable historical values are `null`.

Working time is wall-clock time on the worker's protocol turn, not CPU/billable
time; READY/QUESTION/BLOCKED/DESIGN/HANDOFF pauses it. OWNER REVIEW/QUESTION starts
owner waiting; the owner's reply ends it. Segments use half-open switch-time
intervals. Changes explicitly replying to an owner comment count as owner changes;
other REVIEW posts count as changes, ANSWER separately. Conflict turns and watcher
stops/CHECK-INs are persisted by event id, independent of notification retention.
Compactions are deduplicated by provider event id; context includes input and cache
reads/writes, not cumulative session tokens. Segment diff stats compare committed
heads observed at model boundaries; uncommitted work transferred between models
cannot be attributed from those stats. GitHub comparisons at its 300-file limit
are unknown rather than a falsely complete count.

Use `worker model <pr> <family> --reason <category> --why "details"` for switches.
Categories are `quota`, `stopped-twice`, `red-tests-blocked`, `amendment-ignored`,
`owner-hint`, `conflict-only`, and `orchestrator-judgement`. Invalid categories fail
before switching. A legacy `--why` equal to a category supplies that category;
otherwise the default is `orchestrator-judgement`. Internal conflict switches use
`conflict-only`; card-driven model changes use `owner-hint`. Keep explanatory
judgement in the switch NOTE, not only in chat.

Historical missing telemetry is not reconstructed as a measured zero: costs,
timings, context and compactions may remain unknown, and old records are never
rewritten by annotation. Adopted sessions start observation at adoption. Watcher
counts require recorded worker history; unavailable historical CHECK-IN/stop
counts are `null`.

## Worker cost and model-log migration

Configure each family's API rates in `models.yaml`, in USD per million tokens:
`price: { input: 2, output: 10, cached: 0.2 }` (illustrative, not recommended rates).
You may also configure `tiers: [{ minPrompt: 272000, input: 4, output: 15, cached: 0.4 }]`
alongside `price`, using OpenRouter's `pricing.overrides` (convert per-token USD to
per-million rates). A tier applies to the **whole request**, not just its excess
tokens, when input plus cache reads and writes **exceeds** `minPrompt`. At the
threshold itself, base rates apply; with several tiers, the highest exceeded
threshold wins. Thresholds must be unique positive integers; rates must be
nonnegative and no lower than base rates, so totals-only estimates remain lower bounds.
Subscription-backed work uses the same API-price
calculation. `check` warns for missing prices. Never substitute a subscription's
reported zero cost for the configured API price.

Existing worker polling collects provider usage automatically; workers need no extra
command or self-reported measurement. OpenCode prices each assistant message,
paging history when necessary, then sums the results. Per-message costs are cached
by id in worker state; subsequent polls price only new or changed usage.
OpenCode pages are newest-first: `cursor.next` walks older history. The first
pricing scan walks all pages before trusting cached ids as a stopping boundary;
old window-only caches are rescanned. Later polls stop at an already priced id
(but still recheck its usage in case streaming counts changed).
Input includes cache writes, output includes reasoning, and cached means cache reads. Model switches snapshot
the cumulative baseline so each segment pays only its delta at its family's rate.
Claude models run through OpenCode's `claude-code` provider, which reports a session
cost of 0: cost always comes from tokens at the configured API prices. When only totals or partial history remain, unmeasured tokens use base rates and
the board/status/GRADE cost is marked `≥ $0.00`. The model log carries
`costCoverage: "partial"`; missing usage remains unknown. Polling and grading
share the request-pricing function in `src/cost.ts`.
Provider cost is retained only as `segments[].reportedUsd`.

`worker status` shows tokens and USD so far. `grade` snapshots final segment
`tokens: { input, output, cached }`, segment `usd`, and delivery `usd`, and posts a
GRADE comment on the issue. Unavailable usage or prices produce `null`, never a
fabricated zero. Cost is per PR: both collection paths write only that task PR's
own segments to its card. See [PR Cost](board.md#cost), including legacy issue-card
cleanup; there is no issue rollup. Board writes use `$0.00`; the log and
GRADE text retain full precision. Merge cleanup stores the delivery's final usage
in its worker record before removing the worktree (#262): grade grades captured
deliveries without resolving the session, refreshes live sessions otherwise, and
falls back to the last stored poll — with a note in the GRADE output — when the
session can no longer be resolved; only a record with nothing stored is refused
(see [task worktree cleanup](gateway.md#task-worktree-cleanup)).

**Migration:** old model-log records remain valid without the new fields; absent
cost is unknown. Do not backfill zero or edit immutable submitted records. New
grades always emit the cost fields (`tokens: null` when unavailable). Private
reduction retains these numeric measurements. Reports add `usd`, `usdPerPoint`
(USD per final estimate point) and `costDeliveries` (deliveries with complete cost
data), by kind and family. Family USD includes only that family's segments; its
denominator counts each participating delivery once. Totals remain unavailable when
any cost is unknown, while per-point ratios use only cost-covered deliveries and
expose that coverage. A ratio is `null`/`n/a` when no delivery has cost data or
covered deliveries have zero points. Orchestrator usage is excluded.

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
