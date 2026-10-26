# Gateway

`src/gateway/` owns GitHub and opencode access. CLI verbs call a typed `Transport`;
the shipped transport runs the server in process. Only server-side code reads
credentials or handles unfiltered responses. This is not yet a separate credential
sandbox: owner-installed permissions remain necessary.

Every `Transport.call` carries `ctx: { role, taskPr? }`. The server's operation
policy permits workers to read and to post only to their own `taskPr` in the
configured repository. Diagnostic `ghRead`, the dropped digest and approval checks
are orchestrator-only. The CLI reads `VMETHOD_ROLE` (default `worker`) and
`VMETHOD_TASK_PR` (a positive PR number) from the launching wrapper's environment.
Invalid roles or task numbers are refused. Before dispatching an allowed operation,
the gateway queries the configured token's `viewer { databaseId login __typename }`
and matches all three pins in `people.yaml`. The lookup is cached for the gateway's
process lifetime, including concurrent first calls. Only pinned orchestrator and
worker identities may operate the general gateway. The sole exception permits a
pinned system identity in Actions (`GITHUB_ACTIONS=true`, no task context) to call
`learningCheck`, including its validated label write; see [Security](security.md).
`VMETHOD_ROLE` may narrow an orchestrator
to worker without a task, but a worker token claiming orchestrator is refused.
Any task-scoped call (`VMETHOD_TASK_PR`) requires a worker identity, even if the
requested role is orchestrator. A non-worker token reports
`worker session holds a non-worker token (<login>); fix the worker environment`.
Offline `version`, `check`, `config get` and `check-markdown` need no token.
Owner-controlled wrappers and permissions are still necessary: the in-process
gateway is not a separate credential sandbox.

When neither variable is set, the CLI in a linked worktree can infer **worker**
context through read-only `resolveTask({branch}) → number | null`. The gateway
requires exactly one open PR for the exact same-repository head branch, accepted
author/editor identity, and a task header or valid `vmethod-task` marker. Ambiguous
or absent matches return null, with explicit-prefix guidance from the CLI. It
caches successful resolutions under `.tmp/worker-context.json` by branch and head
SHA. Explicit context disables inference. Generated stubs delegate to this same
CLI path; no branch-number convention or orchestrator inference is involved.

## Identity pins (pre-1.0 migration)

