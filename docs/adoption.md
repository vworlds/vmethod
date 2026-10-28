# Adoption checklist

Adopt the pinned package in one reviewed change without copying shared methodology.

## Before you start

### Owner prerequisites

1. Create separate GitHub logins/configuration directories for the owner, orchestrator
   and worker identities as applicable; each identity must use its own `GH_CONFIG_DIR`.
2. Prepare the orchestrator and worker checkouts and register both as OpenChamber
   projects. The worker checkout is a separate clone.
3. In **each** checkout, have the owner write its `.claude/settings.local.json`
   before starting any agent session. It supplies `VMETHOD_ROLE`, `GH_CONFIG_DIR`
   and git identity; a session already running when the file is written does not
   acquire those environment variables. Restart that session. `vmethod check` warns
   `the session predates the settings; restart it` when it sees the local settings
   file but no `VMETHOD_ROLE` in its own environment.
4. Create the base and release branches with an administrator.
5. Ask the vmethod owner to bind the orchestrator's verified identity to this
   consumer repository in vworlds/vmethod's central `people.yaml`. Until then,
   learning submissions and upstream issue creation are refused; a local binding
   cannot grant central authority.

### Bootstrap sequence

Follow these steps in order; even `gh-read` and `board status` require `vmethod.yaml`,
and `gh-read` additionally requires its caller to be pinned in `people.yaml`.

1. Install the exactly pinned package and commit the lockfile (`npm install`). Then,
   once per machine, install the package-provided PATH launcher with
   `npm exec --no -- vmethod init --launcher`. The launcher cannot be installed
   before the package is installed. Until then, use `npm exec --no -- vmethod`;
   never use `npx`.
2. Run `npm exec --no -- vmethod init` to create the absent local configuration.
3. Create a minimal `people.yaml` containing the owner and orchestrator's verified
   identities and the orchestrator's `repos: [<owner>/<repo>]` binding. Every verb
   needs valid `vmethod.yaml`; discovery via `gh-read` also authenticates a pinned
   caller.
