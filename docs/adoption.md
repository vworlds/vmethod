# Adoption checklist

Adopt the pinned package in one reviewed change without copying shared methodology.

## Before you start

### Optional subscription telemetry

The owner may install a reviewed oc-limits plugin on the orchestrator's OpenCode
server. Its `oc-limits/limits` RPC supplies quota telemetry through the existing
`OPENCODE_*` login; vmethod needs no new provider credentials. Verify it with
`vmethod limits` from the orchestrator checkout. Without the plugin (including a
404 or `RpcError`), providers are unknown and normal launches still work.
See [headroom and recovery](gateway.md#subscription-headroom-and-quota-recovery)
for `limits` defaults, provider overrides and fallback behavior. Observe one
`QUOTA` crossing on the next real depletion; do not burn quota to manufacture it.

### Adoption interview: discover first, ask only for gaps

Start with local, non-credential data: `package.json`, the lockfile,
`git remote -v`, `git branch -a` and any existing project configuration or guides.
A blank repository may have none of these; ask for missing choices rather than
inventing an organization, identities or board. Do not overwrite existing files.
Read [security](security.md) and [protocol](protocol.md) before external reads or posts.

Use this interview as the complete question list. Record discovered values and
their source, propose defaults where appropriate, and ask the owner only for
unresolved values or decisions. Never ask for tokens, passwords or private keys.

| Value                                                | Discover without guessing                                                                                                                                              | Ask the owner when unresolved                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package pin and runtime                              | Read the installed package version/engines and the exact devDependency/lockfile. The README install command resolves npm's `next` tag to an exact pin.                 | Is a different release required? Can Node be upgraded if below the package's requirement?                                                           |
| Repository and organization (`repo`, `org`)          | Read `git remote -v` and existing config. A local folder name is not a repository identity.                                                                            | Which GitHub repository/organization should this use, and will you create it if absent?                                                             |
| Owner login, numeric id and account type             | Reuse only owner-approved identity pins. A remote namespace or git author is not proof of ownership.                                                                   | Who is the owner, and what are their verified login, numeric id and account type?                                                                   |
| Orchestrator and worker identities                   | Read owner-approved `people.yaml` and repository bindings, if present. After bootstrap, `vmethod check --online` verifies each checkout's authenticated identity.      | Which separate logins act as orchestrator and worker? Supply verified login/id/type pins, git identities and the orchestrator's repository binding. |
| Board (`board.owner`, `board.number`, `board.repos`) | After minimal config and caller pins exist, use the bootstrap `gh-read` query below to list project URLs/numbers; reuse approved config for shared-board repositories. | Which project URL should be used (or created), and which repositories share it? Is offline/fork mode intentional instead?                           |
| Base and release branches                            | Inspect local/remote branches and existing CI/release docs. Their existence does not select project policy.                                                            | Confirm the integration/default branch and release branch; if absent, may the administrator create them (suggest `dev` and `master`)?               |
| Worker checkout and worktree paths                   | Inspect approved `workerCheckout`/branch settings and registered projects; confirm that the worker path is a separate clone, not the orchestrator checkout.            | Where should the worker clone live (suggest `../<project>-worker`), and where may task worktrees be created?                                        |
| Models (`models.yaml`)                               | Inspect the configured backend's model catalog and any existing registry for real provider/model ids. Template families are examples, not proof of availability.       | Which available models/families may workers use, with which backend, price/tier and owner gates?                                                    |
| State and branch naming                              | Preserve existing `stateName`, markers and `branches` settings. For a new repository propose a unique project state name and template branch patterns.                 | Are those proposed names/paths acceptable, or is there existing state to preserve/import?                                                           |
| Verification, release hooks and changelog            | Read package scripts, CI, local engineering/release guides and existing fragments for `checks`, `postMerge` and `changelog`.                                           | What checks, CI check names, release/install hooks and fragment policy should a blank project use?                                                  |
| Privacy and local routing                            | Read approved privacy policy and project guides; identify the actual agent entry point.                                                                                | Should learnings be public or private, and which local domain/engineering/verification guides should routing link?                                  |
| Host setup and protection                            | Note only whether required tools, settings and launcher exist; do not inspect credential stores or treat settings as proof of effective protection.                    | Confirm the owner handoff below: identity config-directory paths, backend/server setup, permissions, branch/CODEOWNERS policy and central binding.  |

**Bootstrap boundary:** `gh-read` cannot discover the first trusted caller: it
requires valid local config and owner-approved pins. Ask the owner for the initial
verified identities and repository choice first. Do not run `gh`, raw GitHub APIs
or another client to get around that boundary. Once pinned, use only vmethod's
gateway for GitHub discovery; ask the owner when a required read is unavailable.

### One owner-only setup handoff

Give the owner this numbered list once, filled with the interview's agreed values
and outstanding decisions. The owner performs these operations; agents never
create their own authority or edit their permission rules. Pause where a prerequisite
is missing instead of discovering these requirements one command at a time.

1. Create/choose the GitHub repository and separate owner, orchestrator and worker
   identities. Verify their login, numeric id and account type, approve the local
   `people.yaml` pins, permitted system events/application ids and orchestrator
   `repos:` bindings, and authenticate each identity in its
   own `GH_CONFIG_DIR` (owner-run `GH_CONFIG_DIR=<dir> gh auth login`). Do not give
   tokens to the agent; vmethod never reads `GH_TOKEN`.
2. Prepare separate orchestrator and worker clones and register both as OpenChamber
   projects. Install the required Node/runtime and configure the chosen OpenCode
   backend/server and reviewed monitor plugin as described in the checklist below.
3. In **each** checkout, write `.claude/settings.local.json` with that identity's
   `env` block (read by OpenCode and Claude alike): `VMETHOD_ROLE=orchestrator` or
   `worker`, that login's `GH_CONFIG_DIR`, `GIT_SSH_COMMAND`, `GIT_AUTHOR_*` and
   `GIT_COMMITTER_*`, plus the orchestrator's `OPENCODE_*` server settings. Install
   and review the [permission templates](../templates/README.md), including effective
   overrides, ownership of stubs, and the orchestrator's `external_directory` access
   to the worker checkout and OpenCode worktree directory. Restart sessions after writing settings;
   an existing session does not acquire them. `vmethod check` warns
   `the session predates the settings; restart it` when local settings exist but
   its environment lacks `VMETHOD_ROLE`.
4. Have an administrator create the agreed base/release branches and project board
   if absent, grant the identities the needed access, and choose branch protection
   and code-owner review requirements. Approve CODEOWNERS entries for `vmethod.yaml`,
   `people.yaml` and `.claude/`. CODEOWNERS only forces owner review when the branch
   ruleset requires code-owner review; otherwise it merely requests review. Each
   project's owner chooses that policy (vmethod's owner has not required reviews).
