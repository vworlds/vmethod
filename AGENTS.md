# vmethod: agent guide

vmethod is VWorlds' shared development methodology: process docs, roles, and the tooling that
project orchestrators and worker agents use. Projects (e.g. `vworlds/spacerocks`,
`vworlds/vecs`) mount a pinned vmethod release and keep only their project-specific settings
locally.

> Status: pre-1.0, bootstrapping. The methodology is being gathered in
> [issue #1](https://github.com/vworlds/vmethod/issues/1). This file grows as it is decided.

## Roles

- **Owner:** the human project owner. Final say on accepting methodology changes.
- **Orchestrator:** senior engineer and manager of one repo. Runs the project board, analyses
  issues, plans work, dispatches worker agents, reviews and merges their PRs. This repo's
  orchestrator is **Vimes**.
- **Worker:** an agent that takes one task, delivers one PR, and iterates on review feedback.
  vmethod's workers are opencode sessions reached through the `OPENCODE_*` env vars; they act
  on GitHub as `alfredjpr79`.
- **Merging:** the orchestrator merges with the owner's approval; it may merge unimportant PRs
  (typos, its own bootstrap helpers) on its own review.
- **Collaborator:** anyone else who opens issues or PRs, including other projects'
  orchestrators.

## How vmethod itself changes

1. A consumer (usually another project's orchestrator) opens an issue describing the need.
2. The vmethod orchestrator elaborates it and agrees acceptance with the owner.
3. Accepted changes ship in a tagged release. Consumers bump their pinned version when ready.

Shared learnings (model performance, traps, practices) flow faster: orchestrators submit them as
`learning` PRs, which the vmethod orchestrator merges and distils into `learnings/` without a
release (see `docs/architecture.md`, Shared learnings).

vmethod follows its own methodology (dogfooding): this repo is run with the same process and
tools it ships.

## Branches

- `dev`: default branch. All work merges here.
- `master`: releases only. It moves when a release is cut from `dev`, and release tags live on it.

## Layout

- `docs/architecture.md`: the vmethod design (mounting, config, layout, roadmap).
- `people.tsv`: who the agents may hear from: login, numeric id and role.
- `scripts/bootstrap/`: temporary tools until vmethod 1.0 ships its own. `watch.sh` is the
  orchestrator's event watcher, filtered through `people.tsv`.
