# Adoption checklist

Adopt the pinned package in one reviewed change without copying shared methodology.

## Initial adoption

- [ ] Install an **exactly pinned** `@vworlds/vmethod` devDependency and commit the
      lockfile. Use the Node version required by the release. Run `npm ci` in every
      worktree; invoke through `npm exec --no -- vmethod`, never `npx`.
- [ ] Run `init --dry-run`, review, then `init`. It writes absent configuration and
      registered compatibility stubs; it never overwrites existing configuration or
      an unmarked script. Resolve conflicting local scripts explicitly, not by
      deleting them blindly. Current verbs are listed in [Package commands](package.md).
- [ ] Fill `repo`, `org`, `baseBranch`, `releaseBranch`, `workerUser`, `stateName`,
      `branches`, `board`, `checks`, `postMerge`, `changelog` and `credentials` from
      local settings as appropriate. Preserve existing state names and markers so
      watchers do not replay old events. Credentials are env names, not values.
- [ ] Check `branches.worktreePrefix` (default `"auto-"`) against your worker
      directory convention. Use `""` for intentional unprefixed directories.
      Existing unprefixed task directories are looked up without renaming them when
      the prefixed path is absent; new worktrees use the configured prefix.
      See [worker worktree configuration](package.md#worker-worktree-configuration).
- [ ] Set `board.repos` to **every** repository sharing the board. Set
      `learningsPrivacy` before any submission. Keep concrete paths, hosts, commands
      and domain rules local. Port behavioral differences into reviewed project hooks.
- [ ] Have the owner verify `people.yaml` logins, numeric ids, roles and permitted
      system events. Configure real model ids, backend kinds and gates in
      `models.yaml`; match board families. `init` converts a root `models.tsv` once,
      preserving the original and gates. Other local registries need explicit relocation.
- [ ] Rename old environment prefixes to `VMETHOD_*`. Use the
      [documented mapping](package.md#environment-mapping); do not assume old names
      remain aliases. Set `board.enabled: false` for intentional offline/fork work.
- [ ] Set the configured GitHub token variables and `GIT_AUTHOR_NAME`,
      `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` in the
      orchestrator wrapper environment. Identity kept only in git config is not
      used. `VMETHOD_ROLE=orchestrator vmethod check` reports missing identities.
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
      use `npm exec --no -- vmethod check --defer-permissions` in CI. The switch is
      visible in the adoption diff and warns on every run; it only softens absent
      settings, never invalid installed settings or other findings. Remove it at
      1.0 and have the owner install permissions: stable releases reject the switch.
      Any later prerelease also accepts it; it is not limited to the 1.0 pilot.
- [ ] Review `board status` and `board migrate --dry-run`, then apply `board migrate`
      (vmethod 1.0, #5). Coordinate shared-board consumers and Status automations.
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
`worker start <pr> --model <claude-family>` using your configured Claude family
and any required owner approval. This starts a new worker, not a continuation
of the legacy Claude process; coordinate stopping that process before relaunching.

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