5. Ask the vmethod owner to bind the orchestrator's verified identity to this
   consumer repository in vworlds/vmethod's central `people.yaml`. Until then,
   learning submissions and upstream issue creation are refused; a local binding
   cannot grant central authority.

### Bootstrap sequence

Follow these steps in order; even `gh-read` and `board status` require `vmethod.yaml`,
and `gh-read` additionally requires its caller to be pinned in `people.yaml`.

1. Install the exactly pinned package as shown in its README (if not already installed)
   and include the lockfile in the adoption change. Then,
   once per machine, install the package-provided PATH launcher with
   `npm exec --no -- vmethod init --launcher`. The launcher cannot be installed
   before the package is installed. Until then, use `npm exec --no -- vmethod`;
   never use `npx`.
2. Run `vmethod init` to create the absent local configuration.
3. Fill `vmethod.yaml` with the interview's repository values and replace placeholder
   identities in `people.yaml` with the owner-approved pins and the orchestrator's
   `repos: [<owner>/<repo>]` binding. Every verb
   needs valid `vmethod.yaml`; discovery via `gh-read` also authenticates a pinned
   caller.
4. Save this query as `projects.graphql`:

   ```graphql
   query {
     viewer {
       login
     }
     organization(login: "<org>") {
       projectsV2(first: 20) {
         nodes {
           number
           url
         }
       }
     }
   }
   ```

   Run `vmethod gh-read projects.graphql`. Each project's `number` and `url` come
   back; titles are redacted because projects carry no author. Pick the board by
   its URL. Do not run `board status` before the project config and caller pin are
   ready.

