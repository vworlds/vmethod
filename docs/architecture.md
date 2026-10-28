# vmethod architecture

Status: **agreed design**, a living document. Changes go through PRs; owner decisions are listed
under [Owner decisions](#owner-decisions-1).

## Goals

- One home for the VWorlds development methodology: roles, lifecycle, board, comment protocol,
  worker and orchestrator guides, and the tooling that runs them.
- Consumer projects (first `vworlds/vecs` and `vworlds/spacerocks`) pin a release and keep only
  project-specific settings locally. Nothing is copied by hand, so nothing drifts.
- vmethod runs on vmethod (dogfooding).

## Distribution: an npm package

vmethod is published as **`@vworlds/vmethod`**, a public npm package, and each consumer adds it as
an exactly pinned devDependency (`"@vworlds/vmethod": "1.2.0"`). Both current consumers are Node
≥ 24 projects with npm workspaces, so the package uses the tooling they already run every day.

- **Built from TypeScript** into one **readable, unminified** ESM bundle with sourcemaps, plus the
  source. Orchestrators and workers debug these tools, so readability matters more than size.
- **Zero runtime dependencies.** The few libraries needed (e.g. `yaml`) are bundled into the build,
  so nothing transitive enters the consumer's tree. The Markdown/Mermaid check needs `mermaid` and
  `jsdom`, which both consumers already have as devDependencies. They are optional
  `peerDependencies`, loaded on demand, and their absence is a clear "dependency missing" exit (2).
- **Commands through `bin`:** `vmethod <verb>`, e.g. `watch`, `board migrate`, `open-task`,
  `read pr`, `post`, `learnings submit`.
  - **Never `npx vmethod`.** With `node_modules` missing (a fresh worktree, a failed `npm ci`),
    `npx` silently downloads the *latest* package from the registry, unpinned. That is exactly
    the hole the pin closes.
  - Docs say `vmethod <verb>`: the PATH launcher written by `init --launcher` resolves
    the checkout the same way and runs that checkout's own install — `node_modules/.bin/vmethod`
    in a consumer, `node <checkout>/dist/vmethod.mjs` in vmethod's own checkout (its
    `package.json` names `@vworlds/vmethod`). Until a machine has installed it, guides still
    teach `npm exec --no -- vmethod <verb>`, which refuses to download.
  - `vmethod init` writes thin stubs (`scripts/agent/<x>.sh`, each marked `# vmethod stub`) that
    `exec "$(git rev-parse --show-toplevel)/node_modules/.bin/vmethod" <verb> "$@"`, and fail
    with "run npm ci" if it is absent. The paths in existing prompts, docs and habits keep
    working.
  - `init` never overwrites a file without the marker. Renamed verbs keep a one-release alias.
- **The package replaces itself during a merge.** `merge-task` fast-forwards the main checkout
  and runs `npm ci`, which rewrites `node_modules/@vworlds/vmethod` while `merge-task` runs from
  it. The hazard is **version mixing**: a later step of the same run (a lazily imported chunk, a
  second process spawned from the package) loading the *new* version in the middle of an
  old-version run. So:
  - the TS build is a single bundle without code splitting, so there is no dynamic `import()` of
    chunks, and no verb spawns another copy of the CLI from `node_modules`;
  - `merge-task` reinstalls dependencies as its **last** step, after archiving and board updates;
  - a test replaces the package between two steps and checks that every later step ran from the
    version the run started with.
- **`mermaid` is pinned to GitHub's renderer version exactly.** The release declares that version,
  and `vmethod check` fails if the installed peer differs. A peer range would let consumers
  drift, and the check is only useful if it parses as GitHub does.
- **State and caches live per OS user**, under `$XDG_STATE_HOME` / `$XDG_CACHE_HOME`, never
  inside `node_modules`. Workers and the orchestrator each run vmethod from the `node_modules` of
  their own checkout: workers in worktrees of the **worker checkout**, a separate clone named by
  `workerCheckout`, never the orchestrator's checkout.
