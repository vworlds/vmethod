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

Owner chat is a short, priority-ordered list of pointers: `#n` plus a few words.
Put reasoning, alternatives, evidence and single-item status on the issue or PR.
Use chat for coordination across items, not a parallel record of decisions.

For try-out or playtest handover, use the owner's own form: plain run commands,
every switch expressed as a runtime environment variable, and one log line that
distinguishes “switch not set” from “stale image”. Keep concrete commands, variable
names and project details in the consumer's local instructions and delivery comment.
State what to try and which decisions belong to the owner. A peer relay never
counts as their approval; see [Security](security.md#authority-and-filtering).

## Write a task prompt

Use the [task template](../templates/task-pr.md). The draft PR description must
stand alone: context, agreed specification, current base, already-on-branch work,
reusable helpers, exact deliverables, applicable local rules/guards, exclusions,
observable acceptance cases, verification and required evidence. Identify existing
debt without teaching it as a pattern. Check names, units, lifecycle and boundaries
against the guides the prompt asks the worker to follow; resolve contradictions
before launch. Never delegate an unsettled owner decision as worker discretion.

Use `open-task` (vmethod 1.0, #8) and `start-worker` (vmethod 1.0, #9).
Record the model in the prompt and board, respect holds and gates, and give one
worker its own worktree. Inspect
status shortly after launch for permission or turn failures. Keep prompts and logs
in worktree-local `.tmp/`. Do not launch a replacement session in an occupied tree.

## Review rounds and verification

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
the worker wrapper and continue with its context. Respect backend-switch limits;
do not silently replace the session or give visual work to a text-only fallback.
Track the actual family on the PR after a successful switch.

Use `grade` (vmethod 1.0, #9) after every closed delivery, merged or not. Update the
**issue's** final Estimate, never the PR's. Record initial/final points, model
segments and reasons, rounds and causes, outcome, prompt defects, stalls and findings.
Separate worker defects from design changes, owner questions, integration and prompt
defects so calibration is fair. Grade outcomes rather than task size; owner rejection
despite green metrics is valuable evidence. Revise model guidance from experience.
Submit reduced private learnings using the [change process](change-process.md).

## Watch without wasting budget

Use `watch` (vmethod 1.0, #6), not hand-written polling loops. Handle READY,
questions, designs, blockers, owner moves, assignments, conflicts and worker stalls;
inspect status rather than guessing why a worker is silent. Run only one reader
per state directory and preserve markers across restarts. Quiet events should not
wake an agent; improve needless wakeups through the normal change process. Keep
watching continuously and re-arm the watch on every expiry, including quiet ones,
so changes to the methodology and your own cards always reach you. Follow
[tooling budget rules](tooling-rules.md).

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
