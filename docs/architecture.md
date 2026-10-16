# vmethod architecture

Status: **draft 3**, under review in [#1](https://github.com/vworlds/vmethod/issues/1). The
inputs were the SpaceRocks and vecs answers plus their reviews of drafts 1 and 2. The owner's decisions
are recorded under [Owner decisions](#owner-decisions-1).

## Goals

- One home for the VWorlds development methodology: roles, lifecycle, board, comment protocol,
  worker and orchestrator guides, and the tooling that runs them.
- Consumer projects (first `vworlds/vecs` and `vworlds/spacerocks`) pin a release and keep only
  project-specific settings locally. Nothing is copied by hand, so nothing drifts.
- vmethod runs on vmethod (dogfooding).

## Mounting: vendored copy pinned to a tag

A consumer repo holds **`.vmethod/`**, a plain copy of one vmethod release. Nobody edits it locally.
We chose this over a git submodule because:

- consumers run a dozen or more `git worktree`s, and each would need a submodule init;
- in some projects workers run as another OS user (vecs: `jm` for workers, `vecsmaster` for the
  orchestrator), and sharing `.git/modules` across users is risky;
- CI copies the repo without git (SpaceRocks' `Dockerfile.verify`);
- `merge-task.sh` fast-forwards the main checkout, which would leave a bumped submodule silently
  stale.

| Command | Effect |
|---|---|
| `.vmethod/bin/vmethod sync <tag>` | Replaces `.vmethod/` with the tag's tree, writes `.vmethod/VERSION` (tag + tree hash) and regenerates the wrappers. The adoption PR is an ordinary, reviewable diff. |
| `vmethod check` | Offline, needs no git. Fails if `.vmethod/` differs from the manifest of hashes in `VERSION`, if `vmethod.conf` fails the schema, or if a declared dependency is missing (exit 2, "dependency missing"). For CI. |
| `vmethod check --online` | Also fails if the board's version (README block) is below the release's `BOARD_VERSION`. Opt-in. |
| `vmethod board status` / `migrate` | Shows the board's version and pending migrations / replays them, verifies, and bumps the version. See [Board schema and migrations](#board-schema-and-migrations). |

**Wrappers.** `sync` writes `scripts/agent/<x>.sh` and `scripts/orchestrator/<x>.sh` as one-line
`exec "$(dirname "$0")/../../.vmethod/scripts/..." "$@"` stubs (no git needed), each marked
`# vmethod wrapper`. The paths workers already know keep working. Because of `exec`, `$0` is the
real `.vmethod/...` path, so `$(dirname "$0")/../lib` still works. Scripts must therefore derive
the **repo root** from `git rev-parse --show-toplevel` (or `VMETHOD_ROOT` in git-less CI), never
from `$0`. A test runs every wrapper from a fixture consumer tree. `sync` never overwrites a file
that lacks the marker, so project scripts can sit next to the wrappers. A script that vmethod
renames keeps a one-release alias.

**Dependencies.** The release manifest declares the external tools and packages its scripts
need, and marks each required or optional:

- required: `gh`, `jq`, `flock`, `timeout`, `setsid`, `sha256sum`, `python3`, `node`, and the npm
  packages `mermaid` (pinned to GitHub's renderer version) and `jsdom`;
- optional, per worker backend: `opencode`, `claude`.

The consumer provides them. `check` verifies the required ones, so CI without workers still passes.

**Consumer checks ignore `.vmethod/`.** That covers Prettier, ESLint, knip, jscpd,
dependency-cruiser, `tsc` and similar. The `AGENTS.md` template and `vmethod.conf.example` list the
ignores to add. vmethod tests and formats itself in its own CI.

## Parameterisation

### `vmethod.conf` (per project)

Shell-sourceable bash at the repo root, with arrays allowed. It is validated against
`.vmethod/config.schema`, which is versioned. Environment variables override it, so track
sessions can still set e.g. `VECS_TRACK` / `VECS_BASE`, which become `VMETHOD_TRACK` and
`VMETHOD_BASE` with the old names accepted as aliases.

| Group | Keys (indicative) |
|---|---|
| Identity | repo slug, base branch, release branch, owner / orchestrator / worker logins, worker OS user |
| Board | `BOARD_OWNER`, `BOARD_NUMBER`, `BOARD_REPOS` (all repos on the board; >1 = shared). The shape comes from `board/schema` |
| Branches | task-branch pattern, worktree root, main checkout path, pack and track prefixes |
| Checks | verify steps, release pre-check steps, docs Markdown glob, CI check names |
| Post-merge | dependency install command and its trigger file (e.g. `npm ci` / `package-lock.json`) |
| Changelog | fragment directory (e.g. `architecture/unreleased/`), tag vocabulary |
| State | `STATE_NAME`: watcher state directory name (vecs: `vecs`), so existing `once`/`graded`/`merged` markers and the lock survive adoption without replaying old events (SpaceRocks: `spacerocks`). The merged watcher must read both projects' marker names (e.g. vecs `graded-<n>`, SpaceRocks `grade-<n>`) |
| Credentials | env var **names** only (GH token, SSH key, opencode server password). Never values |

`models.tsv` stays a project file: provider/id, kind and `gate` column (e.g. owner-gated models
need `--owner-approved`, enforced by `open-task` and `start-worker`). Its family names must come
from `board/schema`'s Model options.

### Board schema and migrations

The board's shape is part of the methodology: Status options, fields (Estimate as a number of
points, Model options, Progress text), the Progress emoji table, and the "Done keeps the last 6"
policy. Boards change the way databases do, through **versioned migrations**. Nothing is
destroyed and rebuilt.

`vmethod.conf` names the board (`BOARD_OWNER`, `BOARD_NUMBER`) and lists `BOARD_REPOS`, every repo
whose cards live on it. One repo means a dedicated board (vmethod: project 5); several mean a
**shared board** (vecs and SpaceRocks: project 4).

**Board version, stored on the board.** Each board carries its version in its Project README, in
a machine-readable block that `migrate` owns:

```text
<!-- vmethod-board -->
version: 3
min_compatible: 2
migrated: 2026-11-02T10:14Z by spacerocks79 (vmethod v1.1.0)
<!-- /vmethod-board -->
```

The README is also human-edited (board notes). `migrate` rewrites only the text between the
markers, re-reads the README just before each write, and refuses to write if the markers are
missing (except on the first `migrate`, which appends the block) or duplicated.

A board with no block is version 0 (unmanaged). `min_compatible` is the lowest `BOARD_VERSION`
whose scripts still work on this board. Expand migrations leave it alone; a contract migration
raises it.

**Scripts on a board that is ahead of them.** Every script reads the block once per run, from
the same poll it already makes.
- If `BOARD_VERSION < version` but `≥ min_compatible` (the board was only expanded), the script
  keeps working and prints one `BOARD AHEAD: sync vmethod` notice per run.
- If `BOARD_VERSION < min_compatible` (a contract it doesn't know about), it refuses every board
  write with `BOARD INCOMPATIBLE: sync vmethod ≥ <release>`. Reads still work.

**Migrations ship with vmethod** as an ordered, append-only list: `board/migrations/0001-baseline.json`,
`0002-…`. Each one holds:
- `up`: a list of operations, e.g. `add_field`, `add_option`, `rename_option` (moves cards),
  `set_option_meta`, `add_progress_alias`, `rewrite_progress`, `remove_option`, `remove_field`;
- `expect`: the board shape after it;
- for a destructive step, `requires`: the minimum vmethod version every `BOARD_REPOS` repo must
  have adopted.

A published migration is never edited; a fix is a new migration. Each vmethod release declares
the board version it needs (`BOARD_VERSION` in the manifest). `board/schema` is the shape after
the latest migration, generated from the migrations and used by the scripts.

**`vmethod board migrate`**, run after every `vmethod sync <tag>` (the adoption checklist and
`sync`'s closing message say so):

1. **Read** the board's version N from the README block, and the target version from the release.
   If the board is already at or above the target, do nothing; it never downgrades.
2. **Lock.** A Project README has no compare-and-set, and orchestrators get no write access to
   vmethod. Instead the lock is a **field on the board itself**: field names are unique within a
   project, and every orchestrator on a board can already create fields there.
   - **Acquire.** `createProjectV2Field(name: "vmethod-migration-lock", dataType: TEXT)`. Exactly
     one concurrent caller succeeds. The others get an error ("Name has already been taken", or
     a generic error under a race), and any error means "not acquired". This was verified live on
     project 5 on 2026-10-16: 6 rounds of 2–3 concurrent creates, exactly one winner and one
     field each time.
   - **Holder.** The winner writes `lock: <run-id> <login> since <time>` into the README block.
     The field with no fresh README line, or a line older than 1 h, is stale (a crashed run, or
     a winner whose success response was lost). `migrate --steal` then deletes the field and
     re-creates it.
   - **Hold.** Before each migration and each version bump, re-read and confirm both the field
     and our `run-id`.
   - **Release.** `deleteProjectV2Field` on success. **A budget stop is not a crash:** it
     releases the lock and records `paused at <migration>/<op>` in the block, so any adopter
     resumes without `--steal`.
   - It costs two mutations per run and nothing on the poll path. While it exists, the field
     tells humans a migration is in progress. Watchers ignore field-list changes for it.
   - Offline tests use a fake board: concurrent acquirers, stale lock and steal, budget pause.
3. **Replay** migrations N+1 … target in order. Every operation is idempotent (it checks before it
   acts), so a run interrupted by an error or the GraphQL budget resumes where it stopped.
4. **Verify** the live board against the migration's `expect` after each migration.
5. **Bump** the version in the README, and only then move on. If a verification fails, it stops
   at the last verified version, leaves the lock with the error, and exits non-zero.

`vmethod board status` shows the version, the pending migrations and the diff against `expect`.
`--dry-run` prints the operations without running them. `vmethod check --online` fails while
the board's version is below the release's `BOARD_VERSION`.

**Baseline (version 1)** is the shared board, project 4, exactly as it is on 2026-10-16. It is
stamped by hand into the README block, as Flyway's baseline is, and `0001-baseline.json` makes no
changes. Its `expect` lists only the fields vmethod owns, with their exact option order:

- **Status:** Backlog, Ready, In progress, In review, Approved, Done.
- **Model:** sol, luna, astra, sonnet, opus, glm, big-pickle, glm-flash, other.
- **Estimate:** a number, by convention 0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999.
- **Progress:** text. Its states are hold ⛔, working 🤖🔨, question 🤖❓, design 🤖📐,
  blocked 🤖🚫, ready 🤖👍, verifying 🧭🔍, owner-review 👤🔍, owner-question 👤❓, conflict 💥,
  silent ⏳, permission 🔑, failed 🪫, idle 💤. A round is `🔁` plus keycap digits, and red CI is
  🔴. The stuck states are silent, permission, failed, idle and conflict. vecs and SpaceRocks
  have identical tables today.
- **Policy:** Done keeps the 6 most recently closed cards across repos; each repo archives only
  its own cards.

GitHub's built-in fields and unused template fields (Priority, Effort, Start date, Target date)
are outside `expect`, so adding or removing them is never "drift". Projects 4 and 5 were stamped at version 1 on 2026-10-16.

**Shared boards: expand, then contract.** The projects on one board can be pinned to different
vmethod versions, and every one of them must keep working. So a breaking change (a rename or
removal) is always split into two migrations, shipped in different releases:

- **Expand.** Add the new field or option, move the cards (`rename_option` migrates each card
  before anything is deleted), and add Progress aliases so that both old and new scripts parse
  every card. Safe for everyone.
- **Contract.** Remove the old option or alias. It carries `requires`. `migrate` reads each
  `BOARD_REPOS` repo's `.vmethod/VERSION` from that repo's configured base branch, and checks
  that open track and pack branches have synced. Until all of them qualify, it stops cleanly
  before the contract ("waiting for vworlds/vecs to adopt ≥ v1.2.0"). In practice, the last
  project to adopt applies the contract.

On a dedicated board, `requires` is trivially met, so expand and contract run back to back.

**Running migrations safely:**
- **Quiet watchers.** `migrate` posts `[vmethod] board migration <N>→<M>` on the release issue,
  and stamps every card move it makes. Watchers stay silent on stamped moves, so the other
  project's orchestrator is not woken once per card.
- **GraphQL budget.** Mutations are batched (aliases in one request) and paced on the rate-limit
  response headers. A run stops above a reserve with "N cards left", and resumes with the next
  run.
- **Built-in project workflows.** Projects v2 automations (e.g. "item closed → Done") and Status-driven
  watchers react to card moves. `--dry-run` of a migration that touches Status lists the
  active built-in workflows. Review them before a Status contract.
- **Tests.** A fake board runs every migration from 0 and from each intermediate version, with
  cards on the old options, two watchers, an interruption mid-migration, two concurrent runs
  against the lock, and old scripts against an expanded and a contracted board.

**Cross-repo scope rule.** On a shared board, every script acts only on cards from its own
`REPO_SLUG`: Done capping, archiving, `GRADE`, `NEXT` / `LAUNCH`, and Progress writes. This is one
generic rule with tests, not a per-copy hard-code. (`migrate` is the one exception: it acts on the
board as a whole.)

### Hooks (behaviour that differs)

Where behaviour differs, not just data, the generic script calls an optional project hook,
`scripts/vmethod-hooks/<name>.sh`. Examples: the verify recipe (SpaceRocks' `Dockerfile.verify`
stages), release and beta publishing (vecs' npm flow, `published-packages.txt`), post-merge. Purely
project tools (`drift-report.sh`, `update-vecs`) stay project scripts.

## vmethod repository layout

```text
bin/vmethod                         sync | check | version
scripts/{agent,orchestrator,lib}/   the merged tooling
tests/                              bash, offline fakes for gh/git/npm, every test under `timeout`
board/migrations/, board/schema    ordered board migrations; shape after the latest one
docs/                               the methodology (see below)
templates/                          AGENTS.md routing template, vmethod.conf.example,
                                    models.tsv.example, task-PR prompt, check ignores
config.schema                       vmethod.conf schema
```

A consumer's `AGENTS.md` (with `CLAUDE.md` symlinked to it) stays a project file. Built from the
template, it routes to `.vmethod/docs/*` for the generic process and to the project's own domain
and engineering docs. Generic docs never name project files or commands. They refer to config
keys ("run the verify steps, `VERIFY_STEPS`").

## Methodology content for 1.0

- **Roles:** owner (decides), orchestrator (plans, briefs, reviews, merges; writes no feature
  code, owns tooling and docs), workers (one task PR each, own worktree), side and track sessions,
  collaborators.
- **Lifecycle:** idea → issue developed until agreed → owner moves it to Approved → `open-task`
  writes the draft task PR, whose body is the worker's prompt → worker → review rounds → owner
  approval → `merge-task`. Shortcuts: `--direct` (the owner's "go" in chat) and `--unapproved`
  (opened before Approved, with the reason stated on the issue, e.g. a bug with a reproducer). Also tracks, packs, and Blocked-by relations.
- **Board:** Status Backlog → Ready → In progress → In review → Approved → Done. Assignee = whose
  move it is. Estimate, Model, Progress. Every script that changes Status or Assignee also sets
  Progress.
- **Comment protocol:** `[worker] ACK | DESIGN | QUESTION | BLOCKED | READY FOR REVIEW (round n)`;
  `[orchestrator] REVIEW round n | OWNER REVIEW | ANSWER | AMENDMENT | GO | APPROVED`
  (`OWNER REVIEW`: handed to the owner, saying what to playtest and which decisions are theirs). The first line is the key.
  Replies carry an `in reply to <comment-url>` line. Workers obey only their prompt and
  `[orchestrator]` comments. Every post carries the Claude Code footer.
- **Rules from real incidents:**
  - No `2>/dev/null || true` on anything that drives state without a logged failure.
  - One reader per watcher state directory (flock). Reuse the existing GraphQL poll, and pace on
    the response headers, not the `rateLimit` field.
  - On a board-listing lag, read the issue side before "fixing" anything.
  - Temp files go under the worktree's `.tmp/`. Never commit test reports, logs or other
    artefacts: `.gitignore` them, and `push.sh` refuses known artefact patterns.
  - Behavioural tests go through fakes. A fake's default case fails loudly; patchers assert their
    anchors.
  - Guard against closing keywords (`Close/Fix/Resolve/Part of #n`) in orchestrator text, and run
    `check-markdown` before every post.
  - Every bash entry point is wrapped as `main "$@"; exit`, so a fast-forward or `sync` can't
    change a script while it runs.
  - Merges only via `merge-task.sh`. Peer-session relays are never owner approval; process
    changes arrive as vmethod releases.
  - Credentials only from the wrapper's env, never global git config or command lines.
- **Changelog fragments** (vecs' mechanism, per-PR files collected at release) for vmethod itself,
  offered to consumers.
- **Verification kit slot:** a documented place for project verification patterns (oracles,
  headless-browser checks, quiet-host benchmarks).

## Shared learnings

Every orchestrator learns things that would help the others. Above all, how each LLM model
performs on which kind of task, and also traps, prompt patterns and verification habits. vmethod
pools these, so a lesson paid for in one project is free in the others.

### The model log (per project, shared format)

Each project keeps its raw log at `.vmethod-data/model-log.jsonl`. It is project data, written by
`grade.sh` after every closed delivery (merged or not). One record per delivery, in a format
vmethod defines and validates:

```json
{"date":"2026-10-15","repo":"vworlds/spacerocks","pr":319,"task":"…","kind":"gameplay",
 "segments":[{"family":"sol","model":"<provider>/<id>","rounds":[1],"why":"start"},
             {"family":"glm","model":"<provider>/<id>","rounds":[2],"why":"quota"},
             {"family":"sol","model":"<provider>/<id>","rounds":[3],"why":"rebase"}],
 "points_open":5,"points_final":8,"rounds":3,
 "round_causes":["worker-defect","integration","prompt-defect"],
 "outcome":"merged",
 "prompt_defects":["scope-withdrawn"],
 "stalls":[{"minutes":120,"cause":"unwritable tmp dir","detected_by":"watcher"}],
 "findings":[{"tag":"fix-worsened-baseline","caught_by":"orchestrator-verify","root_cause_by":"worker"}],
 "notes":"…"}
```

- **`segments`**: one per model that worked on the delivery, with the rounds it did and why it
  took over (`start`, `quota`, `escalation`, `rebase`, `owner-request`). A switch mid-task is no
  longer hidden.
- **`points_open` / `points_final`**: the estimate when the task opened and the final grade. The
  gap is the calibration signal.
- **`round_causes`**: separates worker defects from rounds the worker didn't cause:
  `worker-defect`, `design-change`, `playtest-design-change`, `owner-question`,
  `new-requirement`, `integration`, `prompt-defect`. A `prompt-defect` comes with
  `prompt_defects` sub-causes (`under-specified`, `scope-withdrawn`, `wrong-premise`). The model's
  record stays fair, and the orchestrator's briefs get graded too.
- **`stalls`**: periods a worker sat silent, with minutes, cause and `detected_by`
  (`watcher`, `orchestrator`, `owner`). Silence is a cost in its own right, and this measures how
  well the watcher's SILENT detection works.
- **`outcome`**: `merged`, `rejected-in-playtest`, `reassigned`, `abandoned`. A delivery whose
  metrics pass but which the owner rejects in playtest is among the most valuable records.
- **`findings`**: each entry has a tag from the shared vocabulary and `caught_by`
  (`worker-tests`, `ci`, `orchestrator-verify`, `owner-playtest`, `post-merge`), which shows
  which gate earns its cost, and, for defects, `root_cause_by` (`worker`, `orchestrator`). The
  latter separates implementing a brief from debugging. The vocabulary includes, among others:
  - quality: `clean`, `weak-tests`, `test-reads-source`, `silent-patch-harness`, `duplication`,
    `scope-creep`, `cheap-workaround`, `swallowed-failure`, `budget-regression`,
    `fix-worsened-baseline`, `metrics-pass-feel-fails`, `missed-root-cause`, `doc-misplaced`,
    `committed-artefacts`;
  - conduct: `silent-stall`, `retry-reported-as-blocked`, `ran-full-suite`,
    `crossed-messages`;
  - credit: `found-root-cause`, `security-catch`, `good-design-question`, `stop-and-ask`,
    `could-use-cheaper`.

  New tags are added through `learning` PRs.
- `points` follow the shared estimate scale.

The model is graded on the outcome, not on the size of the task.

Both existing logs are hand-kept tables: vecs' `.agents/model-log.md` and the "Model log" in
SpaceRocks' `docs/agents/orchestrator.md`. They are converted once, at adoption. `grade.sh`, which
today only writes the board's Estimate, gains the log writing.

### Contributing back

- **Mechanical, continuous.** `vmethod learnings submit` sends the log records added since the
  last submission (and the project's distilled notes) to vmethod as a PR labelled `learning`. Its
  target is `learnings/models/<repo>.jsonl`. Orchestrators run it after each grading round, or at
  least once a week.
- **Distilled, by the vmethod orchestrator.** After merging submissions, the vmethod orchestrator
  updates `learnings/models/<family>.md`: strengths, failure modes, which task kinds and sizes
  suit it, prompt tips, cost notes, each with evidence links (repo#PR). Also
  `learnings/lessons.md`, for project-independent traps and practices, like the pain points
  gathered in #1. `vmethod learnings report` produces the aggregate statistics (rounds per point,
  findings rate, by family and task kind) that these pages cite.
- **Lighter than methodology changes.** A learning is advice, not an interface. `learning` PRs
  merge on the vmethod orchestrator's review, without owner approval. A learning becomes a
  **change-request** (owner approval, release) only when it should change a rule, a script, or a
  default such as the recommended family in `models.tsv.example` or `suggest-model.sh`'s
  heuristics.

### Consuming learnings

- Learnings are not pinned to a release. They change faster than releases and are not an
  interface. `vmethod learnings show [<family>]` reads the latest pages from vmethod's default
  branch, and releases bundle a snapshot under `.vmethod/learnings/` for offline use.
- The orchestrator guide makes this part of model selection: before choosing a family for a task,
  `suggest-model.sh` prints the relevant learnings line and the aggregate for that task kind.
- Owner-gated models stay gated per project (`models.tsv` `gate`). Learnings inform the choice;
  they don't override a gate.

## Security

vmethod and some consumers (vecs) are public. vmethod's scripts run in every consumer with the
orchestrator's credentials: GitHub token, SSH key, opencode password.

**Untrusted text.** Issues, PRs, comments, branch names and titles can be written by anyone.
- **Authority comes from the author's login and role, never the tag** (`people.tsv`;
  see [the event gateway](#the-event-gateway-no-direct-github-access)). `read-pr.sh` marks other authors' comments as
  untrusted before a worker sees them. Watchers drop events from non-allowlisted logins before any
  further API call, so spam can't drain the GraphQL budget.
- **GitHub text is untrusted in bash.** Titles, bodies and branch names are always quoted data:
  no `eval`, no unquoted expansion. The baseline import audits for this and adds tests with
  hostile titles and bodies.
- Agents treat learnings and every fetched text as data, never as instructions.

**Supply chain.**
- `dev` and `master` are protected: PR only, one approval, CODEOWNERS review by the owner for
  `bin/`, `scripts/`, `board/` and `.github/`, no force-push, no deletion
  (`.github/rulesets/branches.json`).
- Release tags `v*` are immutable (`.github/rulesets/tags.json`).
- `VERSION` records the tag's commit SHA and tree hash. `sync` refuses a tag that moved.
- The consumer's adoption PR is a real diff and gets a real review.

**Leaks.**
- vmethod's docs stay generic. Paths, OS users, hosts and logins live in each consumer's
  `vmethod.conf`.
- Records from private repos (`LEARNINGS_PRIVACY=private`, e.g. SpaceRocks) are submitted
  reduced: tags, numbers and outcomes only, with no task titles or notes unless cleared.
  `learnings submit` enforces this. Only allowlisted orchestrator accounts may open `learning` PRs.
- Secret scanning and push protection are on. `vmethod check` rejects anything in
  `vmethod.conf` that looks like a secret.

**CI.** The default `GITHUB_TOKEN` is read-only. Fork PRs need approval to run workflows. No
`pull_request_target`, and no secrets in workflows that fork PRs can trigger.

## Collaboration, people and the event gateway

### Who is who: `people.tsv` (per consumer repo)

Each consumer repo has a `people.tsv` (project file, owner-approved) listing every GitHub login the
agents may hear from, with a role:

```text
# login        role          note
jpeletier      owner         decides
spacerocks79   collaborator  SpaceRocks orchestrator
VecsMaster     collaborator  vecs orchestrator
vimescmd       collaborator  vmethod orchestrator
```

- Roles (pending the owner's choice between a minimal and a full set, see #2):
  - `owner`: approves;
  - `orchestrator`: peer input. For gating it counts like `collaborator`: it can ask, but never
    approves or moves another project's cards to Approved;
  - `worker`: its comments drive READY / QUESTION handling;
  - `collaborator`: proposes and comments;
  - `system`: automation such as `github-actions[bot]` release commits, never instructions.

  Checks and CI runs are not comments and are never filtered.
- **The agent always knows who it is talking to.** Every event or text the toolset hands an agent
  is labelled `from <login> (<role>)`. Authority follows the role, never a tag or claim in the
  text: only an `owner` approves; a `collaborator` proposes, reviews and objects.
- `vmethod check` validates the file, and changes to it go through the owner (CODEOWNERS).

### The event gateway: no direct GitHub access

Agents never call `gh`, `curl api.github.com` or any GitHub API directly. Raw access bypasses the
people filter and exposes the agent to prompt injection. Every read and write goes through
vmethod's wrappers, which call GitHub internally:

- **Enforced, not just documented.** The hard stop is a permission rule: Claude Code
  `.claude/settings.json` denies `Bash(gh *)`, `curl`/`wget` to GitHub, and `git push` outside
  `push.sh`, and allows the wrappers. opencode gets the equivalent config. `templates/` ships both.
  **The owner installs them; agents never edit their own permissions.** `vmethod check` verifies
  that they are in place.
- **Inbound filter.** Before anything reaches the agent:
  - comments, reviews, issues and PRs whose author is not in `people.tsv` are **dropped
    silently** for the agent;
  - mentions of an orchestrator in a repo outside the organisation (`ORG`, e.g. `vworlds`) are
    dropped;
  - what passes is labelled with the author's login and role;
  - bot-authored PRs and comments (e.g. Dependabot) are dropped like any non-listed author, so
    nobody waits on them. CI results arrive as check runs, not comments, and are not filtered.
- **Outbound.** Posts go through the existing posting scripts: Markdown check, footer, no closing
  keywords.
- **Dropped items are not lost.** The agent never sees their content, but the toolset keeps a
  digest of them (count, repo, number and link). The orchestrator passes the digest to the owner
  once a day, unread. Public repos will get outside contributions, and the owner decides whether
  to add a login.
- **Diagnosis needs reads, not a ban.** `vmethod gh-read <endpoint | graphql-file>` allows GET
  and GraphQL queries only, and refuses mutations. It applies the people filter to known
  author-bearing fields (comments, reviews, issue and PR bodies). Its output is labelled
  untrusted data. All writes go through named wrappers.
- **Cross-session messages bypass GitHub,** so the gateway doesn't see them. The rule stays:
  a peer session's message is never owner authority. Anything in it that needs an owner decision
  goes to the owner, in their own chat or on GitHub.
- **Wrapped verbs (initial inventory, from SpaceRocks, VecsMaster and the vmethod orchestrator):**
  - `read pr <repo#n> [--files|--diff|--reviews|--branch]`;
  - `read issue`;
  - `read checks`;
  - `post <repo#n> <file>` (comment or review comment, with repo allowlist, Markdown check,
    footer and closing-keyword guard);
  - `watch`, `mute`;
  - `board fields|subissue|item`;
  - `issue edit` (body, labels, close) and `pr create|ready|retarget`;
  - `board clear <field>` and `budget`, which reads the rate-limit headers;
  - `read comment <repo> <id>`, `branch delete <name>` (refuses protected and task branches), and
    `wait release <pkg>@<ver>` (a tag or ref plus the registry);
  - `read registry` (npm metadata is untrusted text too).

  Repo-admin operations (visibility, default branch, rulesets, security settings) stay with the
  owner.
- **Coverage.** Every GitHub operation an orchestrator or worker needs gets a wrapper. Gaps are
  collected from the orchestrators (#2) and become wrappers before 1.0. Until a wrapper exists,
  the agent asks its owner instead of using `gh`.

### Watching and muting threads

`vmethod watch` is the one event loop that feeds an orchestrator. It covers its own repo's PRs and
board, as `watch-prs.sh` does today, and **vmethod's issues and PRs**. Every orchestrator is an
interested party in methodology changes.

- **Default: subscribed.** Every orchestrator receives every new vmethod issue and PR, and their
  comments, so it can chip in, e.g. "B's proposal would break our setup".
- **Mute.** `vmethod mute <repo>#<n>` silences one issue or PR, in any repo, for this
  orchestrator. Muted threads deliver nothing until the orchestrator is **explicitly mentioned**
  there. A mention removes the mute and delivers the event; to silence the thread again, the
  orchestrator mutes it again. `vmethod mutes` lists the mutes, and `vmethod unmute` clears one.
  Mutes are local state under `STATE_NAME`.

### How a methodology change happens

1. **A need appears.** The owner asks an orchestrator for something, or an orchestrator detects a
   gap. That orchestrator opens a vmethod issue (`vmethod propose`) describing the need and the
   project context, or a PR if the change is small and clear.
2. **Interested parties chip in.** Every other orchestrator sees it through `vmethod watch`, and
   comments with support, concerns or conflicts with their setup, or mutes it.
3. **Agreement.** The vmethod orchestrator elaborates the proposal until every orchestrator's
   concerns are resolved or explicitly overruled, and puts it to the owner.
4. **Decision and release.** The owner approves (Approved on the vmethod board, and an approving
   review on the PR). It ships in a release, and consumers adopt it with `sync` and
   `board migrate`.

## Versioning and change process

- SemVer tags `vX.Y.Z`. A breaking change to `config.schema`, a board schema or a script interface
  means a major version. Release notes list the added or changed config keys and the migration
  steps.
- Change requests:
  1. A consumer opens an issue with the `change-request` label.
  2. The vmethod orchestrator elaborates it.
  3. The owner accepts it (Approved).
  4. A worker implements it, and it ships in the next release.
  5. Consumers run `vmethod sync <tag>` when they choose.
- **Freeze rule (until both projects have adopted 1.0).** From the day the baseline import lands,
  every tooling fix made in a consumer's local copy also gets a `change-request` issue in vmethod,
  linked from that PR. Convergence picks it up.

## Road to 1.0 (parity first)

1. **Baseline import:** the tooling and vecs' bash test harness, with every entry point wrapped in
   `main "$@"; exit`. Add `vmethod.conf`, the schemas, `sync`, `check` and `board status|migrate` with `0001-baseline`.
2. **Convergence, test-first, one worker task per script or group.**
   - vecs ahead: `wait-checks`, the test harness, changelog.
   - SpaceRocks ahead: `verify.sh`'s generic part (test-merge several PR heads onto their base
     in the orchestrator's review worktree; the recipe becomes the `verify` hook),
     `refresh-checks`, `check-task-ci`, `start-worker`, `claude-worker`, the
     Estimate / Model / Progress handling.
   - Three-way merges: `board.sh`, `watch-prs.sh`, `merge-task.sh` (vecs: track base,
     `--merge-commit`, pack keep, owner button-merge follow-up; SpaceRocks: partial re-run,
     CI-tested-base guard; both: the post-fast-forward install, take the better-tested one), `open-task.sh`, `review.sh`.
   - Port SpaceRocks' vitest cases into the bash harness: Done cap, Markdown check before posts,
     install after a lockfile fast-forward, empty-title board rows, GraphQL brace balance, watcher
     lock.
   - Each project's orchestrator reviews the scripts its side knows.
   - `grade.sh` writes the shared model-log format; `vmethod learnings submit|show|report`.
3. **Docs:** merge vecs `.agents/workflows/*` and SpaceRocks `docs/agents/*` into `docs/`.
4. **Pilot:** vecs adopts `v1.0.0-rc.N`. The rc exits when vecs has run on it:
   - one `open-task` → worker → `review.sh` round → `merge-task` cycle;
   - an owner button merge;
   - a track session (`VMETHOD_TRACK`);
   - a release with `vmethod check` in CI.

   SpaceRocks then adopts, and `v1.0.0` ships.

**After 1.0** (redesigns that must not block adoption): one Status × Assignee × Progress × draft
state-machine table shared by every script; JSON instead of TSV between scripts; one event poller
per account, or webhooks, instead of a GraphQL poller per session.

## Owner decisions (#1)

1. **vmethod is public.**
2. **Workers** are opencode sessions reached through the `OPENCODE_*` environment variables
   loaded into the orchestrator's session (base URL, server username and password). They act on
   GitHub as `alfredjpr79`. Today they share the orchestrator's machine and repo, but scripts
   must reach opencode only through those variables, never by assuming a local host.
3. **Scope of 1.0** is parity + config + sync. The rest comes later, step by step.
4. **Merging:** the orchestrator merges with the owner's approval. The orchestrator may merge
   unimportant PRs on its own review.