- **Docs, board migrations and templates ship in the package.** A consumer's `AGENTS.md` routes to
  `node_modules/@vworlds/vmethod/docs/…`; `vmethod docs <topic>` prints them. The human-readable
  copy is the vmethod repo at the pinned tag.
- **Worktrees:** every worktree runs `npm ci` before using `vmethod`. `worker start` does it for
  each task worktree before the worker's session exists.

**What npm gives us for free** (it replaces the vendored-copy design of earlier drafts):

| Need | How |
|---|---|
| Pin a version | exact version in `package.json`; integrity hash in the lockfile |
| Detect tampering or drift | `npm ci` refuses code that doesn't match the lockfile's `integrity` |
| Tie a release to its source | **npm provenance**: each version is attested to the vmethod commit and workflow that built it (`npm audit signatures`) |
| Immutable releases | npm versions can't be overwritten |
| Release candidates | `1.0.0-rc.N` on the `next` dist-tag; betas on a branch dist-tag, as vecs does |
| Keep consumer checks off vmethod | `node_modules` is already ignored by prettier, eslint, knip, jscpd, `tsc` |
| A script changed under itself mid-run | Node loads modules at start, and consumers already run `npm ci` after a fast-forward that changes the lockfile |

**Reviewing an upgrade.** An adoption PR only bumps `package.json` and the lockfile, so the
adoption checklist adds the evidence:
- the release notes (from changelog fragments);
- `npm diff --diff=@vworlds/vmethod@<old> --diff=@vworlds/vmethod@<new>`, linked in the PR;
- `vmethod board status`, showing the pending board migrations.

**Non-Node consumers** (vworlds has had C++ and Lua repos) can run `npx @vworlds/vmethod@<version>`
with a minimal tooling-only `package.json`. That is out of scope for 1.0.

**Dogfooding.** The vmethod repo runs its own operations on the **last released** version, pinned as
a devDependency, like a compiler bootstrapping itself: unreleased code is tested, not used to run
the project. A release is adopted by vmethod exactly as by any consumer.

## Parameterisation

### `vmethod.yaml` (per project)

YAML at the repo root, validated against a JSON Schema shipped in the package (`vmethod check`).
The parser follows YAML 1.2, so `no` stays a string and `1.10` stays `1.10`. `VMETHOD_*` environment
variables override any key (e.g. `VMETHOD_TRACK`, `VMETHOD_BASE`, `VMETHOD_BOARD=off`). There are
no project prefixes: every orchestrator runs with a private environment, and consumers rename
`VECS_*` / `SPACEROCKS_*` variables on adoption (owner decision, #14).

| Group | Keys (indicative) |
|---|---|
| Identity | `repo`, `org`, `baseBranch`, `releaseBranch`, `workerCheckout` (the workers' own clone) |
| Board | `board.owner`, `board.number`, `board.repos` (all repos on the board; more than one = shared). The shape comes from the package's board migrations |
| Branches | task-branch pattern, worktree root, main checkout path, pack and track prefixes |
| Checks | verify steps, release pre-check steps, docs Markdown glob, CI check names |
| Post-merge | dependency install command and its trigger file (e.g. `npm ci` / `package-lock.json`) |
| Changelog | fragment directory (e.g. `architecture/unreleased/`), tag vocabulary |
| State | `stateName`: watcher state directory name (vecs: `vecs`, SpaceRocks: `spacerocks`), so existing `once` / `graded` / `merged` markers and the lock survive adoption without replaying old events. The merged watcher reads both projects' marker names (vecs `graded-<n>`, SpaceRocks `grade-<n>`) |
| Credentials | none: each checkout's gitignored `.claude/settings.local.json` sets `GH_CONFIG_DIR` (the identity's gh login), git author and SSH command; `credentials.sshKey` optionally names an SSH key variable |
| Learnings | `learningsPrivacy`: `public` or `private`; `learningsTimeoutSeconds` generation wait (default 900) |

`models.yaml` stays a project file (today's `models.tsv`): provider/id, kind and `gate` (e.g.
owner-gated models need `--owner-approved`, enforced by `open-task` and `start-worker`). Its family
names must come from the board's Model options.

### Board schema and migrations

The board's shape is part of the methodology: Status options, fields (Estimate as a number of
points, Model options, Progress text), the Progress emoji table, and the "Done keeps the last 6"
policy. Boards change the way databases do, through **versioned migrations**. Nothing is
destroyed and rebuilt.

