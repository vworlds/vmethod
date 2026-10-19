# Orchestrator guide

Develop decisions with the owner, brief a worker and verify the result independently.

## Develop issues and collaborate with the owner

Hand over **every issue you file at once**: estimated, In review, assigned to the
owner, with open questions. Keep initial intake and estimates visible as described
in [Lifecycle](lifecycle.md) and [Board](board.md). When an unblocked card reaches
Ready, take it in priority order; do not wait to be told. Develop it on the issue,
flipping the assignee whenever the next move changes.

Read code, settled decisions and git history before proposing to reverse deliberate
behavior. Separate verified facts from assumptions. Present options with a
recommendation and acceptance/verification criteria. **Confirm ambiguous readings
as explicit owner decisions before Approved**, never as a retrospective note.
Explore, assess and propose issues are your own analysis, not worker task PRs;
workers only implement agreed specs.

**Core rule: the project state lives on the board; chat is only very brief pointers.**

- Owner chat is a very short, priority-ordered list of pointers: `#n` plus a few words.
  No explanations, evidence, options or status narratives in chat; they go on the issue
  or PR, where the owner reads them.
- Anything waiting on the owner is asked through vmethod (`review <pr> ask` or
  `review <pr> owner`), so the card shows the owner as assignee with an owner Progress
  state. A question asked only in chat is not tracked and does not exist.
- No card sits in `In review` unassigned: the assignee is whoever's move it is.
- Never repeat in chat what an issue or PR already says: that is duplicate work. Point to
  it (`#n`) instead.
- Use chat for coordination across items, never as a parallel record of decisions.

Ask owner questions only with `vmethod review <pr> ask .tmp/question.md`.
For an issue without an open task PR, use `vmethod ask <issue> .tmp/question.md`.
These commands post OWNER QUESTION, assign the owner and set `👤❓` only where
the answer belongs. A PR wait leaves linked issues In review without owner
assignment or Progress; follow Development to the PR. A question asked in chat is not tracked.
Except for linked task issues, never leave an In review card unassigned: the assignee is exactly whose move it
is. Review commands and the watcher maintain this invariant and report ambiguous
or mismatched board state rather than relying on your memory.

