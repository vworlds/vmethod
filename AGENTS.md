# vmethod: agent guide

vmethod is VWorlds' shared development methodology: process docs, roles, and the tooling that
project orchestrators and worker agents use. Projects (e.g. `vworlds/spacerocks`,
`vworlds/vecs`) add a pinned `@vworlds/vmethod` npm devDependency and keep only their project-specific settings
locally.

> Status: 1.0 release candidates on npm `next` (latest `1.0.0-rc.11`), consumed by vecs,
> SpaceRocks and Alfie-Labs/NNext. The current architecture reference lives in `docs/architecture.md`.

## Roles

- **Owner:** the human project owner. Final say on accepting methodology changes.
- **Orchestrator:** senior engineer and manager of one repo. Runs the project board, analyses
  issues, plans work, dispatches worker agents, reviews and merges their PRs. This repo's
  orchestrator is **Vimes**.
- **Worker:** an agent that takes one task, delivers one PR, and iterates on review feedback.
  vmethod's workers are opencode sessions reached through the `OPENCODE_*` env vars, running in
  worktrees of their own checkout (`workerCheckout`, `~/src/vmethod-worker`); they act on GitHub
  as `alfredjpr79`. This checkout is the orchestrator's only.
- **Merging:** the orchestrator merges with the owner's approval; it may merge unimportant PRs
  (typos, its own bootstrap helpers) on its own review.
- **Collaborator:** anyone else who opens issues or PRs, including other projects'
  orchestrators.

## Core rule: state lives on the board

The project state lives on the board (cards, assignees, Progress) and in issue and PR
threads. Chat with the owner is only very brief `#n` pointers, and never repeats what an
issue or PR already says. Anything that waits on the
owner is asked through vmethod so the card shows it is the owner's move. See
`docs/orchestrator-guide.md`.

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

- `docs/architecture.md`: the current architecture reference (concepts, invariants, distribution, config and toolchain).
- `docs/`: the methodology guides (roles, lifecycle, protocol, gateway, board, learnings).
- `vmethod.yaml`, `people.yaml`, `models.yaml`: this repo's own configuration (dogfooding).
  `people.yaml` lists who the agents may hear from (login, numeric id, role); vmethod's copy is
  also the central registry of orchestrator-to-project bindings for learning submissions.
- `src/`: the `vmethod` CLI and its gateway, the only code that touches GitHub or credentials.
- `learnings/`: shared model logs and lessons, updated through `learning` PRs.
- `templates/`: files consumers copy, including the owner-installed `.claude/settings.json`.