`vmethod.yaml` names the board (`board.owner`, `board.number`) and lists `board.repos`, every repo
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

A board with no block is version 0 (unmanaged). `min_compatible` is the lowest `boardVersion`
whose scripts still work on this board. Expand migrations leave it alone; a contract migration
raises it.

**Scripts on a board that is ahead of them.** Every script reads the block once per run, from
the same poll it already makes.
- If the package's `boardVersion` < version` but `≥ min_compatible` (the board was only expanded), the script
  keeps working and prints one `BOARD AHEAD: upgrade @vworlds/vmethod` notice per run.
- If the package's `boardVersion` < min_compatible` (a contract it doesn't know about), it refuses every board
  write with `BOARD INCOMPATIBLE: upgrade @vworlds/vmethod to ≥ <version>`. Reads still work.

**Migrations ship with vmethod** as an ordered, append-only list: `board/migrations/0001-baseline.json`,
`0002-…`. Each one holds:
- `up`: a list of operations, e.g. `add_field`, `add_option`, `rename_option` (moves cards),
  `set_option_meta`, `add_progress_alias`, `rewrite_progress`, `remove_option`, `remove_field`;
- `expect`: the board shape after it;
- for a destructive step, `requires`: the minimum vmethod version every `board.repos` repo must
  have adopted.

A published migration is never edited; a fix is a new migration. Each vmethod release declares
the board version it needs (`boardVersion` in its `package.json`). `board/schema` is the shape after
the latest migration, generated from the migrations and used by the scripts.

**`vmethod board migrate`**, run after every upgrade of `@vworlds/vmethod` (the adoption checklist
says so, and `vmethod check --online` fails until it has run):

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
the board's version is below the release's `boardVersion`.

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
  have identical tables today. Owner states and assignment appear only where the
  action belongs: on the task PR, not its linked issues. Linked issues stay In review
  without an owner mirror; standalone issue questions still use 👤❓.
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
  `board.repos` repo's pinned `@vworlds/vmethod` version from the lockfile on that repo's configured base branch, and checks
  that open track and pack branches have upgraded too. Until all of them qualify, it stops cleanly
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

Where behaviour differs, not just data, a generic command calls an optional project hook, an
executable at `scripts/vmethod-hooks/<name>` (any language). Examples: the verify recipe
(SpaceRocks' `Dockerfile.verify` stages), release and beta publishing (vecs' npm flow,
`published-packages.txt`), post-merge. Purely project tools (`drift-report.sh`, `update-vecs`)
stay project scripts.

## vmethod repository layout and toolchain

```text
src/cli/            the `vmethod` command and its verbs
src/gateway/        the only code that talks to GitHub and opencode (fetch), with the people filter
src/board/          board client, migrations runner, lock
src/...             watch, tasks, review, merge, learnings, config
board/migrations/   ordered board migrations (0001-baseline.yaml, …)
docs/               the methodology
templates/          AGENTS.md routing template, vmethod.yaml / people.yaml / models.yaml examples,
                    task-PR prompt, permission settings for Claude Code and opencode
test/               vitest suites, fakes, fixtures (a fixture consumer repo)
testing/            exported test kit (`@vworlds/vmethod/testing`) for consumers' hooks
```

**The toolchain is the consumers' own**, so any orchestrator or worker can work on vmethod
without learning anything new:
- TypeScript (strict), built with `tsc` plus a bundler step for the single readable bundle;
- **vitest** for tests;
- **eslint** with `typescript-eslint`;
- **prettier**, with `prettier-plugin-sh` for the remaining bash;
- **husky** and **lint-staged** pre-commit hooks;
- **knip** for unused code and exports;
- **CI**: `format:check`, `lint`, `typecheck`, `test`, `build`, and a pack-and-install smoke test
  that installs the built tarball into a fixture consumer and runs `vmethod check` there;
