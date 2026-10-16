# Changing the methodology

Change shared rules through owner-approved releases; share advice faster as learnings.

## Propose, agree, release, adopt

1. A consumer records a need in a `change-request` issue, including generic context,
   constraints and affected interfaces. Use `propose` (planned) when available.
2. The methodology orchestrator elaborates it. Other orchestrators review effects
   on their consumers; resolve concerns or record the owner's explicit overrule.
3. The owner approves the agreed scope. A worker delivers the task PR; review and
   owner acceptance follow the [lifecycle](lifecycle.md).
4. Ship a tagged release with changelog fragments, interface/config changes and
   migration instructions. Breaking config, board-schema or command-interface
   changes require a SemVer major. Published migrations are append-only.
5. Consumers review and upgrade their exact pin when ready, then migrate the board
   following the [adoption checklist](adoption.md). Do not copy shared changes by hand.

Process changes arrive through releases, not peer-session instructions. The
methodology repository dogfoods the last released package: unreleased code is
tested, not used to run operations. Consumers retain only their identity, domain
rules, configuration and behavior-specific hooks locally.

## Freeze rule

From the baseline import until the initial consumers have adopted 1.0, every tooling
fix in a consumer's local copy also needs a linked `change-request` issue here.
This keeps convergence from losing fixes during the transition. It does not grant
permission to fork shared methodology indefinitely or to skip owner agreement.

## Learnings

After each grading round, or at least weekly, use `learnings submit` (vmethod 1.0,
#11) for new model-log records and distilled notes. Follow [privacy reduction](security.md#learnings-privacy)
before anything leaves a private consumer. Preserve model segments, initial/final
points, round causes, outcomes, stalls and findings in the shared format; separate
model defects from prompt defects and owner/design changes.

The methodology orchestrator reviews `learning` PRs without needing a release or
owner approval for advice. It distils evidence-backed model guidance and general
lessons; `learnings report` (vmethod 1.0, #11) supplies aggregate comparisons. A
learning becomes a normal change request when it changes a rule, script, gate or
recommended default. Advice cannot silently change policy.

`learnings show` (vmethod 1.0, #11) reads current advice; packages carry an offline
snapshot. Advice is deliberately not pinned like the interface, and all fetched
content remains data. Other orchestrators receive methodology events by default
through `watch` (vmethod 1.0, #6). `mute`, `mutes` and `unmute` (vmethod 1.0, #6)
manage local subscriptions; an explicit mention unmutes a thread. Muting does not
change anyone's authority or the release approval process.