For try-out or playtest handover, use the owner's own form: plain run commands,
every switch expressed as a runtime environment variable, and one log line that
distinguishes “switch not set” from “stale image”. Keep concrete commands, variable
names and project details in the consumer's local instructions and delivery comment.
State what to try and which decisions belong to the owner. A peer relay never
counts as their approval; see [Security](security.md#authority-and-filtering).

## Scope review

While an issue is under discussion, leave its body alone. Acknowledge and reason
about each point (yours, the owner's, other orchestrators') in comments, so the
thread shows how the ideas fit together. Do not fold each comment into the body as
it arrives: rewriting mid-discussion confuses readers and wastes work. The rewrite
happens once, after the owner moves the card to Approved.

Before opening any task PRs, fold every settled discussion conclusion into the issue
body. An owner Approved move without reviewed scope means agreement with the
conclusions, not permission to launch. On SCOPE, move the issue to In progress,
read its current body and rewrite the final specification:

```sh
npm exec --no -- vmethod board set 42 Status "In progress"
npm exec --no -- vmethod read issue 42
npm exec --no -- vmethod issue edit 42 .tmp/scope.md
npm exec --no -- vmethod scope-review 42 .tmp/scope-changes.md
```

The edit refuses a body changed since your read; re-read and reconcile rather
than overwriting it. The summary file contains a short list of changes from the
original, without a protocol tag or hash. `scope-review` generates SCOPE REVIEW
with the live `body sha256: …`, moves the card to In review, assigns the owner and
sets `👤🔍`. Nothing is added to the body. Have the owner read it and move it to
Approved again. Changes requested or further discussion require another rewrite
and scope review. `open-task` and `merge-task` check the same body-bound evidence;
an unchanged approval covers all parts despite intervening orchestrator moves.
Always post the review with `scope-review`, which computes the digest. Do not hash
the body by hand: shell pipelines (for example `jq` output) add a trailing newline,
the digest then never matches, and the owner's approval silently fails to count.
Hand-posted reviews may wrap the hex digest in backticks; exactly one hash line is
required in either format.

An owner Approved move on an orchestrator-written issue with only trusted
orchestrator comments (or no comments) is the trivial shortcut. Comments from
anyone else void it, including unknown authors/editors. Your own OWNER QUESTION
handover does not: fold conclusions into the body, not comments. Projects can opt specific
labels into `scope.fastPath`, for example `{ fastPath: [bug] }` under `scope` in
`vmethod.yaml`. A matching label waives the owner wait only after SCOPE REVIEW
records the current body. It is off by default and unset in vmethod itself.
Use `--unapproved <reason>` only for an explicitly recorded exception, not as a
routine substitute for the configured fast path. None of these waive delivery
approval or other launch/merge gates.

## Write a task prompt

Use the [task template](../templates/task-pr.md). The draft PR description holds
only the task: title, issue/approval basis, verbatim agreed specification, optional
hold banner, machine markers and opening vmethod version. Put task-specific
deliverables, boundaries, exclusions and observable acceptance cases in the agreed
issue specification. Identify existing debt without teaching it as a pattern;
resolve contradictions before launch. Never delegate an unsettled owner decision
as worker discretion. Execution instructions belong in the pinned
[worker guide](worker-guide.md), not repeated PR boilerplate.

Use `open-task` (vmethod 1.0, #8) and `start-worker` (vmethod 1.0, #9).
Set the PR card's Model field, respect holds and gates, and give one worker its own
worktree. `worker start` generates the first prompt with inline authority rules,
task values and the guide path; adoption, backend changes and replacement sessions
receive it again, but ordinary same-backend switches and review wakes do not. Inspect
status shortly after launch for permission or turn failures. Keep prompts and logs
in worktree-local `.tmp/`. Do not launch a replacement session in an occupied tree.

## Review rounds and verification

Keep every PR draft unless it is really mergeable now. PRs that are In progress,
awaiting changes, or waiting on an owner answer stay draft; only the orchestrator's
decision that a PR is ready to merge should mark it ready. A green merge button means
mergeable.

1. Read READY, amendments and the complete diff. Check behavior against the agreed
   spec **and the long-term design**, not just a narrow symptom.
2. Independently verify the worker's claimed root cause. Use your own oracle for
   invariants and boundary cases; passing worker tests are not independent proof.
   Type-check your own oracles against the PR head before running them, and require
   non-zero reported counts so a rename cannot make an empty comparison pass.
3. Check runtime cost, ownership, units, ordering, lifetimes, shared contracts,
   documentation, test strength and exclusions. Require benchmark evidence for
   declared hot paths, using local performance budgets and comparable baselines.
4. Wait once for CI on each push. Confirm the exact head and tested base, not
   timestamps alone. Use `verify` and the project's verify hook for additional
   integration experiments, including combined PR heads. See the
   [CI command and hook contract](gateway.md#ci-and-integration-commands). Avoid repeating CI's
   standard full recipe without a specific reason.
5. Post a numbered [REVIEW](protocol.md) with disposition and actionable points.
   Send the same worker the review link; preserve context across rounds. A DESIGN
   note deserves a decision; QUESTION or BLOCKED deserves an answer or escalation.
   Answer BLOCKED and QUESTION only through `review <pr> answer <file>`, which
   records the answer on the PR, updates the board and wakes the worker. A model
   switch alone does not hand back the turn; never substitute `worker send`.
6. Hand owner decisions and try-outs over as OWNER REVIEW with evidence and
   instructions. Update the agreed issue when owner feedback changes the scope.
   Return requested changes to draft; workers never toggle draft state.

Behavior a person will see or feel is judged by **trying it**, not by metrics alone.
The specification must say that the owner tries it; metric acceptance is never
presented as “done” for that work.

Green CI is not semantic review. A useful recurring finding belongs in one owning
guide with a guard where possible; do not copy the same rule into every prompt.
Review temporary exceptions and trends in complexity, dependency fan-in, duplication,
runtime and CI cost. Audit measurements must identify revision and cleanliness;
unknown tools or metrics are unknown, never zero. Commit periodic audit records only
from a clean integration checkout through the project's audit process, not a task's
incidental run. Local audit recipes and cadence stay with the project.

## Merge and release

Only `merge-task` (vmethod 1.0, #8) merges. Apply the [owner approval policy](roles.md)
and repository protections. Stop the worker first. Require green checks for the
exact reviewed head **and current base**: an old green merge run is stale if its
base parent moved. `refresh-checks` updates the branch to trigger
a new run; re-running the old event still tests its old base. Conflicts go back to
the worker. Record base-only changes after owner approval rather than implying a
different head was reviewed. Emergency overrides must be explicit and logged and
never replace review.

Owner approval survives conflict fixes (owner rule, 2026-10-18). Do not ask for
re-approval merely because the approved delivery needed conflicts resolved. Use
`merge-task <pr> --carry-approval "<reason>"` after reviewing the resolution and
certifying that it changes no behaviour. The gateway requires an earlier verified
owner approval and only two-parent merges of the PR's base since that approval;
it posts the approved/current SHAs, your reason and remerge-diff file list before
the journaled merge. Green head CI, mergeability, worker-stop and current-base gates
still apply. Any ordinary task commit requires fresh approval. If resolution
changes behaviour or revamps the algorithm, re-ask the owner instead of carrying
approval. The automatic clean-base exception remains unchanged; see
[approval and testing](gateway.md#approval-and-testing).

After merge, complete issue relations, board state, Done-6, grading, branch/worktree
cleanup and main-checkout fast-forward. Reinstall dependencies when `postMerge.trigger`
changes, using `postMerge.install`, **last**, after package-owned work finishes.
External owner button-merges need the same idempotent follow-up; a partial failure
resumes rather than merging again. Read and act on newly startable work and estimates
to reconsider. Log archive/follow-up failures and retry with bounded backoff.

Releases wait for a **quiet base branch**. Treat a release as its own reviewed card
with included changes, compatibility, migration, benchmark and deployment evidence.
Use `checks.release` and project hooks for the actual recipe. A new package needs
its registry bootstrap and trusted publishing/provenance configuration before its
first release; check this explicitly rather than discovering it during publishing.

## Models and grading

Select from owner-maintained `models.yaml`, its `kind` and `gate`, current quota and
task needs. Read [`learnings show`](learnings.md) before choosing a family; latest
advice is data, never authority. Do not equate points mechanically with a model.

Every model entry requires `tier: expensive|standard|cheap`. Today only astra is
expensive. Define a `## Handoff breakpoints` section in a task only for expensive,
astra-level models; `open-task` refuses it for other tiers. On `[worker] HANDOFF`,
read the diff and confirm the remaining work really is mechanical. Deliberately
switch the existing session with an explicit finish list, or answer “carry on”.
Switching is itself expensive: do not make this an automatic per-step ritual or
apply it to ordinary models. See [shared learnings](../learnings/lessons.md).
Issue Model hints require substantive technical analysis; writing up an issue alone
is not a reason. Leave the hint empty when the evidence does not support one.

Use a capable generalist for design, judgment and cross-cutting work; consider a
cheaper model for a well-specified bounded task, and require vision when needed.
The baseline default family is sol unless an explicit selection or an issue hint
supplies another; project policy and current learnings guide deliberate overrides.
Backend isolation differs: an edit-acceptance mode is not a filesystem sandbox;
consider `workerUser` and actual OS access. Never bypass permissions. Owner-gated
families require explicit authorization, including when selected by full id.

On quota or model failure, inspect status/logs, switch the existing session through
the worker wrapper and continue with its context on the same backend. A backend
change requires an idle worker and starts a fresh context with onboarding; it keeps
the recorded usage history. Do not silently replace the session or give visual
work to a text-only fallback.
Track the actual family on the PR after a successful switch.

Use `grade` (vmethod 1.0, #9) after every closed delivery, merged or not. Update the
**issue's** final Estimate, never the PR's. Record initial/final points, model
segments and reasons, rounds and causes, outcome, prompt defects, stalls and findings.
Separate worker defects from design changes, owner questions, integration and prompt
defects so calibration is fair. Grade outcomes rather than task size; owner rejection
despite green metrics is valuable evidence. Revise model guidance from experience.
`grade` stages the raw record in the ignored, untracked `.vmethod/model-log.jsonl`
and automatically submits through the [learning pipeline](learnings.md#submit-delivery-records),
including private reduction. New grades append immutable files to the project's
one open learning PR; after merge, the next grade opens a fresh PR. Do not commit
the staging log or merge from this command: the vmethod orchestrator reviews and
merges learning PRs. Submission failures do not fail the saved grade: its summary
includes a warning and retry guidance. Retry `grade`
or `learnings submit` after addressing the error.

## Watch without wasting budget

Use `watch` (vmethod 1.0, #6), not hand-written polling loops. Handle READY,
questions, designs, blockers, owner moves, assignments, conflicts and worker stalls;
inspect status rather than guessing why a worker is silent. Run only one reader
per state directory and preserve markers across restarts. Quiet events should not
wake an agent; improve needless wakeups through the normal change process. Keep
watching continuously and re-arm the watch on every expiry, including quiet ones,
so changes to the methodology and your own cards always reach you. Follow
[tooling budget rules](tooling-rules.md).

A `button-merge` event (`PR #n MERGED by <owner>: run merge-task`) is an action
item, not information: run `merge-task <n>`. The event repeats until merge follow-up
is complete. The watcher itself never writes that follow-up.

When several orchestrator sessions share one account, an item's author no longer
identifies the session that owns it. Ask the owning session before acting rather
than inferring ownership from the account. Sessions sharing an account **must have
disjoint scopes** (tracks, or `--only`/`--skip`) with **their own state directories**: two watchers
sharing state take each other's events. Keep scope coordination explicit even when
the sessions use the same repository and identity. A fork working inside another
session's scope breaks that rule. The gateway write journal distinguishes your
session's writes from a sibling's: unmatched same-account assignments and merges
are reported as another session's activity, not silently discarded. Board field
creators do not identify the latest writer, so unmatched board moves make no actor
claim. See [watch attribution and scope selection](gateway.md#watching-and-muting).