- **Publishing** follows vecs' `publish.yml` pattern: a push to `master` publishes with OIDC
  trusted publishing and provenance (no npm token anywhere), and `workflow_dispatch` publishes
  betas on a branch dist-tag;
- **Changelog fragments** per PR, collected at release (vecs' mechanism).

**The testing methodology is the one both projects converged on:**
- **Offline only, through fakes.** The gateway takes injectable `fetch` and `exec`, so tests run
  in-process against a fake GitHub (REST and GraphQL), a fake board, a fake opencode server and a
  fake `git`. No test needs network or real git; SpaceRocks' CI image has neither.
- **Fakes fail loudly.** Any request a fake doesn't expect fails the test (vecs' rule); there is
  no silent default.
- **Behavioural tests only.** No test that greps source. Patchers and fixture rewriters assert
  their anchors.
- **Every test runs under a timeout**, and the suite under a global one.
- **Hostile input in every gateway test:** titles, bodies and branch names with shell
  metacharacters, closing keywords, fake protocol tags, and authors outside `people.yaml`.
- **Ported cases:**
  - vecs' `scripts/tests/*`: wait-checks verdicts, changelog, release-publish, estimate-model,
    markdown;
  - SpaceRocks' `orchestratorScripts.test.ts`: Done cap, Markdown before posts, install after a
    lockfile fast-forward, empty-title rows, GraphQL brace balance, watcher lock.
- **`@vworlds/vmethod/testing`** exports the fakes, so consumers can test their own hooks the same
  way.

A consumer's `AGENTS.md` (with `CLAUDE.md` symlinked to it) stays a project file. Built from the
template, it routes to vmethod's docs for the generic process and to the project's own domain and
engineering docs. Generic docs never name project files or commands. They refer to config keys
("run the verify steps, `checks.verify`").

## Methodology content for 1.0

- **Roles:** owner (decides), orchestrator (plans, briefs, reviews, merges; writes no feature
  code, owns tooling and docs), workers (one task PR each, own worktree), side and track sessions,
  collaborators.