4. Discover the board number using `vmethod gh-read` (for example, query the
   organization's projects with the endpoint/GraphQL query documented in
   [Gateway commands](gateway.md#commands)). Do not run `board status` before the
   project config and caller pin are ready.
5. Complete `vmethod.yaml`, `people.yaml` and `models.yaml`, then run
   `vmethod board init` on an empty project. `board init` is the shipped vmethod
   1.0 command from #325; see [board initialization](board.md#migrations-what-adopters-see).
6. Deliver the adoption as one reviewed non-task PR: open it with
   `vmethod pr open <branch> <title> <body-file>` and, after approval and green
   checks, merge it with `vmethod pr merge <n>` (vmethod 1.0, #326).
7. After that PR merges, run `vmethod board migrate` to migrate past v3. The
   contract guard reads the adopted config and pins from remote branches.

### Watcher delivery

Start the watcher with `background: true` and `monitor: true`, even if the harness
shell tool schema does not list `monitor`; without it, event delivery may wait until
the 30-minute expiry. The opencode-monitor plugin is cached under
`~/.cache/opencode`, so it may look absent from the project. See
[watching](orchestrator-guide.md#watch-without-wasting-budget).

Raise methodology needs with `vmethod upstream issue <title> <body-file>` or
`vmethod upstream comment <n> <body-file>`, never `gh` (vmethod 1.0, #333).
Both require the central orchestrator binding described above. See
[upstream needs](gateway.md#upstream-needs).

## Initial adoption

- [ ] Install an **exactly pinned** `@vworlds/vmethod` devDependency and commit the
      lockfile. Use the Node version required by the release. Run `npm ci` in every
      worktree; until the launcher below is installed, invoke through
      `npm exec --no -- vmethod`, never `npx`.
- [ ] Run `init --dry-run`, review, then `init`. It writes absent configuration and
      registered compatibility stubs; it never overwrites existing configuration or
      an unmarked script. Resolve conflicting local scripts explicitly, not by
      deleting them blindly. Current verbs are listed in [Package commands](package.md).
- [ ] **After installing the package, install the PATH launcher on every machine agents run commands on:**
      `npm exec --no -- vmethod init --launcher` writes a marked `vmethod` script to
      `~/.local/bin` by default (pass a different `dir` when needed), mode 755. Keep
      the directory on `PATH`; `vmethod check` reports whether the `vmethod` on PATH
      is this launcher (the report is skipped inside npm scripts, where
      `npm_lifecycle_event` is set). From then on commands are `vmethod <verb>` with no
      `VMETHOD_ROLE`/`VMETHOD_ROOT` prefix. The launcher resolves the checkout the
      commands run in and never executes another checkout's installation; it replaces
      an older launcher and refuses to overwrite any file that does not carry its
      marker.
- [ ] Fill `repo`, `org`, `baseBranch`, `releaseBranch`, `stateName`, `workerCheckout`,
      `branches`, `board`, `checks`, `postMerge` and `changelog` from local settings
      as appropriate. Preserve existing state names and markers so watchers do not
      replay old events. Configuration holds no credentials.
- [ ] **Give workers their own checkout.** Clone the repository a second time, for
      example next to the orchestrator's (`../<project>-worker`), and point
      `workerCheckout` (or `VMETHOD_WORKER_CHECKOUT`) at it. Workers never run in the
      orchestrator's checkout. Register both folders as OpenChamber projects. Check
      `branches.worktreePrefix` (default `"auto-"`), which names task worktrees.
      See [worker worktree configuration](package.md#worker-worktree-configuration).
- [ ] **Ignore `.claude/`** in `.gitignore` (`init` adds it; `check` requires it).
      In each checkout, the owner writes `.claude/settings.local.json` with an `env`
      block for that identity, read by OpenCode and Claude alike. The orchestrator
      checkout sets `VMETHOD_ROLE=orchestrator`, the `GH_CONFIG_DIR` of the
      orchestrator's gh login, `GIT_SSH_COMMAND`, the `GIT_AUTHOR_*` and
      `GIT_COMMITTER_*` identity, and the `OPENCODE_*` server credentials. The
      worker checkout sets `VMETHOD_ROLE=worker`, the `GH_CONFIG_DIR` of the
      worker's gh login, `GIT_SSH_COMMAND` and the worker's git identity. Give the
      orchestrator's OpenCode permissions access to the worker checkout and
      OpenCode's worktree directory (`external_directory`).
- [ ] Install the [opencode-monitor](https://github.com/rndmcnlly/opencode-monitor)
      plugin on the orchestrator's OpenCode, pinned to a reviewed commit
      (`opencode plugin add github:rndmcnlly/opencode-monitor#<commit>`). It
      delivers `watch` output live; see
      [watching](orchestrator-guide.md#watch-without-wasting-budget).
- [ ] Set `board.repos` to **every** repository sharing the board. Set
      `learningsPrivacy` before any submission. Keep concrete paths, hosts, commands
      and domain rules local. Port behavioral differences into reviewed project hooks.
- [ ] Have the owner verify `people.yaml` logins, numeric ids, roles and permitted
      system events, and give each `role: orchestrator` entry `repos:` bindings
      (the role is per repository; `vmethod check` errors on an unbound
      orchestrator or a repository no orchestrator binds). Configure real model
      ids, backend kinds and gates in
      `models.yaml`; match board families. `init` converts a root `models.tsv` once,
      preserving the original and gates. Other local registries need explicit relocation.
- [ ] Rename old environment prefixes to `VMETHOD_*`. Use the
      [documented mapping](package.md#environment-mapping); do not assume old names
      remain aliases. Set `board.enabled: false` for intentional offline/fork work.
- [ ] Ask the vmethod owner to bind the consumer orchestrator's verified login,
      numeric id and type to this repository in vworlds/vmethod's central
      `people.yaml` on `dev`. Your local registry cannot grant upstream access.
      Raise methodology needs with `vmethod upstream issue <title> <body-file>`
      and follow up with `vmethod upstream comment <n> <body-file>`, not raw `gh`.
      See [upstream needs](gateway.md#upstream-needs).
- [ ] Log each identity into its own gh config directory with
      `GH_CONFIG_DIR=<dir> gh auth login`; vmethod never reads `GH_TOKEN`. Identity
      kept only in git config is not used. `vmethod check` as the orchestrator
      reports missing identities and a missing worker checkout. In each checkout,
      `vmethod check --online` reports which login it holds.
- [ ] Migrate in-flight opencode sessions with `worker adopt <pr> <session-id>`,
      or configure `legacyWorkers` relative directory paths and run `worker adopt --from-legacy`
      (see [worker management](gateway.md#worker-management-orchestrator-only)). Review every skipped record;
      adoption verifies the PR worktree and existing session model, never starts a turn.
- [ ] Route the consumer's agent entry point with the [routing template](../templates/AGENTS.md).
      Link generic rules from the pinned package, local engineering/domain docs
      from the consumer. Keep any alternate agent entry point linked to the same routing.
- [ ] Tell knip about the bin-only dependency: a package script naming the local
      invocation, or `ignoreDependencies`. Do not remove the pin as “unused”.
- [ ] Ask the owner to install and review the [permission templates](../templates/README.md)
      for the active backend. Agents do not edit their own permissions. Audit
      effective overrides and ownership of stubs, not only JSON syntax.
- [ ] Add `vmethod.yaml`, `people.yaml` and `.claude/` to the consumer's CODEOWNERS
      with the owner as reviewer. `check` warns about missing entries. CODEOWNERS
      only forces owner review when the branch ruleset requires code-owner review;
      otherwise it requests review. Each project's owner chooses that policy
      (vmethod's owner has not required reviews).
- [ ] Install the release's exact Mermaid peer pin and required diagram-check peer
      dependencies. Run offline `check`; do not mistake skeleton validation for
      online identity, board or Markdown verification.
      During the rc pilot, with owner-approved permission installation deferred,
      use `npm exec --no -- vmethod check --defer-permissions` in CI (CI machines
      have no launcher; the long form still refuses to download). The switch is
      visible in the adoption diff and warns on every run; it only softens absent
      settings, never invalid installed settings or other findings. Remove it at
      1.0 and have the owner install permissions: stable releases reject the switch.
      Any later prerelease also accepts it; it is not limited to the 1.0 pilot.
- [ ] On a fresh empty project, run `board init` to create the baseline fields
      before adding cards; see [board initialization](board.md#migrations-what-adopters-see).
      Review `board status` and `board migrate --dry-run`, then apply `board migrate`
      (vmethod 1.0, #5). Coordinate shared-board consumers and Status automations.
      On a single-repository board, migrations past v3 run **after the adoption PR
      merges**: the contract guard reads `vmethod.yaml` and package pins from remote
      branches, never the local checkout. If it reports not-yet-adopted, merge the
      adoption PR and rerun `board migrate`. Shared boards wait for every consumer.
      Run `check --online` (vmethod 1.0, #5) after migration; do not claim these
      unimplemented verbs ran on the skeleton.
- [ ] Exercise a task/review/merge cycle, owner button-merge follow-up, a track and
      a release with the project's hooks before considering rollout complete.
      Stop old watchers before starting the single reader for retained state.
      For a `button-merge` event, the orchestrator runs `merge-task <n>` explicitly.
      This replaces legacy Bash watchers' automatic follow-up (vecs#358): the same
      end result, with one explicit step. See the [watch guide](orchestrator-guide.md#watch-without-wasting-budget).
- [ ] Migrate old open task-PR bodies to the task-only layout in
      `templates/task-pr.md`: retain the verbatim task specification, approval basis,
      hold banner, machine markers and opening vmethod version; remove execution
      boilerplate. Do this manually where necessary; there is no compatibility
      parser for worker-model body lines.
- [ ] Set the **Model** field on every in-flight PR card before starting, adopting
      or resuming its worker. Body model lines are not a fallback. Fresh contexts
      receive a generated first prompt pointing to the pinned worker guide; live
      sessions keep their context without receiving onboarding again.

- [ ] Deliver the adoption as one reviewed non-task PR: push the adoption branch,
      then run `vmethod pr open <branch> "chore: adopt vmethod" <body-file>`.
      Use `review <n> owner <file>` for the owner handover and `vmethod pr merge <n>`
      after approval and green checks on the exact head/current base. Identity and
      permission changes need the owner's approval even under autopilot. See
      [non-task PR commands](gateway.md#non-task-pr-commands); no direct GitHub CLI
      PR creation or merge is needed.

## Legacy worker transition

Configure only the legacy directories belonging to your project, relative to
`$XDG_STATE_HOME` (default `~/.local/state`), for example:

```yaml
legacyWorkers:
  - vecs-orchestrator/workers
  - vecs-orchestrator/claude-workers
```

SpaceRocks uses `spacerocks-orchestrator/workers` and
`spacerocks-orchestrator/claude-workers`. Do not move or rewrite old files. Paths
must have nonempty alphanumeric-leading segments containing only letters,
digits, dots, underscores and hyphens; absolute paths, `.`/`..` segments and
symlinks escaping the state root are refused. With a track, the existing
`-<track>` suffix applies to the configured directory path.

Run `worker adopt --from-legacy` as the orchestrator and review every result.
Worktree-keyed bash files encode `/` as `_`; the importer takes the PR number
after the last `.worktrees_` and your literal `branches.worktreePrefix`. Bare
`ses_…` records and existing `<pr>.json` records are verified against the open
task PR, existing worktree/branch, session directory and actual opencode model.
Only the session id is taken from the record; file metadata cannot authorize
adoption. The importer never creates missing worktrees or changes legacy files.
If a legacy PR has no opening Estimate snapshot, the importer resolves its linked
issue (including `Agent task for #n` / `Closes #n` legacy headers) and snapshots
that issue's **current** board Estimate. The adoption segment records
`legacy snapshot at adoption` in worker state and the eventual grade; subsequent
issue edits do not change this opening value. An issue without an Estimate is
skipped with `linked issue #n has no Estimate; estimate it, then rerun`.
This exception applies only to `--from-legacy`: normal `worker adopt`, worker
launch and `open-task` retain their opening-snapshot requirements.
Closed/merged PRs, probes, missing worktrees, unknown or mismatched sessions,
invalid records and already-recorded sessions are reported skips.

Headless Claude `key=value` records are **not adoptable**: there is no verified
server session lookup. The importer reports the PR and recorded id but does not
contact opencode, trust the recorded model/directory, or adopt the session. If
the task is still open, explicitly relaunch it with
`worker start <pr> --model <family>` and any required owner approval; Claude
families now run through OpenCode's `claude-code` provider. This starts a new
worker, not a continuation of the legacy Claude process; coordinate stopping that
process before relaunching.

## Every upgrade

- [ ] Review release notes and changelog fragments, changed config/interfaces,
      compatibility and migration prerequisites.
- [ ] Attach `npm diff --diff=@vworlds/vmethod@<old> --diff=@vworlds/vmethod@<new>`
      evidence to the adoption PR. A manifest/lockfile bump alone is not review evidence.
- [ ] Update the exact pin, run `npm ci`, review generated stub changes and owner
      permission changes, and run configured checks against the candidate release.
- [ ] Review pending board migrations and dry run; apply them after upgrading.
      Contract waits for all `board.repos` and open track/pack branches to qualify.
      Never downgrade a board to fit an old checkout.
- [ ] Confirm the upgraded checkout, state compatibility and hooks work, and record
      the rollout outcome. Keep the previous release available for diagnosis without
      mixing its running files with the new install.

restart every orchestrator and worker session, or have it re-read `AGENTS.md`; sessions started before adoption keep the old instructions.
