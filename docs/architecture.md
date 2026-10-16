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
| `vmethod check --online` | Also fails if the live board lags the pinned `board/schema` version. Opt-in. |
| `vmethod board check <project>` | Diffs a live GitHub Project against a board schema: missing or extra fields, option names, order, colours and descriptions. Read-only; exit 1 on drift. |
| `vmethod board apply <project>` | Brings a board to the schema: creates missing fields, sets Status and Model options in schema order, links the repo. Idempotent, prints each change, `--dry-run` first. Additive by default; `--prune` removes, after the shared-board safety check (see below). |

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

### Board schema and board updates

The board's shape is part of the methodology: Status options, fields (Estimate as a number of
points, Model options, Progress text), the Progress emoji table and the "Done keeps the last 6"
policy. vmethod ships it as **`board/schema`**, versioned with each release. The tooling reads it
too: the Progress parser, Model names in `models.tsv`, Status transitions.

`vmethod.conf` names the board (`BOARD_OWNER`, `BOARD_NUMBER`). It also lists `BOARD_REPOS`,
every repo whose cards live on it: just this repo for a dedicated board (vmethod: project 5), or
several for a **shared board** (vecs and SpaceRocks: project 4).

**Updating a board is a step of adopting every release.** After `vmethod sync <tag>`, the
orchestrator runs:

1. `vmethod board check`: shows the diff between the live board and the new schema.
2. `vmethod board apply`: applies it. The adoption checklist and `sync`'s closing message both
   say so, and `vmethod check --online` fails while the board lags its pinned schema.

`apply` records the schema version it applied in the board's README (a
`vmethod-board-schema: vX.Y.Z` line) and refuses to downgrade.

**Shared boards are the special case.** The projects on one board can be pinned to different
vmethod versions, and every one of them must keep working. Therefore:

- **`apply` is additive by default.** It adds fields and options, and updates descriptions and
  colours. It never renames or removes. A board shaped for vX therefore still works for every
  project on an older version with the same major board schema.
- **Renames and removals** are breaking board changes (a major `board/schema` version) and need
  `apply --prune`. Before pruning on a shared board, `apply` reads each `BOARD_REPOS` repo's
  `.vmethod/VERSION` on its base branch through the API. It refuses unless every repo is already
  on a version whose schema no longer needs the old field or option. In practice, the last
  project to adopt runs the prune.
- **Who runs `apply` on a shared board:** whichever orchestrator adopts the release first runs
  the additive part, and the last to adopt runs the prune. `apply` is idempotent, so running it
  twice is harmless.
- **Cross-repo scope rule.** On a shared board, every script acts only on cards from its own
  `REPO_SLUG`: Done capping, archiving, `GRADE`, `NEXT` / `LAUNCH`, and Progress writes. This is
  one generic rule with tests, not a per-copy hard-code.

On a dedicated board none of this coordination applies: `apply --prune` right after `sync` is
safe.

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
board/schema                        board shape, versioned with the release
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
  - Temp files go under the worktree's `.tmp/`.
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
- **Model log:** one shared format for model selection and grading (PR, family, points, rounds,
  findings).
- **Verification kit slot:** a documented place for project verification patterns (oracles,
  headless-browser checks, quiet-host benchmarks).

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
   `main "$@"; exit`. Add `vmethod.conf`, the schemas, `sync`, `check` and `board check|apply`.
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