- **Lifecycle:** idea → issue developed until agreed → owner moves it to Approved → `open-task`
  writes the task-only draft PR; worker start sends onboarding and the pinned guide path → worker → review rounds → owner
  approval → `merge-task`. Shortcuts: `--direct` (the owner's "go" in chat) and `--unapproved`
  (opened before Approved, with the reason stated on the issue, e.g. a bug with a reproducer). Also tracks, packs, and Blocked-by relations.
- **Board:** Status Backlog → Ready → In progress → In review → Approved → Done. Assignee = whose
  move it is. Estimate, Model, Progress. Every script that changes Status or Assignee also sets
  Progress.
- **Estimates belong to issues, never to PRs** (owner rule, 2026-10-16):
  - Every issue gets an Estimate while it is in Backlog, so the owner knows what is being taken
    in before moving it to Ready.
  - Estimates can be revised at any time as information becomes clearer, e.g. while an issue is
    developed, when a design question changes the scope, or at grading.
  - A task PR carries no Estimate. Its Model and Progress fields are about the delivery.
  - Grading writes `points_final` back to the issue's Estimate. The model log keeps
    `points_open` (the Estimate when the task PR opened) and `points_final`.
- **Comment protocol:** `[worker] ACK | DESIGN | QUESTION | BLOCKED | READY FOR REVIEW (round n)`;
  `[orchestrator] REVIEW round n | OWNER REVIEW | ANSWER | AMENDMENT | GO | APPROVED`
  (`OWNER REVIEW`: handed to the owner, saying what to playtest and which decisions are theirs). The first line is the key.
  Replies carry an `in reply to <comment-url>` line. Workers obey only their prompt and
  `[orchestrator]` comments. Posts made by vmethod carry no footer (owner decision 8).
  After READY, QUESTION, BLOCKED or DESIGN, workers end their turn. Reviews, answers
  and hold releases wake them with fixed PR-reading notifications; busy sessions
  queue those notifications until an idle worker-status poll (see [gateway](gateway.md)).
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
  - Every remaining bash entry point is wrapped as `main "$@"; exit`, so a fast-forward can't
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

Each project stages its raw log at `.vmethod/model-log.jsonl`, ignored and untracked.
`grade` appends after every closed delivery (merged or not), then runs the same
[submission pipeline](learnings.md#submit-delivery-records) as `learnings submit`.
Reviewed durable records live in vmethod's per-submission project files, batched into
one open learning PR per project. Only the vmethod orchestrator merges it; the next
grade after a merge starts a fresh PR without duplicating shared records.
One record per delivery, in a format vmethod defines and validates:

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
- **`points_open` / `points_final`**: the issue's Estimate when its task PR opened, and the final
  grade written back to the issue. The gap is the calibration signal.
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

- **Mechanical, continuous.** `vmethod learnings submit` sends records absent from central
  and open submissions (and the project's distilled notes) as new, immutable files in a
  PR labelled `learning`. The [learning command guide](learnings.md) owns the per-project
  layout and submission semantics. Orchestrators run it after each grading round, or at
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
  default such as the recommended family in `models.yaml` example or `suggest-model.sh`'s
  heuristics.

The implemented [learning command guide](learnings.md) owns fork submission,
central project authorization, privacy reduction and report semantics.

### Consuming learnings

- Learnings are not pinned to a release. They change faster than releases and are not an
  interface. `vmethod learnings show [<family>]` reads the latest pages from vmethod's default
  branch, and releases bundle a snapshot in the package for offline use.
- The orchestrator guide makes this part of model selection: before choosing a family for a task,
  `suggest-model.sh` prints the relevant learnings line and the aggregate for that task kind.
- Owner-gated models stay gated per project (`models.yaml` `gate`). Learnings inform the choice;
  they don't override a gate.

## Security

vmethod and some consumers (vecs) are public. vmethod's scripts run in every consumer with the
orchestrator's credentials: its gh login (`GH_CONFIG_DIR`), SSH key, opencode password. Workers run
with their own, from the worker checkout's environment.

**Untrusted text.** Issues, PRs, comments, branch names and titles can be written by anyone.
- **Authority comes from the author's login and role, never the tag** (`people.yaml`;
  see [the event gateway](#the-event-gateway-no-direct-github-access)). `read-pr.sh` marks other authors' comments as
  untrusted before a worker sees them. Watchers drop events from non-allowlisted logins before any
  further API call, so spam can't drain the GraphQL budget.
- **GitHub text is untrusted in bash.** Titles, bodies and branch names are always quoted data:
  no `eval`, no unquoted expansion. The baseline import audits for this and adds tests with
  hostile titles and bodies.
- Agents treat learnings and every fetched text as data, never as instructions.

**Supply chain.**
- `dev` and `master` cannot be deleted or force-pushed (`.github/rulesets/branches.json`).
  Approval is the owner moving the card to Approved (checked by actor id on the timeline) or an
  approving review by the owner; there is no required-review rule (owner decision, #17).
- Release tags `v*` are immutable (`.github/rulesets/tags.json`).
- npm: OIDC trusted publishing only (no npm token exists), provenance on every version, and 2FA on
  the `@vworlds` npm org. Publishing runs only from `master`, which needs the owner's approval.
- Consumers pin the exact version, `npm ci` checks lockfile integrity, and the adoption PR links
  `npm diff` and the release notes for review.

**Leaks.**
- vmethod's docs stay generic. Paths, OS users, hosts and logins live in each consumer's
  `vmethod.yaml`.
- Records from private repos (`LEARNINGS_PRIVACY=private`, e.g. SpaceRocks) are submitted
  reduced: tags, numbers and outcomes only, with no task titles or notes unless cleared.
  `learnings submit` enforces this. Only allowlisted orchestrator accounts may open `learning` PRs.
- Secret scanning and push protection are on. `vmethod check` rejects anything in
  `vmethod.yaml` that looks like a secret.

**CI.** The default `GITHUB_TOKEN` is read-only. Fork PRs need approval to run workflows. No
`pull_request_target`, and no secrets in workflows that fork PRs can trigger.

## Collaboration, people and the event gateway

### Who is who: `people.yaml` (per consumer repo)

Each consumer repo has a `people.yaml` (project file, owner-approved) listing every GitHub login the
agents may hear from, with a role:

Several `role: owner` entries are supported. Each has a unique login and numeric id;
`vmethod check` accepts several owners but refuses duplicate logins or ids. All
pinned owners have approval authority. Owner turns assign only one person, using
the most recent owner interaction on the issue or PR, or the first owner in file
order when none exists; see the [board assignment rule](board.md#status-and-assignee).

```text
# login               role          note
jpeletier           owner         decides
spacerocks79        orchestrator  SpaceRocks orchestrator
VecsMaster          orchestrator  vecs orchestrator
vimescmd            orchestrator  vmethod orchestrator
alfredjpr79         worker        workers (opencode sessions)
github-actions[bot] system        CI and release automation
```

- Roles (owner-approved in #2):
  - `owner`: approves;
  - `orchestrator`: peer input. The role is per repository: the entry's `repos` binding
    (used for learning submissions, #186) also lists the repositories where the account is
    the orchestrator; for every other repository's gating it counts like `collaborator`:
    it can ask, but never approves or moves another project's cards to Approved;
  - `worker`: its comments drive READY / QUESTION handling;
  - `collaborator`: proposes and comments;
  - `system`: automation such as `github-actions[bot]`. The gateway passes only structured facts
    from it (check conclusions, SHAs, tags). Its free text is never delivered as instructions,
    because any workflow can relay attacker text under that name.

  Checks and CI runs are not comments and are never filtered.
- **The agent always knows who it is talking to.** Every event or text the toolset hands an agent
  is labelled `from <login> (<role>)`. Authority follows the role, never a tag or claim in the
  text: only an `owner` approves; a `collaborator` proposes, reviews and objects.
- `people.yaml` also stores each login's numeric GitHub id. `vmethod check` resolves the ids and
  pins them, and refuses on a mismatch, because a renamed login can be re-registered by someone
  else. Changes to the file go through the owner (CODEOWNERS).
- **Filter fields:**
  - `author.databaseId` and `__typename` (User or Bot) are matched against `people.yaml`;
  - `editor` / `lastEditedAt`: a comment last edited by someone other than its author counts as
    the editor's;
  - `authorAssociation` is a secondary check only;
  - the repo's owner must equal `ORG`;
  - check runs are matched by `app.id` (e.g. GitHub Actions = 15368), never by check name. Anyone
    can create a check called `e2e`;
  - never the body (a protocol tag only classifies a comment after its author passed the id
    check), the display name, or git commit author and committer metadata, which are free text.
- `system` entries in `people.yaml` list the event kinds they may produce (for
  `github-actions[bot]`: check runs, statuses and workflow-run conclusions). Their comments are
  dropped, or at most shown as quoted untrusted text.
- **Approval comes only from an `owner` id:**
  - an APPROVED review on the current head authored by that id (which the rulesets require for
    merging anyway); or
  - a move to Approved whose project-timeline event (`ProjectV2ItemStatusChangedEvent`) has that
    id as `actor`.

  A card's current Status alone is never approval: anyone with project write access can set it.

### The event gateway: no direct GitHub access

Agents never call `gh`, `curl api.github.com` or any GitHub API directly. Raw access bypasses the
people filter and exposes the agent to prompt injection. Every read and write goes through
vmethod's wrappers, which call GitHub internally:

- **Enforced, not just documented.** The hard stop is a permission rule: Claude Code
  `.claude/settings.json` denies `Bash(gh *)`, `npx`, `curl`/`wget` to GitHub, and `git push` outside
  `push.sh`, and allows the `vmethod` stubs, `npm exec --no -- vmethod` and the `vmethod` PATH
  launcher. opencode gets the equivalent config. `templates/` ships both.
  **The owner installs them; agents never edit their own permissions.** `vmethod check` verifies
  that they are in place.
- **Inbound filter.** Before anything reaches the agent:
  - comments, reviews, issues and PRs whose author is not in `people.yaml` are **dropped
    silently** for the agent;
  - mentions of an orchestrator in a repo outside the organisation (`ORG`, e.g. `vworlds`) are
    dropped;
  - what passes is labelled with the author's login and role;
  - bot-authored PRs and comments (e.g. Dependabot) are dropped like any non-listed author, so
    nobody waits on them. CI results arrive as check runs, not comments, and are not filtered.
- **Outbound.** Posts go through the existing posting scripts: Markdown check, no footer, no closing
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
    closing-keyword guard; no footer);
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

### The gateway as a server (future MCP server)

The owner's direction (#4): **the gateway will become an MCP server that alone holds the
credentials**, so that an agent cannot work around it, because it has nothing to work around
with. 1.0 keeps everything in one process, but the code is split along that seam now, so that
moving the server out of process later changes the transport, not the logic:

- **Server and client.** `src/gateway/` exposes a typed set of operations (read, post, board,
  push, worker control, events). Verbs are clients that call these operations through a
  `Transport` interface. 1.0 ships the in-process transport. The future MCP transport exposes the
  same operations as MCP tools, and the CLI stays for humans and compatibility.
- **Credentials live only on the server side.** The GitHub token, the git push credentials and
  the opencode password are read by the server, never by verbs, and never passed back to a
  client. Once the server runs as its own process (and OS user), an agent's shell holds no
  credentials at all.
- **Events are produced by the server.** `vmethod watch` is "the server produces events, the
  client prints them". The event loop, its state and the people filter run in the server; a
  client reads events through a blocking `next_events` operation (later an MCP tool or
  notifications).
- **Push is a server operation:** `push(worktree, branch)` pushes a given local ref. The server
  enforces the branch policy (never `baseBranch` or `releaseBranch`; a worker only its own task
  branch). The `push` verb keeps this ref-based interface.
- **Task flow is server-side too:** the four task-flow verbs call named gateway
  operations; approval proofs, worker-status checks, CI, board updates and durable
  merge follow-up never rely on client-supplied permission booleans. See
  [task-flow commands](gateway.md#task-flow-commands).
- **Scoped identities per role.** The server authenticates each client session (orchestrator,
  worker, track or side session) and scopes what it may do. A worker may read, post on its own
  task PR, and push its own branch. Only an orchestrator session may review, move cards or merge,
  and merging also requires owner approval. "Who is who" is then enforced by credentials, not
  only by labels.
- **Until the server is separate,** the permission rules (deny `gh`, `curl`, `npx`, raw
  `git push`) are what keep agents on the gateway.

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
   review on the PR). It ships in a release, and consumers adopt it with an `npm install` upgrade and
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
  5. Consumers upgrade the pinned `@vworlds/vmethod` version when they choose, then run
     `vmethod board migrate`.
- **Freeze rule (until both projects have adopted 1.0).** From the day the baseline import lands,
  every tooling fix made in a consumer's local copy also gets a `change-request` issue in vmethod,
  linked from that PR. Convergence picks it up.

## Road to 1.0 (parity first, straight to TypeScript)

The owner decided (#7) to port the existing bash tooling **straight to TypeScript**, with no bash
stage inside the package. The bash scripts in vecs and SpaceRocks are the behavioural reference:
same inputs, outputs, exit codes and messages wherever workers, prompts or the owner depend on
them. Their test suites are ported as vitest cases.

1. **Package skeleton** (#3, done): toolchain, CI, publishing, config and schemas,
   `vmethod check|init|version`.
2. **Gateway** (#4): GitHub and opencode access, the people filter, and the `read`, `post` and
   `gh-read` verbs.
3. **Board** (#5): board client, field lock, migrations, `0001-baseline`.
4. **Ports, test-first, one worker task per group,** taking the side named as ahead for each:
   - worker verbs (#7): `start-task`, `read-pr`, `pr-comment`, `push`,
     `check-markdown`;
   - `vmethod watch` and `mute` (#6): three-way from both `watch-prs.sh`;
   - task flow (#8): `open-task`, `review`, `merge-task`, `release-hold`. vecs: track base,
     `--merge-commit`, pack keep, owner button-merge follow-up. SpaceRocks: partial re-run,
     CI-tested-base guard. Both: post-fast-forward install, as the last step;
   - worker management (#9): `worker`, `claude-worker`, `start-worker`, `suggest-model`, `grade`;
   - CI and verify (#10): vecs' `wait-checks`; SpaceRocks' `verify` generic part (test-merge
     several PR heads onto their base; the recipe becomes the `verify` hook), `refresh-checks`,
     `check-task-ci`;
   - learnings (#11): `learnings submit|show|report`, with `grade` writing the shared model log.

   Each project's orchestrator reviews the verbs its side knows.
5. **Docs** (#12): merge vecs `.agents/workflows/*` and SpaceRocks `docs/agents/*` into `docs/`.
6. **Pilot** (#13): vecs adopts `1.0.0-rc.N` in **one PR**:
   - add the devDependency;
   - replace `scripts/{agent,orchestrator}` with stubs;
   - move its config to `vmethod.yaml`, `people.yaml` and `models.yaml` (`vmethod init` converts
     `models.tsv` once; `gate` semantics are unchanged);
   - tell knip about the `bin`-only dependency (a `package.json` script that names it, or
     `ignoreDependencies`). This is in the adoption checklist.

   Its current tooling keeps working until that PR merges. The rc exits when vecs has run on it:
   - one `open-task` → worker → `review` round → `merge-task` cycle;
   - an owner button merge;
   - a track session (`VMETHOD_TRACK`);
   - a release with `vmethod check` in CI.

   SpaceRocks then adopts, and `1.0.0` ships.

**After 1.0:**
- one Status × Assignee × Progress × draft state-machine table;
- one event poller per account, or webhooks, instead of one per session.

## Owner decisions (#1)

1. **vmethod is public.**
2. **Workers** are opencode sessions reached through the `OPENCODE_*` environment variables
   loaded into the orchestrator's session (base URL, server username and password); Claude
   models run through OpenCode too. They act on GitHub as `alfredjpr79`. They share the
   orchestrator's machine but never its checkout: each runs in a worktree of the worker
   checkout, whose environment carries the worker identity. Scripts reach opencode only through
   those variables, never by assuming a local host.
3. **Scope of 1.0** is parity + config + distribution. The rest comes later, step by step.
4. **Merging:** the orchestrator merges with the owner's approval. The orchestrator may merge
   unimportant PRs on its own review.
5. **Roles:** `owner`, `orchestrator`, `worker`, `collaborator` and `system` (#2).
6. **Distribution:** an npm package written in TypeScript, using the consumers' existing tooling
   and testing methodology (#2).
7. **No bash stage:** the existing tooling is ported straight to TypeScript (#7).
8. **No footer** on posts made by vmethod (#4).
9. **Estimates belong to issues**, set in Backlog and revisable; never on PRs (#15).
10. **`watch.preview` defaults to off**: wake lines carry metadata only; a project may opt in (chat, 2026-10-17).
11. **`.claude/settings.json` is installed in vmethod after 1.0 adoption** by vecs and SpaceRocks;
    direct `gh` stays available until then as an escape hatch for vmethod bugs (#13).
12. **vmethod 1.0.0 is the first stable interface** (decided by approving the release-prep PR): its fragment is `kind: breaking`
    so the first rc is `1.0.0-rc.1` rather than `0.1.0-rc.1` (#13).