Every `people.yaml` entry now requires `login`, numeric `id`, `type` (`User` or
`Bot`, exactly GitHub's account type), and `role`. System entries also require
nonempty `events` and `appIds` arrays. All template numbers are placeholders: the
owner must replace them with verified identities and application IDs. There is no
default trusted application, and missing pins fail configuration validation.
`vmethod check` reports invalid pins with source line numbers, and it errors on an
`orchestrator` pin without a `repos` binding or a configured repository that no
orchestrator binds (the role is per repository; see [Security](security.md)). Do not
let agents change their own trust list.

Author/editor login, numeric ID and type must agree. Bot author/editor login comparisons normalize REST's
trailing `[bot]` suffix to match GraphQL's suffixless spelling; numeric IDs and
account types still match exactly, and User logins are not normalized. Token
authentication does not normalize Bot suffixes; its sole Actions viewer-type
exception is documented in [Security](security.md).
Edited text is attributed to its verified
editor; a missing editor on edited text fails closed. Repository ownership must
match `org`. System comments are dropped. Check runs yield only structured facts
from applications explicitly pinned to a system entry permitting `check_run`.
Names, titles, protocol tags and commit metadata confer no authority.

## Commands

Learning operations use the same transport: `learnings(LearningInput) → string`
and central CI's `learningCheck({ref, label?}) → string`. Read/show/report are
available to workers; submit, annotate, aggregate and label writes require orchestrator context.
Annotation and aggregation use the gateway's OpenCode client with tool-denied
sessions; neither launches a task worker. See the [generation commands](learnings.md#annotate-threads-and-regenerate-advice).
Submission additionally verifies the token viewer against central numeric identity
and explicit `repos` bindings. See [shared learnings](learnings.md).

- `vmethod read pr <n> [--files|--diff|--reviews|--checks]`
- `vmethod read issue <n>`
- `vmethod read comment <id>` (numeric issue-comment ID in the configured repo)
- `vmethod read checks <n>` (PR number)
- `vmethod read registry <package>` (untrusted npm metadata)
- `vmethod post <ref> <file> [--in-reply-to <comment-url>]`

  Posts without changing the turn. On an own-repository PR in review, an
  orchestrator post warns if the card is on the orchestrator after an owner
  comment; use `review <pr> owner --in-reply-to <comment-url> <file>` to answer
  and hand it back (see the [orchestrator guide](orchestrator-guide.md)).
  A same-PR `https://github.com/<org>/<repo>/pull/<n>#discussion_r<id>` target
  posts the exact file content inside that inline review thread. An `issuecomment-`
  target stays in the conversation. Reply URLs must match the target repository
  and number. `review` verbs always post their protocol messages in the conversation,
  even when their reply link points to an inline comment.

- `vmethod gh-read <endpoint|file.graphql>`
- `vmethod dropped [--since <ISO-date>]`
- `vmethod board status`
- `vmethod board migrate [--dry-run] [--steal]`
- `vmethod issue create <title> <body-file> [--label l] [--estimate n] [--status name]`
- `vmethod issue close <n> [--comment file]`
- `vmethod issue estimate <n> <points>`
- `vmethod issue edit <n> <body-file>`
- `vmethod issue block <n> <blocker>` (`<blocker>` is `#m`, `m` or `org/repo#m`)
- `vmethod issue unblock <n> <blocker>`
- `vmethod scope-review <n> <summary-file>`
- `vmethod autopilot stop <issue|pr> <n>`
- `vmethod autopilot inherit <pr>`
- `vmethod board set <issue> <field> <value>|--clear`
- `vmethod board set <issue|pr> Assignees owner|orchestrator|--clear`

Thread references also accept `org/repo#n` within the configured org. Invoke the
installed package with `npm exec --no -- vmethod`, never a downloading fallback.

`autopilot stop` is an orchestrator-only, configured-repository removal on an
accepted issue or PR. It posts the stop in the thread; the next watcher poll
reconciles the owner's turn without reverting completed steps. There is no agent
grant command, and `issue create --label autopilot` is refused. The typed operation
is `autopilotStop({ref, kind: "issue" | "pr"}) → string`. Owner-event authentication
and `open-task` inheritance live in `src/gateway/autopilot.ts`; see
[autopilot procedure](orchestrator-guide.md#autopilot). Under current delegation,
`scope-review` and `review <pr> owner` explicitly record and advance their owner
gates. `merge-task` rechecks delegation after normal verification.

`autopilot inherit <pr>` is the orchestrator-only repair for a task PR whose copied
grant is gone: a watcher cleanup or a failed first inheritance that left no proof.
It re-runs the authenticated `open-task` copy from the linked issue's **live** grant
only; a revoked issue grant refuses. It journals the inheritance operation first, so
the watcher leaves the copied label unjudged for the two-minute in-flight window
(#199) while the label and its proof write land. The typed operation is
`autopilotInherit({ref}) → string`.

`issue edit` and `scope-review` are orchestrator-only, configured-repository writes.
Read an issue first: `read issue` saves its exact body hash in worktree-local
`.tmp/`; `issue edit` checks the live body against it immediately before writing.
This is a stale-read guard, not an atomic GitHub compare-and-swap. Both writes
validate Markdown and closing syntax, and refuse a body whose line consists only
of a dependency reference: dependencies go in the blocked-by relation through
`issue block`/`issue unblock`, not in issue text. `scope-review` takes a plain
change summary, refuses a summary opening with a protocol header (`[orchestrator] …`
or `[worker] …`) before any write, adds the live hash itself and hands the issue
to the owner. See the
[scope review procedure](orchestrator-guide.md#scope-review).

`issue block`/`issue unblock` are orchestrator-only relation writes. They resolve
the target from the configured repository and the blocker from any repository in
the configured org, refuse a missing blocker, then add or remove GitHub's
blocked-by relation. Dependencies never live in issue text; bodies written before
this rule are migrated with `issue block` to record the relation plus an
`issue edit` that drops the prose line.

Read operations gate metadata before fetching bodies, comments, reviews, files,
diffs or checks, and recheck identity on body responses. Accepted text is labelled
`from <login> (<role>)` and enclosed in an untrusted-data fence longer than any
backtick run in its content. A protocol tag inside that fence is only data.

`post` reads a file, checks nonempty Markdown and balanced fences, parses Mermaid
diagrams using the exact-version installed Mermaid peer and jsdom, rejects
closing/association syntax, and verifies the target thread. It sends the exact
file content, with **no footer**. Posts on unaccepted threads are refused.

`gh-read` accepts scoped `/repos/org/repo/...` GET endpoints, not arbitrary URLs or
method switches. GraphQL files are parsed in full: exactly one query is allowed;
mutations, subscriptions and additional operations are refused before networking.
The server augments known author-bearing selections with identity, editor and
repository metadata, including aliases and fragments. Reserved `__vm_` aliases
cannot be supplied by callers. Known author-bearing REST output is filtered too;
unverifiable REST edits are dropped rather than guessed. Check/status/workflow
diagnostics yield allowlisted structured fields, never system free text. All
diagnostic output is fenced as untrusted data, including registry metadata.
For REST issue/PR endpoints, including each entry in issue/PR lists, the gateway gates the REST author and
uses editor-aware GraphQL metadata and current text, preserving the REST response
shape. This avoids confusing a label/state update timestamp with a body edit;
unknown authors/editors still fail closed before text is delivered.

Repository `compare/<base>...<head>` GET reads are allowed within the same scope.
REST commit accounts use the usual identity pins; git-only commit metadata passes
with `attribution: "git signature (unverified)"`. Git signatures never establish a
verified person or protocol authority. Nested lists are filtered item by item.
PR branch owners and repository objects are structural metadata, not content
authors: keep `head`/`base` refs, SHAs, repository names and owner identities even
for foreign repositories. Repository descriptions pass for the configured org or
forks owned by a fully pinned listed identity; only the description is redacted for
other repositories.

Each diagnostic response includes `N items dropped by the people filter`, including
zero. This counts only removed entries of a top-level response list, so a
filtered-empty list is distinguishable from an empty source list. If fields or
nested list entries are removed inside retained data, a separate trailing
`M nested values redacted` note reports them without inflating the entry count.

The diagnostic verb is not a generic write transport. New writes belong in named,
policy-enforcing server operations. Future operations can extend the typed map
without exposing raw clients to CLI verbs.

Board operations (`boardStatus`, `boardMigrate`, `boardItem`, `boardSet`,
`boardArchive`) are orchestrator-only on the same transport. Item reads return
structured Status, Assignee, Estimate, Model and Progress data. `boardSet` accepts
`{ itemId, field, value, progress? }` for Status, Estimate, Model or Progress;
`null` clears a field. Status writes require an explicit `progress` value (or
`null`) and batch both updates in order. Estimates cannot be written on PRs.
Ordinary writes and archives refuse foreign-repository or draft cards and enforce
the README compatibility guard; migrations alone act board-wide.

Issue housekeeping and `board set` require the orchestrator role and the configured
repository. Issue creation reads checked Markdown from a file; repeat `--label` for
multiple labels. With the board enabled, creation ensures membership on the
configured board through the issue-side relation, then applies optional points-scale
`--estimate` and exact-name
`--status` values through the shared field writer; Status clears Progress, and
without `--status` it defaults to the first workflow column (Backlog). You can
immediately use `board set` after successful creation. If board follow-up fails,
the error identifies the created issue: inspect it and retry board operations,
never repeat creation. A disabled board skips membership; estimate/status flags
require a board. Closure gates the issue's author/editor through the people filter
and optionally posts a checked file comment before closing. It does not close PRs
or move board cards implicitly. Both file paths reject closing/association syntax.
Do not blindly retry a failed create: inspect the repository for a created issue.

`issue estimate <n> <points>` sets an existing issue card's Estimate through the
same shared field writer, asserting the shared points scale before any write; the
CLI accepts the same finite nonnegative number grammar as
`issue create --estimate`. Like `board set`, it requires orchestrator role, a
configured-repository issue that passes the people filter and already belongs to
the configured board, and it refuses PR cards.

`board set` accepts an issue number, not a project item ID. The issue must pass the
people filter and already belong to the configured board. Per-item writes read
issue/PR memberships or item nodes, not the eventually consistent project listing;
board-wide scans still use the listing. Choose a single-select option by its exact
name, supply a finite numeric value, or set the Progress text
field to a known state emoji (including board README aliases), optionally followed
by a keycap round and red-CI marker, for example `👤❓ 🔁2️⃣ 🔴`. Other text fields
and unknown Progress values are refused. Use `board set <issue> Progress --clear`
or `board set <issue> Estimate --clear` to empty those fields explicitly. An empty
string is still rejected, and other fields do not support `--clear`. The typed
`boardSetIssue` operation takes `value: null` for these clears; it uses GitHub's
native field-clear mutation rather than an empty text or numeric zero.
Status writes clear Progress first; the gateway client journals the
successful mutations like other writes. No housekeeping command changes repository/board scope.
The typed operations are `issueCreate({title, file, labels?, estimate?, status?})`,
`issueClose({ref, comment?})`, `issueBlock({ref, blocker})`, `issueUnblock({ref, blocker})`,
`issueEstimate({ref, points})`, `boardSetIssue({ref, field, value})` and
`boardSetAssignees({ref, value})` in `src/gateway/transport.ts`.

`board set <issue|pr> Assignees owner|orchestrator|--clear` is the journaled
management-assignee housekeeping for a change request that needs a direct turn fix
without a review, ask or scope-review handover. The ref accepts issue or PR numbers
in the configured repository only. The verb sets or clears the item's single
management (turn) assignee; worker assignees are never added or removed, because
they stay with the worker launcher. The requested value must agree with the card's
Status and Progress under the same turn rules the watcher's reconciliation
enforces: a 👤 Progress (`👤🔍`, `👤❓`) holds the owner turn; the worker-protocol
states (`🤖👍`, `🤖❓`, `🤖🚫`, `🤖📐`, `🤖🤝`) and `🧭🔍` hold the orchestrator;
`🤖🔨`, and no Progress at all, hold no management assignee — including linked
issues and epics waiting in Executing; and the Spec review and Owner review
columns hold exactly one turn assignee (the owner). A mismatch is refused before
any write, naming the expected assignee, and off-board, archived and foreign-repo
items are refused too. Assignments and removals go through `turnAssignees` and
`setTurn` over a fresh assignee read, and the gateway journals the successful
REST writes as one operation, so the session's own watcher attributes them to
itself and emits no OWNER DONE, assignment notice or BOARD VIOLATION for them —
this is what keeps housekeeping from being misread as another session's move.
This is a deliberate-repair verb for cases such as a stale owner assignee left on
an epic in Executing; anything that waits on the owner still goes through the
tracked owner-question commands.

## Worker commands

The explicit prefix or linked-worktree inference supplies `VMETHOD_TASK_PR` (see
the [worker guide](worker-guide.md#commands)). Workers cannot prepare,
wait on, post to, or push another task. Run these commands through the installed
CLI or the matching `scripts/agent/<verb>.sh` stub generated by `init`:

| Command                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-task <pr>`        | Fetch the accepted PR's head and actual base, create/reuse the [configured worker worktree](package.md#worker-worktree-configuration), verify `package.json`/`package-lock.json` sync with `npm ci --dry-run` (one-line refusal naming npm's first `Invalid:` line when they drift), and run `HUSKY=0 npm ci` when the lockfile hash changes. Keeps the task commits, reports distance from the actual base, and refuses dirty or mismatched existing worktrees. |
| `read-pr <pr>`           | Print the prompt, comments and reviews, with gateway identity labels and untrusted-data fences.                                                                                                                                                                                                                                                                                                                                                                  |
| `pr-comment <pr> <file>` | Read only a file body, refuse a first non-blank line opening with `[orchestrator]` (a worker never posts orchestrator protocol), add `[worker] ` when absent and keep a leading `[worker] …` header rather than prefixing a second one, validate Markdown before the closing-keyword guard, then post with no footer. Shell-like body text remains data.                                                                                                         |
| `push [worktree branch]` | Push a frozen local branch commit. With no arguments, use the checkout and current branch of the resolved project root; the worktree must be that same resolved root, never merely the cwd.                                                                                                                                                                                                                                                                      |
| `check-markdown <file>`  | Check GFM fences and parse each Mermaid diagram using exactly Mermaid 12.1.0 and jsdom. Exit 0 for valid input, 1 for invalid Markdown/diagrams, 2 for unreadable input or missing/incompatible peers. Peers must be installed even for ordinary Markdown in this standalone check.                                                                                                                                                                              |

The server operations are `task({ref, fetch?}) → {branch, base}` and
`push({worktree, branch}) → string`; they carry the same call context as
other gateway operations. Push requires a pinned task PR, resolves its actual base
(including track/pack branches) server-side, and refuses base/release branches,
`dev`, `master`, `main`, detached HEAD, and invalid refs. Workers may push only
their accepted open task PR's head branch in the configured repository, never a
fork. There is no force option. Zero commits relative to the PR's actual base are
refused. A failed push instructs you to fetch and merge, never force-push.

`push.denyPatterns` optionally replaces the built-in artefact patterns: `.tmp/`,
`dist/`, `coverage/`, `*.log`, `test-results/`, `playwright-report/`, and
`test-reports/`. Directory patterns match recursively; basename globs also match
in nested directories. Only added/changed files relative to the actual PR base's
merge-base are checked; refusals list every offending path. The default exempts
lockfiles, fixture/snapshot directories, and the configured changelog directory.
Explicit custom patterns can deny those paths too. An empty list disables this
artefact guard, not branch policy.

HTTPS fetch/push retries three times with 2/4-second backoff, then tries SSH three
times if the readable key named by `credentials.sshKey` exists. HTTPS credentials
come from `credentials.githubToken` through the subprocess environment, never a
token in argv or a global credential helper. These settings name environment
variables, not credential values. Install subprocesses receive no gateway tokens.

## Worker management (orchestrator only)

`vmethod worker` controls one recorded session per task PR. Its generated stubs
live in `scripts/orchestrator/`. Commands are:

```text
worker start <pr> [--model family|provider/id] [--owner-approved] [--replace]
worker adopt <pr> <session-id>
worker adopt --from-legacy
worker send <pr> <file> [--queue|--now]
worker status [pr]
worker log <pr> [n]
worker stop <pr> [--cleanup]
worker reopen <pr>
worker wait <pr> [seconds]
worker permit <pr> [once|always|reject]
worker model <pr> <family> [--owner-approved] [--reason category] [--why details]
worker models
worker health
suggest-model <issue>
grade <delivery-pr> [points]
```

The wrapper must set `VMETHOD_ROLE=orchestrator`. Worker clients cannot launch,
switch, grade or interrupt sessions. All GitHub and opencode operations stay on
the typed gateway transport; Basic authentication is in headers, never argv.

Start requires an accepted, open draft task PR, one linked unblocked issue, an
allowed model, and a prepared worktree with executable `node_modules/.bin/vmethod`.
Missing worktrees use `start-task`; existing worktrees retain uncommitted work,
but their repository and branch are checked. Before any session exists, start
verifies the prepared worktree's `package.json`/`package-lock.json` sync with
`npm ci --dry-run`; an out-of-sync lockfile stops with the one-line
`lockfile out of sync with package.json: regenerate it on the task branch before starting`
refusal plus npm's first `Invalid:` diagnostic. Task PRs link their
issue through GitHub's linked issues or an explicit `# Task: … (issue #N)` header. Multiple or
foreign-repository issue links are refused rather than guessed.
Start refuses the exact `open-task --hold` banner line or an anchored legacy
`[HOLD: reason]` title prefix; hold terminology quoted in prose does not block it.
Use `release-hold` to remove the markers before starting work.
For the self-hosting `@vworlds/vmethod` package, start runs `npm ci` then
`npm run build` in the worktree and requires readable `dist/vmethod.mjs` instead
of a self-installed binary. Consumer projects still require the executable bin.

Adopt records an existing opencode session without creating, prompting, interrupting
or changing its model. It requires an open task PR, a linked issue, an opening
Estimate, and a session whose directory matches the verified task worktree. The
actual session model must match a configured opencode model (or the `other` policy).
Existing records are never overwritten, including their grading history. Adoption
does not apply launch gates because it does not start or change the existing model.
`worker adopt --from-legacy` reads bare-id bash records keyed by encoded worktree
paths and `<pr>.json` files containing `{"sessionId":"ses_…"}` (or
`{"id":"ses_…"}`) under each safe relative `legacyWorkers` directory in
`$XDG_STATE_HOME` (default `~/.local/state`). The same `-<track>` suffix convention
as `legacyState` applies. Optional JSON `repo` and `pr` fields must match but never
authorize adoption. The importer requires an existing worktree before invoking
the normal repository/branch verification; missing worktrees are not created.
Only this legacy import may snapshot the linked issue's current board Estimate
when the PR has no opening snapshot. It records `legacy snapshot at adoption` in
the saved segment, preserved by grading. Missing issue Estimates produce an
actionable skip; normal explicit adoption still requires the PR snapshot.
Every skipped record is reported with its reason, including non-task filenames.
Unconfigured directories are never scanned and source files are unchanged.
Claude records are reported as non-adoptable skips, never sent to opencode.
See [legacy worker transition](adoption.md#legacy-worker-transition) for formats,
path constraints and the explicit Claude relaunch procedure.

Capture `<!-- points_open: 8 -->` **when creating the task PR**, using the issue's
Estimate then; do not revise this snapshot. Legacy prompts can retain their original
`**Estimate:** 8` header instead. Launch refuses a missing snapshot rather than
substitute today's issue Estimate. A changed final grade belongs on the issue;
`grade` reads the delivery PR, not an issue number, and never writes a PR Estimate.
Grading requires a closed delivery with recorded session history and writes
`.vmethod/model-log.jsonl`. An identical re-run does not append a duplicate; a
different existing grade requires explicit reconciliation. The default final
points are the issue's current Estimate. Records are validated against the shared
`schema/model-log.schema.json` before either the Estimate write or log append.
Grading also snapshots final provider tokens and API-price USD, posts GRADE on the
issue, and updates the delivery PR's Cost. Cost is per PR, using only that PR's
segments, never an issue rollup. `worker status` displays tokens and USD so far;
the existing watcher poll updates the task PR card automatically, rounded to two
formatted as `$0.00` on the board (the model log and GRADE text keep full precision). Configure family prices
and migrate the board as described in [worker cost accounting](learnings.md#worker-cost-and-model-log-migration).

Grade reads the stored segment usage from the worker record without resolving
the session when the delivery's merge-time capture exists (#262, see
[task worktree cleanup](#task-worktree-cleanup)). Otherwise grade refreshes usage
from the live session first; when the session can no longer be resolved (opencode
404 or `session unknown`), grading falls back to the record's last stored poll and
the GRADE output notes `usage from the last stored poll (session unresolvable)`.
Only a record with nothing stored refuses with
`Cannot grade #<pr>: no usage was stored …` naming the delivery instead of
forwarding opencode's raw 404; without a stored poll its cost, usage and learning
record cannot be graded.

Grade also survives a card the project workflow archived after the delivery
finished, which GitHub would otherwise refuse on the field write: the grade
reads the card's archive state first and never writes an archived item. An
already correct value is skipped and the GRADE output reports the card as
unchanged; a changed Estimate or Cost goes through the same verified
unarchive, set and archive sequence the [migration archived moves](board.md#migrations-what-adopters-see)
use, so the card stays archived and the value stays correct. Grade reports
which card and outcome applied (for example `Estimate set on the archived issue
card via unarchive/archive`), and the record, GRADE post and learning submission
complete either way.

Records under `$XDG_STATE_HOME/vmethod/<stateName>/workers/<pr>.json` hold session
identity, repository, issue, worktree, opening Estimate and timestamped model
segments. Writes use a per-PR exclusive lock and atomic rename. A lock left after
a crash must be removed only after confirming its operation is no longer running.
Failed prompt submission leaves the created session recorded. Start refuses an
existing known session, including an idle one; `--replace` interrupts and waits
before replacing it. Every new context (start, replacement, lost-session re-entry,
adoption or backend change) receives the same generated first prompt: inline
authority rules, task values, command prefix and a checklist pointing to the
pinned [worker guide](worker-guide.md). The worker reads the current PR and
authenticated amendments through the gateway; the session's first message is no
longer a copy of the PR body. Existing live contexts are not sent onboarding again.
Start and review wakes resolve the model from the PR card's Model field, never a
body line; migrate in-flight cards before adoption.

Status distinguishes running, permission-wait, quota, provider-error, idle,
idle without reply, and session unknown. Provider errors include their diagnostic
text. “Idle without reply” means no authenticated worker protocol comment follows
the latest authenticated orchestrator protocol comment. A 404 is session unknown,
not idle; network/authentication failures remain errors. Quota/provider failures
print `QUOTA <family>` plus that family's ordered `fallback` list from `models.yaml`.
They never trigger an automatic switch. The shared `OpencodeClient.status`
preserves the watcher's directory-only permission/failure contract; its explicit
session-id overload returns the detailed worker-control reasons.

Use `worker send` only for permission prompts and recovery, never free-text task
steering. When the PR card's Progress is BLOCKED, QUESTION, READY or DESIGN, every
send mode refuses with `answer on the PR: review <pr> answer|changes <file>`.
Use the review commands to record guidance and hand the turn back on the board.

`send --now` interrupts and confirms idle under one 30-second deadline. If it
cannot confirm idle, it explicitly did not send. `--queue` submits opencode's
queue delivery; default sends steer the active turn. Claude defaults refuse busy
turns; queue waits for idle, and now interrupts before resuming. `wait` defaults
to 600 seconds; permission waits are not completion. `permit` without a decision
lists pending requests. Same-backend model changes preserve the session id, synchronize the
PR's Model card, and add a segment with a fixed `--reason` category plus `--why`
details (default `owner-request`). See [exact telemetry](learnings.md#exact-grade-telemetry). Each
switch posts `[orchestrator] NOTE: model switched to <family> (<why>)` on the PR
without changing Progress; follow with `review <pr> answer <file>` to hand back
the turn. Selecting the unchanged model only synchronizes Model and the session
title; it does not post a switch note. A cross-backend switch requires an idle
worker and creates a new session with the generated first prompt, retaining the
previous usage segments but not conversation context. Card-driven resume changes
also enforce model gates; use an explicitly authorized `worker model` command
before resuming an owner-gated change. Gates apply equally
to family names and configured raw ids; unconfigured provider/id selections need
an explicit `other` family policy. Owner-gated families verify the owner's
authorization (#218): `--owner-approved` is honored only when the task issue or
task PR carries the owner's comment whose first line is exactly
`APPROVE MODEL <family>`, posted after the issue body's last edit, or — #242 —
when the task issue's or task PR's card **Model** is set to the family by the
owner themselves: GitHub records who set each project field value, and a Model
value written by anyone else, including `open-task`, never counts. Until then
the gateway refuses and names both ways, and an approval line or card value from
any other identity (worker, peer orchestrator, unpinned author) is void. A
direct task without an issue has no body-edit bound: the task PR hosts the
line. `models` lists configured
gates/fallbacks and
the models offered by opencode. Suggestions use Estimate and task labels and
print a local family learning when available; advice cannot override an owner gate.

Claude families launch headless `claude` with `acceptEdits`, never bypassing
permissions. `credentials.workerGithubToken` must name a populated environment
variable whose GitHub viewer matches a pinned `worker` identity. The child gets
that token (including through the configured GitHub token variable), not the
orchestrator/opencode credentials; its prompt goes through stdin, not argv.
Logs are under the worktree's `.tmp/`. PID birth identity guards against stopping
a reused PID. A switch while Claude is running requires stopping its turn first.

Set `workerUser` and `workerGroup` for two-user operation. Both users must belong
to that group. Preparation is unprivileged: files owned by the launching user get
the configured group and `g+rwX`; directories also get setgid so new files inherit
the group. Files owned by the other user are inspected, not forcibly changed.
The worktree, `node_modules` and `.tmp/` must have the correct group, group access
and directory setgid bit. Errors advise adding both users to the group or running
preparation as the worker user/file owner. Optional default ACLs are attempted;
missing tools or unsupported ACLs silently fall back to group modes.
Dependency installation runs with `umask 002`. Claude cannot change OS identity:
launch it from the configured worker user's login. External scratch/dependency
symlinks and paths outside the configured worktree root are refused. The owner
must also provision shared group access to the linked repository's git metadata;
preparation never changes another checkout's metadata ownership.

## Watching and muting

Run as an orchestrator (`VMETHOD_ROLE=orchestrator`):

- `vmethod watch [--once] [--track <name>|--only <n,n>|--skip <n,n>]`
- `vmethod watch --replay <previous|seq|time> [--track <name>|--only <n,n>|--skip <n,n>]`
- `vmethod mute <org/repo#n>` (or a local number)
- `vmethod unmute <org/repo#n>`
- `vmethod mutes`

The CLI only prints server-produced `nextEvents` records; it never polls GitHub.
`nextEvents` takes `{ timeoutSeconds, ack?, pollOnce?, watchStart?, guideSeen?, replay?, track?, only?, skip? }` and returns
`{ events: [{ id, kind, line, quiet? }], notice?, reminder? }`. A zero timeout applies acknowledgements
without polling. The client acknowledges IDs **after stdout finishes writing**;
`--once` delivers pending events or polls once without waiting for an event, then
acknowledges any printed batch and exits, including when nothing is new. It uses
`{ timeoutSeconds: 0, pollOnce: true }`; an ack-only call omits `pollOnce`. A failed
write leaves the batch pending. Reconnects redeliver pending events until acknowledged;
delivery is at least once, so a crash after print but before ack may repeat that batch.

The CLI sets `watchStart` on its first normal request, not on long-poll continuations.
Each nonempty delivered batch is persisted before return in `delivered.jsonl`, with
an increasing `seq`, ISO `at` timestamp and complete `events` (including quiet digests).
The state directory retains seven days of history independently of acknowledgements.
`--replay previous` returns all batches since the last real watch invocation began;
run it **before** starting the next watch. Replay never advances that boundary, polls
GitHub, acknowledges pending events or appends a duplicate history record. Manual
sequence and ISO timestamp selectors are inclusive. Repeated delivery can therefore
appear repeatedly in history. The watcher lock also protects replay and pruning.
After printing the notice, the client sends `guideSeen: true`; only then does the
server write `guide-seen-<version>`, suppressing later notices for that version in
the state directory. A failed notice write leaves it unseen.

A nonempty delivery carries one reminder line for the orchestrator, at most once
every two hours, printed after the events: `REMINDER: chat = #n pointers only or
warnings; discuss on GitHub.` The line never produces output on its own: a batch
without events stays empty, so idle periods stay silent. Its last-show timestamp
persists in the state directory (`chat-reminder`), so a watcher restart inside the
window does not repeat it. The reminder is delivery metadata, not an event: it has
no acknowledged ID, recordings and replay hold events only, and redelivered
unacknowledged batches repeat their events without repeating the line inside its
window (`nextEvents` returns it as `reminder`).

The server watches the own repository's task PRs and board, plus issues, PRs,
comments and assignments in `vmethod.repo` (default `vworlds/vmethod`; `off` disables
it). Only pinned identities pass the people filter; a peer project's orchestrator
wakes on our threads too, delivered and labelled `(collaborator)`, never as
authority. Own comments are silent only when their numeric actor ID and this
session's gateway write journal match.
System check runs update structured red-CI state, never expose free text.

Cursor-based comment and subscribed-issue listings overlap the previous cursor by
ten minutes to catch delayed indexing. Own ANSWER, GO, OWNER REVIEW and OWNER
QUESTION comments apply their Progress/Status change once per comment, independently
of notification delivery, so rereads cannot overwrite a later human board move.
Comment/new-item markers dedupe
the overlap and expire after twelve minutes relative to a successfully advanced
cursor (ten minutes plus a two-minute margin). Initial baselines still suppress
pre-existing history; pending unacknowledged events are retained independently.
Review/assignment timelines are read without a time cursor. LAUNCH excludes issues
with an open, trusted task PR in the configured repository, using its task header or
structured `vmethod-task` relation, not its branch name or an incidental issue mention.
The watcher tracks these task PRs even without a worker session or a matching task
branch name. Their merges emit MERGED notices; held task PRs referencing the merged
number are identified so you can review their dependencies and release them.

Worker READY, QUESTION, DESIGN, BLOCKED and HANDOFF wake and update Progress.
An unanswered verified worker READY, QUESTION or BLOCKED on an orchestrator-turn
card additionally emits `ORCHESTRATOR TURN #n: <state> unhandled for 5+ min` after
five minutes, then every thirty minutes. A verified orchestrator REVIEW, OWNER
REVIEW, ANSWER, AMENDMENT or GO handles that request. Other comments do not.
The watcher synchronizes management assignees. Linked issues wait in Executing,
without mirroring PR review columns, but explicit issue summons retain their owner turn.
It reports unassigned Spec review and Owner review cards
and Progress/assignee mismatches, unless the write journal marks the card in
flight: a multi-field verb's operation record or a handoff Status move within two
minutes covers every poll between the verb's own writes (#178, #199), so the
handoff verbs order assignment writes before the board move and journal one
operation per card. PR links are replaced only after the full PR poll
succeeds; a failed PR poll retains the last successful snapshot and skips board
violation reporting for that cycle, so stale or missing links never produce a verdict.
Known states repair assignments from the same board poll; ambiguous states are
reported for manual review. Owner replies and current-head owner reviews return
the turn to the orchestrator during delivery review. An Executing summons instead
retains its pause through ordinary owner comments; verified self-unassignment
returns the turn to the orchestrator. See the [protocol transition table](protocol.md).

Each own-repository task PR poll also reads submitted inline review threads and
their paginated comments. Allowed comments emit
`COMMENT #<pr> <path>:<line> from <login> (<role>) <url#discussion_r…>` once per
comment database ID, including across restarts (`null` line means no current head
line). Author/editor identity filtering and turn updates match conversation
comments. Existing comments in a thread already resolved when first observed are
suppressed, even if it later reopens; new comments on a known thread still report.
The startup history baseline also applies. Foreign-repository review threads are
not watched. Use [`post --in-reply-to`](#commands) to reply inline; resolving a
thread is not supported.

`ORCHESTRATOR TURN #n: waiting on you for 30+ min (<progress>)` reminds you after
30 observed minutes on an orchestrator turn, then hourly until it ends. It uses
the existing board poll, survives watcher restarts, and resets when the card leaves
that turn or disappears. See the [orchestrator guide](orchestrator-guide.md) for
answering owner questions without leaving the turn on you.
Board closures reconcile Status, Progress and management turn assignees as described
in [Board](board.md). Only external issue closures emit
`CLOSED #n (<completed|not planned>) by <login>`: PR closures, own-account/journalled
closes and issues with merged `closedByPullRequestsReferences` are silent.
For a not-planned issue whose verified author is bound to another project (and not
this one), `NOT PLANNED #n (requested by <login>): tell the requester` instead asks
you to notify that peer, even for an own-account close. Closure events list remaining
open task PRs; they never close those PRs. See the
[orchestrator guide](orchestrator-guide.md#watch-without-wasting-budget).
READY keeps the task card in Executing. HANDOFF uses 🤖🤝 (migration 0002), not the
🔁 round marker; subsequent worker activity restores working. Other wake events
include COMMENT, BOARD, NEXT, LAUNCH, ASSIGNED, OWNER DONE, STALE (30 minutes),
SILENT (40 minutes), WORKER permission/failure, CONFLICT (once per head), CLOSED,
and owner button-merge follow-up (at most once per ten minutes until merge-task
records completion). GRADE is once per open, non-Done issue lacking an Estimate,
after consecutive observations spanning at least one minute. An estimate, closure,
Done, disappearance or failed/skipped board poll resets settling; closed issues
never trigger it. Minor events accumulate in a quiet digest attached
to the next wake. GraphQL errors wake immediately; three failed polls report
WATCHER ERROR and back off. Failed Progress writes are reported and retried.

SILENT and STALE monitor only turns where the worker is expected to act. A verified
worker BLOCKED, QUESTION, READY FOR REVIEW, DESIGN or HANDOFF pauses these alerts
until the worker posts again, an owner replies, or an orchestrator posts REVIEW,
ANSWER, AMENDMENT or GO (legacy CHANGES also resumes monitoring). The newest
unedited turn wins, including across restarts and initial comment backfill; unrelated
commits and CI changes do not end a protocol wait. Without an observed protocol turn,
SILENT requires working Progress. Edited or unverified tags cannot change this state.

Before STALE wakes for an unanswered review, the watcher reads the recorded task's
worker session through the worker client. A busy session updated within the last
30 minutes stays quiet; idle workers or older/missing update times remain eligible.
Missing or unreachable sessions produce `STALE (worker unreachable)` without
exposing transport details. This check runs before marking the review stale, so a
busy worker can still notify later if it stops without replying.

A failed turn already reported as `WORKER … its turn failed` does not also produce
STALE while that same failure persists. A different failure or recovery followed
by unanswered silence remains reportable. Worker polling uses the recorded session
when available, with directory-based polling retained for unrecorded legacy workers.
An idle session with an unanswered orchestrator protocol comment reports
`WORKER #n: stopped without reply; send it a nudge`, once per stop. Polling reuses
the watcher's observed comments; it does not add per-card board queries.
Both recorded-session and directory fallback polling decode OpenCode's `data`
envelopes. Invalid session IDs are reported without requesting them. A failing
session does not stop polling the others; its error is reported once per session
and status until recovery. HTTP diagnostics include method, path and at most 200
characters of the structured error message, with credentials redacted.

The GitHub client records successful REST writes and GraphQL mutations in
`writes.jsonl` in the writing session's state directory, pruning entries older
than 24 hours on writes. Reads (including GraphQL query POSTs) and refused writes
do not stamp activity. Records contain timestamp, operation kind, repository and
item number, plus returned comment database/node IDs, board node/item/field/value
or affected assignee when applicable;
non-item operations use number 0 and never match numbered events. No comment
body, title or credential is stored. Writes use a short exclusive journal lock;
if journaling fails after a GitHub write, inspect remote state before retrying,
especially for creation. Remove a crash lock only after confirming no writer runs.
Comments match the returned ID first; only id-less journal records use the symmetric
two-minute server-timestamp fallback. Pending comment and quiet-digest delivery
rechecks exact IDs, so a write journaled after initial observation can silence a
queued own comment. Replay without an exact ID remains visible rather than guessing
a timestamp from display text. Journals are reread for each match across processes.

Assignments use the latest relevant assignment timeline actor; merges use
`merged_by` (GitHub's REST form of `mergedBy`). Their actor must be this account's
numeric ID **and** the matching write must be within two minutes of the GitHub
event timestamp. A same-account action without a match is labelled
`this account, another session`. Owner removal by a matched own write is silent.
Board moves use only an exact item/Status/value journal match within two minutes
of the field's `updatedAt`: `creator` is the first writer, not the latest actor.
An unmatched board move is reported without attributing an actor. Changed board
values are re-read before reporting; a stale listing is discarded on stderr only,
without advancing its previous-column baseline or producing NEXT/LAUNCH from it.
An empty Status read on a card whose baseline holds a column is transient
(GitHub mid-update) and reports nothing for that poll: the baseline is kept, so
the later real move reports once instead of as a new card.
A card baseline is pruned only after its item has been absent from every
successful board poll for 24 hours and from at least 3 of them, tracked in a
per-item absence marker; a failed or partial poll never counts, and a card one
listing omits is never reported as new.

Keep write commands and watch on the same scope. For explicit number scopes, set
the existing `WATCH_ONLY` or `WATCH_SKIP` environment selector on **both** processes
(comma- or whitespace-separated numbers); matching `--only`/`--skip` flags select
the watcher side only. Track configurations select the same journal automatically.
Separate scopes retain separate journals, so another session sharing your GitHub
account cannot silently consume your activity.

`watch.preview` defaults to `false`: lines contain metadata, not titles or bodies.
Opting in adds title plus comment first line, at most 120 characters total, with
terminal controls/ANSI stripped, inside `untrusted text: «…»`. Only owner,
orchestrator, worker and collaborator identities can supply previews, never system.
Preview text remains untrusted data, including protocol tags and closing keywords.

Each scope has its own state directory under
`$XDG_STATE_HOME/vmethod/<stateName>/`: track scopes append `-<track>`; explicit
number scopes append `-only-<sorted-numbers>` or `-skip-<sorted-numbers>`. The main
scope excludes all `track:<name>` items; PRs inherit their linked issue's track.
Labels refresh over REST every 30 seconds. `ONESHOT=1`, `WATCH_ONLY` and `WATCH_SKIP`
are supported for legacy wrappers. Mutes use the configured session (set
`VMETHOD_TRACK` for a track); only an accepted comment mentioning the orchestrator's
login lifts a mute. Foreign-board cards can report assignments but are never mutated.

First run records baselines, not historical events; current actionable conditions
such as GRADE still wake. To import legacy markers once (including board grades),
set `legacyState: [spacerocks-watch, spacerocks-watch-audit, rebase-watch]` in your
project's `vmethod.yaml`. Without this key nothing is imported. Names are directories
under `$XDG_STATE_HOME` (default `~/.local/state`); track sessions import only
`<name>-<track>`. The sources are read-only and their locks are never opened.
Numbered PR and issue markers are validated against `repo` in batches through the
gateway before copying; missing items and PR markers naming issues are dropped,
with one dropped-count log line. Validation respects gateway budget resets and
fails closed on other API errors, leaving the import retryable.
The exclusive lock holds PID **and**
Linux `/proc/<pid>/stat` start time, preventing reused PIDs (including container
PID 1) from blocking adoption. Another live watcher for that state fails clearly.
State, pending events and cursors survive restart; do not delete them to reconnect.

## CI and integration commands

| Command                                       | Role                                 | Behavior                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait-checks <pr> [max-minutes]`              | Worker (own task PR) or orchestrator | REST-only bounded wait; default 30 minutes. No accepted checks means pending for a 120-second grace window, then no verdict. A completed first job waits for its suite to finish, avoiding the job-registration race. |
| `check-task-ci <pr>`                          | Orchestrator                         | One-shot CI verdict for the current head and base, without sleeping.                                                                                                                                                  |
| `refresh-checks <pr>`                         | Orchestrator                         | If a green run used an old/unknown base, create a two-parent merge commit bringing in the current base and push through the task branch/artefact policy. An already-current base or no green run causes no push.      |
| `verify <pr>… [--packages "<ws>…"] [--bench]` | Orchestrator                         | Test-merge the pinned heads together onto their shared base in a detached review worktree, clean outputs and run the project hook once.                                                                               |

CI operations require an accepted, open, same-repository task PR. Only `wait-checks`
also accepts a fork head targeting central `vworlds/vmethod` when the pinned-base
registry and complete changed-file list authorize it as a learning submission.
This read-only exception does not permit fork pushes, refreshes or merges. Trust follows
`people.yaml` system `appIds`, never check names; reruns are deduplicated within
each application/name pair. Failure digests are fenced untrusted data. Signed log
downloads never receive the GitHub API credential. Missing logs are reported with
the job link; they do not hide the red verdict.

The last output line is the verdict. `wait-checks` exits **0** green, **1** red
(with failing checks and a short digest), **2** no verdict/head moved (run again,
never report BLOCKED), or **3** conflict (merge the base, push, run again).
`check-task-ci` uses the same codes, but green also requires every trusted check's
workflow-associated PR head/base SHAs to match the current PR head and live base
branch head, not the PR's potentially stale base SHA. `check-task-ci` and
`refresh-checks` read the branch endpoint and recheck it after collecting CI evidence;
`merge-task` resolves its fetched base ref through the same live-base helper. Missing workflow
evidence fails closed with code 2; commit timestamps cannot establish the tested
base. It returns check names, without downloading failure logs. `refresh-checks`
returns 0 for a successful push or no-op, 2 for a ref moving during preparation,
and 3 for a merge conflict. Push/fetch errors remain errors, never successful no-ops.

### Verify hook

Install an executable `scripts/vmethod-hooks/verify` in the consumer. It is called
once, in the merged review worktree, with this argument interface:

```text
scripts/vmethod-hooks/verify --logs <absolute-directory> [--packages "<ws>…"] [--bench] [--scope merge]
```

The hook owns the recipe: install dependencies, then run format, lint, typecheck,
tests and build. **Only tests** may be narrowed by `--packages`; other steps remain
repo-wide. `--bench` adds the project's benchmark step. Write full per-step output
to `<logs>/<step>.log`, print progress, and exit nonzero at the first failure. The
gateway captures stdout and stderr in `hook.log` and returns exit 0/1 with the
log directory. It passes only PATH, HOME, TMPDIR and SYSTEMROOT, never credentials.
The legacy `checks.verify` recipe list is not executed by this command.

`merge-task` calls the same hook with `--scope merge` so you can choose cheaper
merge checks (for example installation, typecheck and lint). A hook that ignores
this argument runs its full verification recipe. Ordinary `vmethod verify` does
not pass a scope and retains the full recipe above.

Logs persist in a fresh run directory under
`$XDG_STATE_HOME/vmethod/<stateName>/verify/` (default
`$HOME/.local/state/vmethod/<stateName>/verify/`). Previous runs are retained.
The review worktree is `branches.worktreeRoot/orchestrator-review`, resolved
relative to `branches.mainCheckout` or the gateway checkout. It must be created
by vmethod, detached and in the same repository. A sibling ownership marker and
exclusive lock protect it. An unowned existing directory is refused, not reset.
After a crashed run, inspect the worktree before manually removing a stale
`.vmethod-review-lock` directory.

Verification **resets and runs `git clean -qxfd` only in that owned review
worktree**, removing ignored build output and node_modules before the hook. Keep
no personal work there. PRs must share a base; moving refs or merge conflicts stop
preparation. Refreshing CI instead uses `merge-tree`/`commit-tree` without changing
any working checkout or local task branch; workers fetch and merge the new remote
commit normally.

The typed operations are `waitChecks({ref, maxMinutes?, graceSeconds?})`,
`checkTaskCi({ref})`, `refreshChecks({ref})` and
`verify({refs, packages?: string[], bench?})`, each returning `{text, code}`.
`graceSeconds` is a server/test interface (default 120). An orchestrator's internal
`push` call may additionally select a full frozen `commit` SHA; workers cannot.
All regular push policy still applies, and refresh pins the task PR in its call.

## Credentials and budget

`credentials.githubToken` is the **name** of the launching wrapper's token
environment variable. The server never consults git configuration or token
command-line arguments. Opencode uses `OPENCODE_BASE_URL`,
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`; Basic authorization is
built in memory and sent only in a header. Neither client follows redirects.

`gateway.reserve` defaults to 100 and `gateway.maxRetries` to 3. GitHub responses
at or below reserve plus one schedule a pause until the header's reset time before
the next request, reporting `BUDGET`. Only `x-ratelimit-*` headers drive pacing,
never a GraphQL `rateLimit` field. Secondary 403/429 limits honor `retry-after`
and report `BUDGET (secondary)` even when the primary budget looks healthy.
Network errors and 5xx responses retry with reported exponential backoff. Terminal
errors propagate with their HTTP method and endpoint; status-based recovery uses
`GitHubHttpError.status`, not diagnostic-text matching. Nonempty GraphQL errors
reject even HTTP 200 with partial data.

Dropped records live in
`$XDG_STATE_HOME/vmethod/<stateName>/dropped.jsonl`, defaulting to
`~/.local/state`. They contain only timestamps and GitHub links. The owner digest
prints links and counts, never bodies, titles or author names. Repeated reads can
produce repeated drops; the counts are observations, not unique contributions.

## Task-flow commands

These commands require `VMETHOD_ROLE=orchestrator`:

- `open-task <issue> [--direct "<title>"] [--unapproved "<reason>"] [--hold] [--part] [--model <family>] [--model-override "<reason>"] [--from <branch>] [--owner-approved]`
  creates a conforming-title draft from the task template and issue specification.
  The header is `# Task: <title> (issue #N)` and `<!-- points_open: N -->`
  freezes the issue's opening Estimate for grading; it is never copied onto the PR card.
  `open-task --direct "<title>"` also works without an issue. It records a structured
  issue relation, sets Model/Progress and never estimates a PR. After creating a
  completing PR, the gateway establishes its issue-side Development relation with
  GraphQL `addCloseIssueReferences`, using the issue and PR node IDs. This manual
  closing link appears in Development and the board's linked-PR field; GitHub closes
  the issue when the completing PR merges into the repository's default branch.
  No closing-keyword or association-reference text is added to the PR description.
  Gates and expensive-only Handoff breakpoints are enforced server-side; an
  owner-gated `--model` (or its issue-card Model hint) additionally requires
  `--owner-approved` and the owner's verified approval on the issue — the
  `APPROVE MODEL <family>` comment line (#218), or the owner's own Model value
  on the issue's or task PR's card (#242): GitHub records who set each project
  field value, so `open-task` writing the PR card's Model never counts. The open
  refuses and names both ways
  (see [worker management](#worker-management-orchestrator-only)).
  Existing conforming title prefixes are preserved. An issue-only `bug:` alias
  becomes `fix:`; prose/nonconforming titles receive `feat:` without broadening
  the accepted delivery-title types. `--part` requires an issue and records
  `# Task: <title> (part of issue #N)` plus `"part":true` in the structured marker.
  The issue card's Model is the owner's hint: omitting `--model` uses it, and
  launching on a different family is refused unless `--model-override` carries a
  single-line reason, which is then posted as a model-override note on the issue
  and kept in the structured marker so grading records it as the delivery's
  opening segment reason.
  Partial PRs have only vmethod's structured relation: no native closing link,
  added timeline reference or board linked-PR entry. A partial delivery leaves the
  issue and its card unchanged during merge follow-up. For multi-PR issues, use
  `--part` for intermediate deliveries; only the completing PR gets a closing link.
  `--from <branch>` starts a task from work that already exists on another branch
  (for example an owner's branch): after creating the task branch from the base,
  it merges `origin/<branch>` into that branch with a merge commit — never a
  squash or a rebase — so the source commits and their authors survive in the
  delivery, and the PR body records `Started from <branch>`. The guard refuses the
  base, release or default branch as a source. A conflicting source is refused
  before anything is pushed or opened, naming the conflicting files. The merged
  content's manifests are then verified with `npm ci --dry-run`: an out-of-sync
  lockfile stops before the task branch exists or any worker is created, with the
  one-line refusal from `start-task` plus npm's first `Invalid:` line.
- `link-task <pr> [--complete|--unlink]` idempotently backfills an open task PR's
  Development relation from its structured header or marker, never from prose or
  branch numbers. It reads `closingIssuesReferences` first and skips existing links.
  Use it on existing open task PRs after upgrading. `--complete` promotes a partial
  PR by updating its structured relation and adding the manual closing reference.
  `--unlink` calls `removeCloseIssueReferences` and demotes the structured relation
  to partial, so merge follow-up will not complete that issue. These flags are exclusive.
  Removal affects manual links only: automatic body-keyword references are unchanged.
  If a reference remains after removal, the command fails visibly without demoting
  the plan; remove that automatic reference through an owner-approved body edit.
  The orchestrator decides which PR completes an issue. Plain backfill never edits
  the body; promotion/demotion change only the structured plan, not reference prose.
  Direct tasks without an issue need no link. Workers cannot edit PR bodies or call
  this command; agent comments and reviews still reject closing/association keywords.
  Failed linking after PR creation names the created PR and the `link-task` recovery
  command; retry that command rather than creating another task. A failed plan edit
  after a successful mutation can likewise be retried without duplicating links.
- `review <pr> changes|owner|answer|ask|approve <file> [--in-reply-to <comment-url>] [--owner-agreed <comment-url>]`
  posts the protocol header and sets the next actor. The body file carries no
  protocol header: a first non-blank line already headed `[orchestrator] …` or
  `[worker] …` is refused before any write with `First non-blank line is the
protocol header "<line>"; review adds the header itself`. Owner review always names the
  full current SHA and marks the draft ready. `approve` posts an orchestrator
  acceptance, **not** owner authority. `owner` moves only the PR to Owner review;
  changes and answers stay in Executing. `owner` and `approve` refuse, before any
  write, while the PR conflicts with its base (`#n conflicts with <base>; resolve
before handing over`) or an active conflict resolution record exists (`#n has an
active conflict record; resolve before handing over`): a handover must never
  interrupt a dispatched fixer or write over its card turn. Resolve the conflict
  first, then hand over. `ask` summons the owner in Executing,
  pauses the worker and clears queued wakes. A paused summons requires `answer
--owner-agreed` and an exact Markdown block quotation from the current, effectively
  owner-authored comment after the summons. The flag attests agreement; a plain owner
  comment never releases execution. A verified owner self-unassignment is the
  independent release path. See [owner summons](orchestrator-guide.md#owner-summons-inside-executing).
- `ask <issue> <file>` posts `[orchestrator] OWNER QUESTION`, assigns the owner and
  sets `👤❓`, preserving Scoping or Executing. Its body file carries no protocol
  header; a first non-blank `[orchestrator] …` or `[worker] …` line is refused
  before pausing linked workers or writing. An Executing issue summons can pause
  its linked workers; the hand-back's agreement URL must then name that issue.
  Other issue phases refuse live task PRs: use `review <pr> ask` there.
  The typed operation is `askIssue({ref, file})`. `review ask` uses the same heading;
  `review answer` remains ANSWER for a worker. See [tracked owner questions](orchestrator-guide.md).
- `merge-task <pr> [--merge-commit] [--carry-approval "<reason>"]` requires an Approved PR and refuses live/unknown worker sessions before merging, stale
  approval, untrusted/red/missing CI, unknown/conflicting mergeability and a stale
  tested base. No recorded worker session counts as stopped; a recorded session
  that is unknown or unreachable still blocks. `merge.requireCurrentBase` defaults
  to true: the head must contain the live base SHA fetched from
  `refs/remotes/origin/<base>`, not merely the PR's recorded base. Otherwise it
  refuses with `CI tested an older base; run refresh-checks <pr>`.
  With false, it instead merges the pinned head onto the fetched base in a fresh
  temporary worktree and runs the [verify hook](#verify-hook), with `--logs`, `--scope merge` and
  the same credential-stripped environment. The hook owns installation and checks;
  its failure output and persistent log path identify the failing step. There is
  no CI rerun, and the temporary worktree is removed on success or failure. A
  missing hook refuses with `requireCurrentBase is false but no verify hook is configured; run refresh-checks <pr>`;
  legacy `checks.verify` strings are not used. Green current-head CI is still
  required in both modes. Pack heads require merge
  commits and are retained. Track/pack-base deliveries leave linked issues and the
  main checkout alone. A final-base delivery closes linked issues and reports
  `revise estimates: …` for own-repository dependents. Missing native links never
  block merging. If GitHub already closed the issue, follow-up still sets its card
  to Done without another close write or duplicate comment.
- `resolve-conflicts <pr>` starts or reconciles [bounded conflict resolution](#conflict-resolution).
  Only the orchestrator or watcher can call the `resolveConflicts({ref})` operation;
  a fixer never receives merge authority.
- `release-hold <pr>` removes the exact hold banner and any legacy hold title prefix
  in one body/title edit, posts GO, moves the card to Executing and resumes the
  worker if present. It preserves other prompt text and refuses non-held PRs
  (including a second release). If the prompt changes during preparation, read it
  and retry rather than overwriting the edit.

`review changes`, `review answer` and `release-hold` send only a fixed notification:
`[orchestrator] REVIEW round N is on your PR; read it with vmethod read pr <n> and act.`
The other headings are `ANSWER` and `GO`. Free-form review text stays on the PR.
Idle workers resume immediately. Busy or permission-waiting workers persist the
notification and return `queued for #n`; the worker-status poll delivers queued
lines once the turn ends, without steering. A queued notification whose
`[orchestrator]` comment is already older than the worker's latest protocol reply
is dropped at that poll with a `stale wake dropped for #n` report instead of
restarting the worker for an answered turn. Replies the dispatched conflict
fixer posted for its resolution (between its dispatch NOTE and the next
orchestrator turn comment) belong to the resolution, never to the task, and do
not count, so a queued wake for an unanswered ANSWER is still delivered even
when the fixer has posted its own READY or BLOCKED. `review owner` hands the turn to the
owner and clears every queued wake for that PR. Conflict-fixer wakes do not use
this queue: the resolver dispatches them directly, so they are never dropped as
stale. No recorded/reachable session returns
`no worker session for #n; nothing sent` rather than failing the posted review.
Without worker control, these commands still post and update the board. Workers
end their turn after a status comment; they do not poll for review replies.

The transport operations are `openTask`, `linkTask`, `reviewTask`, `mergeTask`, `resolveConflicts`, `releaseHold`
and `workerStatus`; `src/gateway/task-flow-types.ts` and `transport.ts` own their
signatures. The gateway wires worker status, stop and resume to the recorded opencode
or Claude session. Only the merge guard treats missing records as stopped;
ordinary worker status still reports a missing session as unknown.

### Conflict resolution

Use `resolve-conflicts <pr>` to take the cheapest applicable action. The watcher
dispatches it automatically for a conflicting head or GitHub's behind-base state,
then reconciles the persisted operation without launching another fixer.
Reconciliation errors are contained per PR and reported once per head; they do
not interrupt polling other PRs. Inspect the reported gateway state before retrying.

A record whose PR is merged or closed closes quietly with
`conflict on #n resolved outside the fixer`, removing `conflicts/<n>.json` before
any snapshot could fail it. A record that dispatched no fixer closes the same way
once its PR stands mergeable with its current base behind a change the resolution
cannot attribute — a worker's review-round fix, a manual merge, or the stale state
of an interrupted process. The report is a terminal conflict result: it supersedes
the conflicted turn's queued card moves and restarts nothing else, and the same
watcher cycle still reports the PR normally.

A `starting` or `blocked` record also closes quietly when the current head is
mergeable with the fetched current base, CI is green and non-stale, and the
gateway confirms the fixer session is stopped (including no recorded session).
A live or unknown session prevents recovery: inspect or stop it first. Blocked
records remain pending for watcher reconciliation until recovered.

Use `resolve-conflicts <pr> --retry` to retry a blocked `merge verify hook failed`
record instead of closing it. With the fixer stopped, the command re-proves the
current head against the recorded conflict/base, checks CI and runs verification
again, even after the original dispatch deadline. It never launches another fixer
or bypasses proof, escalated-path or current-base checks. Success restores the
interrupted turn or carries the recorded approval through the normal merge path;
a repeated failure stays blocked.

For transition recovery on an older release without these paths, first confirm
there is no live fixer with `worker status <pr>` (stop it with `worker stop <pr>`
if necessary; unknown status is not proof of safety). Check the PR's current base,
mergeability and green CI, then remove only that PR's
`<state-root>/conflicts/<pr>.json` record. The state root is
`${XDG_STATE_HOME:-$HOME/.local/state}/vmethod/<stateName>`. Do not remove another
PR's record or an owned lock. Removing a record does not certify a resolution or
carry approval; use the normal review/merge gates afterward.

If the head already contains the fetched live base and is not conflicting, the
command reports `nothing to resolve for #n` without a comment, board change or
update-branch call. GitHub's specific update-branch 422 response saying there are
no new commits on the base branch is also an up-to-date success. Other API or
gateway errors remain errors reported to the orchestrator, not BLOCKED comments
or board transitions; only genuine conflicts beyond the limits are escalated.

1. A clean merge preview uses GitHub update-branch with the expected head SHA and
   waits for CI. No agent is started.
2. An existing reachable worker gets the fixed line
   `CONFLICT: merge origin/<base>, resolve keeping both sides' behaviour, push, wait-checks, READY`.
   The gateway chooses the ungated, priced family with the lowest input-plus-output
   list rate on the same backend (family name breaks ties). A busy turn queues the
   switch until idle. Normal review resumption restores the original model only
   after the conflict turn becomes idle; an ANSWER/REVIEW notification received
   while it runs is queued, not allowed to switch it back early, and it follows
   the stale-wake rule under [Task-flow commands](#task-flow-commands) at the
   drain. Both
   switches retain usage baselines and post the normal model NOTE, but never edit
   the card's Model: the cheaper family is temporary session state only.
3. Otherwise a generic fixer starts in the PR's guarded linked worktree on the
   cheapest ungated, priced family without changing the card's Model. Its fixed prompt limits edits to conflicted
   hunks, requires any installed merge-scope verify hook and CI, forbids merging, and requires
   `[worker] BLOCKED` with conflicting files when it cannot comply.

A step-2 or step-3 dispatch turns the card over to the fixer: Progress shows 💥
and the assigned worker holds the assignee. The interrupted card turn (Status,
Progress and assignees) is stored with the resolution record. On RESOLVED the
card returns to that stored turn after the live card is re-read: an owner
approval found between dispatch and resolution is kept, the restore writes
verifying Progress, releases the managed fixer turn, and the resolution event
reports `owner approval kept`; on BLOCKED the escalation hands the PR to the
orchestrator with 🤖🚫 instead. Conflict dispatches and escalations never move a
card out of **Approved**: the dispatch write changes Progress and the worker turn
only, an escalation on an approved card keeps the Approved column and reports the
kept approval, and the dispatch line reports `owner approval kept` when it finds
the approval the resolution may carry. An owner move to Approved in the same poll
cycle is therefore still read and reported by the board poll that follows.
While the dispatched fixer runs, its own comments
and commits keep that card instead of reviving it, so the resolution stays
visible where people look; a terminal resolution also supersedes the conflicted
turn's queued card moves. Each dispatch posts one audit line,
`[orchestrator] NOTE: resolving a conflict with <base> (step <n>, <model>)`,
so the fixer's activity is explained on the PR thread; a card write that fails is
reported and the record remains, but reconciliation never repeats the dispatch
or the note.

The gateway independently checks the two merge parents, every remerge-diff path
and the full-context textual patch. Changes outside conflict-marker regions,
nontextual/rename/mode conflicts and unsupported evidence fail closed. Passing this
syntactic check does not prove semantic equivalence. Agent resolutions and approval
carry require the exact resolved head to
be present in a clean worktree; the executable project verify hook runs with
`--scope merge` for generic fixers and approval carry, without gateway credentials.
Current-base CI must also be green. An unapproved clean update needs no worktree or hook.
In this conflict-resolution path only, an absent hook is explicitly skipped, with
one notice per persisted resolution (including retries), and CI remains mandatory.
An installed failing hook blocks. This does not weaken the
missing-hook refusal for ordinary `merge-task` with `requireCurrentBase: false`;
legacy `checks.verify` strings are not substituted in either path.
The overall operation has a one-hour limit and a two-minute worker-start grace.
An interrupted dispatch reports an error for inspection rather than being replayed blindly.

Optionally configure `conflicts.escalatePaths` as path globs in `vmethod.yaml`:

```yaml
conflicts:
  escalatePaths: ["src/physics/**", "src/network/per-tick/**"]
```

A resolution touching those paths always escalates for owner review, even when
the fixer proposes a valid patch. Unset means no additional escalation; vmethod's
own configuration leaves it unset.

Only approval verified on the pre-conflict head can be carried automatically.
With every guard green, the gateway pins the resolved head and invokes
`merge-task --carry-approval` with the certification
"conflict-only resolution; remerge diff limited to conflicted hunks; verify and CI green".
Normal merge approval, scope, session, CI and head/base-race gates still apply.
If automatic merging is refused, the resolution record is retained and the watcher
emits `RESOLVED #n: auto-merge refused (<reason>); merge manually when ready` once
per PR and head. It does not retry automatic merging or repeat local verification
for that resolution. Address the refusal and merge manually when ready.
An unapproved PR stops resolved and waits for review. A worker's BLOCKED or QUESTION
prevents carry even if a pushed patch looks syntactically valid. The gateway posts
an orchestrator escalation note rather than impersonating a worker when its own
independent checks refuse certification.

Watcher terminal events are `RESOLVED #n (step k)`,
`MERGED #n (conflict-only, approval carried)`,
`conflict on #n resolved outside the fixer`, or
`BLOCKED #n: conflict escalated (<reason>)`. Pending work does not wake the
orchestrator just to repeat CONFLICT. State and locks live under the configured
per-user state root, not in the package checkout.

The per-PR lock is owned like the watcher's: a `0700` file holding the
reconciling process's pid and process start time. A reconcile clears a lock
whose owner no longer runs — including a lock left by an older release, whose
empty directory carries no owner at all — and continues normally. A live owner
reads as a quiet in-progress pending line and never blocks or fails the
reconcile, so a watcher killed mid-resolution cannot wedge later reconciles
behind a stale lock.

### Task worktree cleanup

After confirming a merge and stopping its worker, `merge-task` journals a `worktree`
step that removes the task tree, prunes Git worktree metadata and deletes its local
branch. Recovery retries unfinished cleanup; completed steps are not replayed.
Pack branches are retained. A safety skip reports the path and reason without
blocking the other merge follow-up steps.

Before removing an eligible tree, a separate journaled `session` step hides the
stopped opencode session from OpenChamber by setting
`metadata.openchamber.work.state` to `closed`, with `closedAt` and
`closedBy: vmethod`. It reads and preserves all other metadata, including links;
it never deletes the session, title or history. Already-closed sessions are a no-op.
Claude sessions are skipped because they have no OpenChamber list. A PR with no
worker record was never worked by vmethod: it has no session to hide and the step
completes without contacting any backend. A failed update
reports `session not closed: <reason>` without failing the merge; recovery retries
the unfinished session step.

Before any removal, cleanup also captures the stopped worker session's final usage:
one status poll stores tokens, USD and the model segments in the PR's worker record
under the gateway state directory, and the record is marked captured (#262). A failed
capture reports `usage not captured: <reason>` and retains the tree, so removal is
retried together with the capture. Every cleanup path (merge follow-up, `worker stop
--cleanup` and `worktrees --prune`) runs the same capture through its hook.

OpenCode requires the session's location directory for PATCH. If an old task's
tree is already gone and the update returns 404, cleanup temporarily creates an
empty directory at the recorded, validated path and retries. It removes only its
own empty placeholder afterward, never an existing directory or newly added files.

Use `vmethod worker reopen <pr>` to show an old recorded opencode session again for
inspection. This sets its work state to `open`, preserves the remaining metadata
and does not restart the worker or recreate its worktree. Claude is a no-op.

For a task closed without merging, the watcher reports a cleanup candidate. Run
`vmethod worker stop <pr> --cleanup` to interrupt its recorded session and attempt
the same guarded cleanup and session closure. Stopping alone never removes files
or hides sessions.

Use orchestrator-only `vmethod worktrees` to list merged/closed task trees and their
sizes in allocated KiB, with a total of removable space. `vmethod worktrees --prune`
rechecks the guards, removes eligible trees and reports the total actually freed.
It also closes their stopped opencode sessions with the same best-effort update.
Size measurements are best-effort, with a separate two-minute timeout per tree.
A failed or invalid measurement prints `size unknown` and does not prevent listing
or guarded pruning of that tree or later trees. Totals show the measured KiB plus
the count of eligible/removed trees with unknown sizes, never treating unknown as zero.
This uses the existing orchestrator-only `worker` transport operation. It never
stops sessions implicitly. Open tasks, ambiguous branch reuse and foreign PR heads
are not cleanup candidates.

Cleanup only touches registered trees under this repository's configured
`branches.worktreeRoot`, with `branches.worktreePrefix` and an exact task-branch
match. Main/current checkouts, symlink aliases and other repositories are refused.
Tracked modifications and untracked non-ignored files are retained; ignored files
such as `node_modules` and `.tmp/` may be removed. Local commits must be reachable
from the merged PR head or the local base branch; for an unmerged closed PR, only
the base proves containment. Otherwise cleanup reports unpushed work and retains
the tree. A live or unresolvable recorded session, unavailable commit objects or
failed safety read also retains data; a PR without any worker record is treated
as absent (#275), not unknown, and never retains data for a session that does not
exist. Inspect the reported reason before retrying; do not bypass
these checks with a manual forced removal.

Merge follow-up journals live in the per-user state directory. A partial failure
resumes board, issue, branch and checkout work without merging again. Already-merged
owner button merges receive the same follow-up; bad historical titles only warn.
After a merge, worker shutdown is best-effort and its outcome is reported; live or
unknown sessions do not block recovery. A PR whose worker record exists but cannot
be resolved still gets today's cautious treatment: the failed stop is reported and
cleanup retains the tree until inspected. A PR with no worker record, for example a
hand-made task PR, was never worked by a vmethod worker: the follow-up skips the
stop silently, needs no session close and its eligible worktree is removed (#275).
The remote branch head is then re-read.
Any commits beyond the merged PR head are reported as
`post-merge commits on <branch>: <shas>` and the branch is kept for a follow-up PR.
Otherwise cleanup continues with issue closure, board Done, branch deletion and
checkout fast-forward. Installation remains last. Watcher merge events name
`merged_by` and suggest `run merge-task`; the watcher never performs follow-up.
Issue resolution prefers the structured task header, including its partial flag,
then the existing task marker. Without either, a legacy `Part of #n` line prevents
issue completion; otherwise same-repository GitHub closing references take
precedence over legacy `Closes #n` and `Agent task for #n` lines. Legacy lines
accept a leading blockquote, bold markers and a trailing period. Branch numbers
are never issue relations and no sibling-PR scan is performed. Explicit legacy
relations emit a `legacy link` notice; absent relations report `no linked issue`
and leave issues unchanged. Old empty journals reconcile newly discoverable issues.
Completed follow-up is checkpointed as `follow-up` in `merge-<pr>.json` before any
reinstall; failed follow-up does not mark completion. For same-account merges,
the watcher waits until ten minutes after the merge and while an incomplete journal
was modified less than ten minutes ago. If follow-up remains incomplete after both
grace periods, it reports `follow-up not run: run merge-task` once. An interrupted
journal therefore ages out rather than suppressing the notice forever. Completed
journal-matched own merges stay silent; unmatched self-merges report another
session with `follow-up complete`. Owner button
merges notify normally; after follow-up completes they stop repeating.
Obsolete `.turn-*` and `merged-*` stamps are imported once to preserve old
suppression state, not written by verbs anymore. Done capping ranks all board repositories but archives
only this repository's cards after the newest six. Keep the main checkout clean on
the configured base branch before retrying its fast-forward. Install is the final
effect, after all follow-up is checkpointed, with no token environment or second
CLI process. Pending installs may safely repeat after an interrupted run.

## Approval and testing

`isOwnerApproved` returns `true`, `false` or `'unknown'`. A verified owner review
must be APPROVED on the current head. For board approval, only events on the
configured `board.number` count, and the latest status-change event must be
Approved by an owner. It must occur strictly after the latest verified
`[orchestrator] OWNER REVIEW` comment naming the full current head SHA. Without
that handover, approval is false. A later move away from Approved or a new head
invalidates the old board approval. Edited handovers use their edit time, not a
backdated creation time. Missing actors on the latest Approved event yield unknown,
not approval.
Current card Status is a position gate, not approval evidence; `merge-task` requires
Approved as well as authenticated owner evidence. Peer-session relays never approve. Chat approvals remain
the harness's responsibility and are never synthesized into GitHub records.

For merge-task only, an approval can survive clean merges of the PR's base:
the gateway verifies the first-parent chain, recomputes every two-parent merge tree
without conflicts and compares the full binary task patch on the union of task
paths against old/new merge-bases. Ordinary commits, edited merge trees or changed
patches void approval. The client cannot assert this exception. Issue launch
approval checks an authenticated Spec review → Executing move bound to the latest
SCOPE REVIEW body hash, or the Scoping → Executing trivial shortcut. `open-task`
also requires the issue in Executing. `scope-review` records the live Estimate and
hash in Spec review; revise the Estimate and explain it in the summary first.
NEXT selects Scoping (including blocked discussion), SCOPE selects issues needing
their final rewrite in Spec review, and LAUNCH selects unblocked, scope-approved
Executing issues without open task PRs. Historical scope approvals preceding v6
migration remain evidence while the body is unchanged. See [board migration v6](board.md#migrations-what-adopters-see)
for evidence-dependent remapping and per-card dry-run output.

Orchestrators may explicitly carry an earlier verified owner approval across
conflict-resolving base merges with `--carry-approval "<reason>"`. The reason must
be nonempty and single-line. Every task-side commit since that approved SHA must
be a two-parent merge with one parent on the current PR base's history; either
parent order is accepted. Ordinary commits, missing approval, unrelated histories
or unavailable git proof refuse and require fresh owner approval. The gateway
posts `[orchestrator] APPROVAL CARRIED from <A> to <head>: <reason>`, a no-behaviour-change
certification and the union of `git show --remerge-diff` file lists before merging.
An empty list is recorded explicitly. This is an orchestrator semantic assertion,
not an automated proof of unchanged behaviour: behaviour changes or an algorithmic
revamp require re-asking the owner. All other merge gates and journaling remain
unchanged; see the [owner rule](orchestrator-guide.md#merge-and-release).

Tests inject strict fake fetch/exec, clock and sleep implementations. No test
needs a real GitHub token or opencode server. Base-merge proof tests also use
isolated local git repositories with real conflicts. Mermaid tests use
installed local peer fixtures. Optional peer usage is intentional, so Knip's
referenced-optional-peer rule is disabled; other dependency checks remain enabled.
A static syntax test guards the seam against fetch calls and credential reads
outside `src/gateway/`.