5. Complete `vmethod.yaml`, `people.yaml` and `models.yaml`, then run
   `board init` (vmethod 1.0, #325) on an empty project; see
   [board initialization](board.md#migrations-what-adopters-see).
6. Deliver the adoption as one reviewed non-task PR: open it with
   `pr open <branch> <title> <body-file>` and, after approval and green checks,
   merge it with `pr merge <n>` (vmethod 1.0, #326).
7. After that PR merges, run `vmethod board migrate` to migrate past v3. The
   contract guard reads the adopted config and pins from remote branches.

### Watcher delivery

Start the watcher with `background: true` and `monitor: true`, even if the harness
shell tool schema does not list `monitor`; without it, event delivery may wait until
the 30-minute expiry. The opencode-monitor plugin is cached under
`~/.cache/opencode`, so it may look absent from the project. See
[watching](orchestrator-guide.md#watch-without-wasting-budget).

Raise methodology needs with `upstream issue <title> <body-file>` or
`upstream comment <n> <body-file>` (vmethod 1.0, #333), never `gh`. Both require
the central orchestrator binding described above. See
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
- [ ] Confirm the [owner-only setup handoff](#one-owner-only-setup-handoff) is complete.
      Point `workerCheckout` (or `VMETHOD_WORKER_CHECKOUT`) at the separate worker
      clone. Workers never run in the orchestrator's checkout. Check
      `branches.worktreePrefix` (default `"auto-"`), which names task worktrees.
      See [worker worktree configuration](package.md#worker-worktree-configuration).
- [ ] **Ignore `.claude/`** in `.gitignore` (`init` adds it; `check` requires it).
- [ ] Install the [opencode-monitor](https://github.com/rndmcnlly/opencode-monitor)
      plugin on the orchestrator's OpenCode, pinned to a reviewed commit
      (`opencode plugin add github:rndmcnlly/opencode-monitor#<commit>`). It
      delivers `watch` output live; see
      [watching](orchestrator-guide.md#watch-without-wasting-budget).
- [ ] Set `board.repos` to **every** repository sharing the board. Set
      `learningsPrivacy` before any submission. Keep concrete paths, hosts, commands
      and domain rules local. Port behavioral differences into reviewed project hooks.
- [ ] Confirm `people.yaml` matches the approved handoff (the orchestrator role is
      per repository; `vmethod check` errors on an unbound orchestrator or a
      repository no orchestrator binds). Configure real model
      ids, backend kinds and gates in
      `models.yaml`; match board families. `init` converts a root `models.tsv` once,
      preserving the original and gates. Other local registries need explicit relocation.
- [ ] Rename old environment prefixes to `VMETHOD_*`. Use the
      [documented mapping](package.md#environment-mapping); do not assume old names
      remain aliases. Set `board.enabled: false` for intentional offline/fork work.
- [ ] Run `vmethod check` as the orchestrator; it
      reports missing identities and a missing worker checkout. In each checkout,
      `vmethod check --online` reports which login it holds.
- [ ] Migrate in-flight opencode sessions with `worker adopt <pr> <session-id>`,
      (see [worker management](gateway.md#worker-management-orchestrator-only));
      adoption verifies the PR worktree and existing session model, never starts a turn.
- [ ] Route the consumer's agent entry point with the [routing template](../templates/AGENTS.md).
      Link generic rules from the pinned package, local engineering/domain docs
      from the consumer. Keep any alternate agent entry point linked to the same routing.
- [ ] Tell knip about the bin-only dependency: a package script naming the local
      invocation, or `ignoreDependencies`. Do not remove the pin as “unused”.
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
