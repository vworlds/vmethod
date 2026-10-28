# Package commands

Orchestrators use `vmethod watch [--once]` instead of the removed bootstrap watcher.
See [watching and muting](gateway.md#watching-and-muting) for scoped sessions,
`mute`/`unmute`/`mutes`, durable acknowledgements and optional previews.

Node 24 or newer is required. Pin `@vworlds/vmethod` exactly as a devDependency.
Run `npm ci` in every worktree, then `vmethod <verb>`; install the per-machine PATH launcher with `init --launcher` (below). Before it is installed, `npm exec --no -- vmethod <verb>` still refuses to download; never use a downloading `npx` fallback.

Do not prefix `VMETHOD_ROLE` or `VMETHOD_ROOT` on commands: the checkout's gitignored
`.claude/settings.local.json` sets the role and the other identity variables, and commands
resolve the checkout from `VMETHOD_ROOT` or git discovery. `vmethod check` verifies the environment.

- `version`: published package version, bundled board version and running Node version.
- `config get <dotted.key>`: YAML 1.2 config after validated environment overrides.
- `check [--defer-permissions]`: offline config, people, models, Mermaid pin, permissions and secret checks; also verifies environment overrides (`VMETHOD_ROLE` value, resolvable `VMETHOD_ROOT`) and reports whether the `vmethod` on PATH is this launcher. Exit 0 means no blocking findings, 1 findings, 2 missing dependency (takes precedence). No GitHub identity resolution is attempted offline; numeric ids must already be owner-approved. The switch is accepted only on a prerelease, including dev builds and later prereleases: absent `.claude/settings.json` prints `WARN permissions deferred (prerelease <version>): .claude/settings.json not installed` on every run instead of failing. Installed settings and all other findings are still validated. Stable versions reject the switch with exit 1. CODEOWNERS gaps for `vmethod.yaml`, `people.yaml` and `.claude/` warn without failing; the first existing `.github/CODEOWNERS`, root `CODEOWNERS` or `docs/CODEOWNERS` is used, with last matching entries taking precedence. See [adoption](adoption.md) for the owner-approved pilot path and review policy.
- `init [--dry-run]`: write absent config files and registered compatibility stubs. Only stubs with an exact `# vmethod stub` line can be updated. Config files are never overwritten. Stubs use `VMETHOD_ROOT` first, then git repository discovery; set `VMETHOD_ROOT` for copied build contexts without `.git`. Permission installation remains the owner's responsibility: copy `templates/claude-settings.json` to `.claude/settings.json`.
- `init --launcher [dir]`: write the per-machine `vmethod` launcher to `dir` (default `~/.local/bin`), mode 755 and marked `# vmethod launcher`. It resolves the checkout exactly like the stubs, then runs that checkout's own install (`node_modules/.bin/vmethod` in a consumer; vmethod's own checkout, named `@vworlds/vmethod` in its `package.json`, runs `node <checkout>/dist/vmethod.mjs`). It refuses to overwrite a file that does not carry the marker and replaces an older launcher. `vmethod check` reports whether the `vmethod` on PATH is this launcher.
- `learnings submit|show|report|annotate|aggregate|merge`: authorized add-only fork submissions, latest advice/evidence with offline fallback, exact model-log reports, orchestrator-only cited thread annotation/advice generation, and the central-only orchestrator merge of an authorized learning submission. See [shared learnings](learnings.md) for arguments, privacy and central/pending deduplication.
- `upstream issue <title> <body-file>` and `upstream comment <n> <body-file>`: centrally bound consumer orchestrators raise methodology needs and follow-ups on vworlds/vmethod. See [upstream needs](gateway.md#upstream-needs).

Every verb except `version` and `init --launcher` resolves the project root once per run exactly as the stubs and the launcher do: `VMETHOD_ROOT` first, then `git rev-parse --show-toplevel` from the current directory. The cwd is never assumed to be the root, so commands work from any subdirectory of a checkout. `init --launcher` can also run outside a repository when invoked through an installed bin.

Template identities and model ids are examples, not real credentials or an authoritative allowlist.
`pr open` and `pr merge` manage orchestrator-authored non-task changes; see
[non-task PR commands](gateway.md#non-task-pr-commands). `check` skips its PATH
launcher report when `npm_lifecycle_event` is set because npm scripts intentionally
resolve the package bin first.

Configure real values before adoption. Mermaid is optional at install time but `check` requires exactly 12.1.0. Diagram validation also uses the installed jsdom peer (24 or newer).
The permission template denies raw `git push` and allows the `push` compatibility stub and local CLI. See [worker commands](gateway.md#worker-commands) for the six worker verbs, their arguments and branch policy.
See [CI and integration commands](gateway.md#ci-and-integration-commands) for
`wait-checks`, `verify`, `refresh-checks`, `check-task-ci` and the project verify hook.
See [gateway commands](gateway.md#commands) for orchestrator-only `issue create`,
`issue close`, `issue block`/`issue unblock`, `issue parent`/`issue unparent`
epic relations (also `issue create --parent`), `board add` board-follow-up repair
and `board set` housekeeping
(including validated Progress and `--clear` for Progress/Estimate, and
`board set <ref> Assignees owner|orchestrator|--clear` journaled management-turn
repairs),
tracked owner questions with `ask <issue> <file>`, the central-only
`learnings merge <pr>` learning-submission merge,
`release next` publish dispatch and release evidence,
[task flow](gateway.md#task-flow-commands) for structured full/partial deliveries
and `link-task <pr> [--complete|--unlink]` Development-link backfill and plan changes.
See [conflict resolution](gateway.md#conflict-resolution) for `resolve-conflicts <pr>`,
automatic watcher dispatch, cheap-model turns and `conflicts.escalatePaths`.

## Worker worktree configuration

Workers run in their own clone of the repository, the **worker checkout**, never in
the orchestrator's. `src/gateway/worker-path.ts` is the one place it is read:

| Key                       | Default              | Meaning                                                                                                           |
| ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `workerCheckout`          | (required)           | The worker checkout, relative to the orchestrator's checkout or absolute. `VMETHOD_WORKER_CHECKOUT` overrides it. |
| `branches.worktreePrefix` | `"auto-"`            | Task worktree name prefix; set `""` for unprefixed names. Path separators are refused.                            |
| `branches.worktreeRoot`   | `.worktrees`         | Parent of the orchestrator's own worktrees, such as `orchestrator-review`.                                        |
| `branches.mainCheckout`   | Gateway project root | Base directory for a relative `worktreeRoot`.                                                                     |

`worker start` creates each task worktree through OpenCode's worktree API from the
worker checkout, named `<worktreePrefix><branch>`, in OpenCode's own worktree
directory. Worker records keep the directory OpenCode returned; status, watching
and cleanup find a task's tree among the worker checkout's registered worktrees by
branch, never by deriving a path.

The worker checkout's gitignored `.claude/settings.local.json` sets the worker
identity for every session in it: `VMETHOD_ROLE=worker`, the worker's
`GH_CONFIG_DIR`, `GIT_SSH_COMMAND` and `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. The
orchestrator's checkout has its own, with `VMETHOD_ROLE=orchestrator` and the
`OPENCODE_*` credentials vmethod uses to launch workers.

## Environment mapping

`board.number` maps to `VMETHOD_BOARD_NUMBER`, `baseBranch` to `VMETHOD_BASE_BRANCH`, etc.
Strings remain strings; integer, boolean and array overrides are parsed as YAML 1.2 then validated.
Only `VMETHOD_*` variables are read. `VECS_*`, `SPACEROCKS_*` and bare `BASE` are ignored without warnings.
Consumers rename their project-prefixed variables on adoption.

Supported `VMETHOD_` switches:

| Suffix | Config key    | Meaning                                       |
| ------ | ------------- | --------------------------------------------- |
| BOARD  | board.enabled | `off` disables board steps, `on` enables them |
| TRACK  | track         | Track name                                    |
| BASE   | baseBranch    | Active base branch                            |

Board-writing verbs honour `board.enabled: false`.
`VMETHOD_OWNER` and `VMETHOD_BOARD_PROJECT` are ignored. Owner authority comes only from numeric ids and roles in `people.yaml`, never from environment variables. Select the board with `VMETHOD_BOARD_OWNER` (the org) and `VMETHOD_BOARD_NUMBER` (the number), not an owner login or project node id.

`models.tsv` conversion accepts a plain or `#`-commented tab-separated header with `family`, `provider/id` (or `model`), `kind` and `gate`. TSV gate `-` becomes YAML `none`; `none` and `owner` are preserved. Required YAML `tier` is copied when present, otherwise derived as `expensive` for owner-gated rows and `standard` for other rows. `kind: opencode` requires `provider/id`; `kind: claude` requires a bare model id. Other comment lines are ignored. It validates before writing, preserves the TSV, and never converts again once `models.yaml` exists. Existing YAML files must explicitly add `tier: expensive|standard|cheap`; `vmethod check` rejects missing tiers.

## Development and releases

Run format:check, lint, typecheck, test, build, smoke and knip. Tests and smoke create consumer projects under `os.tmpdir()`, outside the repo, so they cannot inherit its dependencies or config. They run offline and have explicit timeouts. Real Mermaid Markdown checks cover jsdom majors 24 and 27; the packed-tarball consumer installs jsdom 24 with peer validation enabled. Run `npm ci` first to populate npm's cache for the offline smoke install. Only Node is on PATH during CLI smoke checks.

CI also runs `vmethod check --defer-permissions` against this repo's config, using the same explicit prerelease deferral as consumers, without filtering output or special-casing exit codes. It skips cleanly if `vmethod.yaml` is absent. Stable releases require removing the switch and owner-installed permissions.

Every PR adds `changes/unreleased/<number>.md` with `kind: breaking`, `feature` or `fix`, a blank line and a description. The next release PR collects previously released fragments into `CHANGELOG.md` and removes them from `unreleased`.

The repository version stays `0.0.0-dev`. Publishing reads npm's latest stable version and only fragments added since its `vX.Y.Z` tag: breaking → major, feature → minor, otherwise patch. Before the first tag, all fragments are considered; no new fragments means "nothing to release". A master push publishes to latest; manual dispatch **on dev only** publishes the next `X.Y.Z-rc.N` to next. Both use npm OIDC trusted publishing with provenance, then tag the source commit. There is no bump commit, npm token or tag overwrite. The owner must configure the npm trusted publisher for this repository and `publish.yml` first. Source maps embed the editable schema and baseline sources; tests verify they match byte-for-byte.

Read each version's GitHub release page or the identical `RELEASE-NOTES.md` in the installed package for offline notes. Notes include fragments added since the previous reachable release tag (including RC tags), grouped Breaking / Features / Fixes and linked to their PRs; the first release includes all fragments. RC pages are marked as pre-releases. This notes window is separate from the stable-based version calculation above.

If release creation fails after npm publication, rerun the workflow **at the same source commit**. Publishing matches npm's recorded `gitHead` to reuse the published version, skips build, npm publication and explicit tagging, and creates only the missing GitHub release (or does nothing if it already exists). GitHub can create a missing tag at that commit if the earlier tag push failed. Registry and release lookup failures stop visibly rather than assuming absence. The publish job uses `contents: write` and its Actions token for GitHub release creation; npm still uses OIDC, not that token.
