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
- [ ] Route the consumer's agent entry point with the [routing template](../templates/AGENTS.md).
      Link generic rules from the pinned package, local engineering/domain docs
      from the consumer. Keep any alternate agent entry point linked to the same routing.
- [ ] Tell knip about the bin-only dependency: a package script naming the local
      invocation, or `ignoreDependencies`. Do not remove the pin as “unused”.
- [ ] Ask the owner to install and review the [permission templates](../templates/README.md)
      for the active backend. Agents do not edit their own permissions. Audit
      effective overrides and ownership of stubs, not only JSON syntax.
- [ ] Install the release's exact Mermaid peer pin and required diagram-check peer
      dependencies. Run offline `check`; do not mistake skeleton validation for
      online identity, board or Markdown verification.
- [ ] Review `board status` and `board migrate --dry-run`, then apply `board migrate`
      (vmethod 1.0, #1). Coordinate shared-board consumers and Status automations.
      Run `check --online` (vmethod 1.0, #1) after migration; do not claim these
      unimplemented verbs ran on the skeleton.
- [ ] Exercise a task/review/merge cycle, owner button-merge follow-up, a track and
      a release with the project's hooks before considering rollout complete.
      Stop old watchers before starting the single reader for retained state.

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
