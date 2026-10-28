# Orchestrator guide

Develop decisions with the owner, brief a worker and verify the result independently.

Run commands as `vmethod <verb>` with the PATH launcher (`init --launcher` writes it;
see [adoption](adoption.md)), and do not prefix `VMETHOD_ROLE` or `VMETHOD_ROOT`:
your checkout's `.claude/settings.local.json` sets the role and the other identity
variables, and commands resolve the checkout from `VMETHOD_ROOT` or git discovery.
`vmethod check` verifies the environment.

You may work with several owners listed in `people.yaml`. `ask`, `review … owner|ask`
and `scope-review` assign one owner using the [board assignment rule](board.md#status-and-assignee):
the owner who last interacted with that issue or PR, otherwise the first-listed owner.
Any pinned owner may supply approval evidence, `APPROVE MODEL`, an autopilot label
grant, an agreed quotation or a button-merge; it need not be the assigned owner.
Login, numeric id and account type must still match the registry.

## Autopilot

An owner-applied `autopilot` label delegates the task's ordinary owner decisions to
you until Done. Never add it yourself: only the pinned owner's label event grants
authority. The watcher removes and reports unauthorized additions at the next scoped
poll. `open-task` may copy a live issue grant to its task PR; the gateway records
the exact inherited label event, so a later manual non-owner addition cannot reuse it.
While that inheritance is in flight (a journaled operation within two minutes), the
watcher does not judge the copied label, so a poll between the label write and its
proof never removes it. The watcher's own cleanup removal of an unauthorized label is
not a revocation: the task's other members keep their delegation. A copy whose label
was already removed is never certified retroactively, even if a late proof write
lands.

On an `AUTOPILOT #n` wake-up, continue the current step without waiting for an owner
move. You still make and document the engineering decisions:

1. In Scoping, settle your proposal, rewrite the final issue body and revise Estimate.
   Run `scope-review <issue> <summary-file>`. With current delegation it comments on
   Scoping → Spec review and, on your hash-bound scope review, comments on and moves
   Spec review → Executing. It rechecks delegation before the second move.
2. Run `open-task` and launch the worker normally. Inheritance is automatic; the
   expensive-model owner gate applies unchanged, with no autopilot exception.
3. Review the delivery and its evidence yourself. Run `review <pr> owner <file>`;
   under current delegation this records the Owner review handover, then an
   `AUTOPILOT APPROVED` comment naming the current head and moves to Approved.
   Existing held tasks, explicit owner summons and worker-stop rules still apply.
4. Run `merge-task` normally. It requires your exact-head autopilot review, current
   delegation and all ordinary CI/base/worker checks. It rechecks delegation after
   verification and comments that the merge is under autopilot. Finish the ordinary
   merge follow-up to Done. For a later clean base-only merge, carry that review
   instead of repeating it; see [merge and release](#merge-and-release).

If the label is added while already in Spec review or Owner review, perform your
corresponding review through the same wrapper; label presence alone is never a
scope or delivery approval. Adding/removing on either related card takes effect
at the next poll. On removal, stop making delegated decisions at the current step
and return to ordinary owner review; do not revert completed steps. Removing and
then adding again requires a new owner grant. Manual additions by you are not
an alternative to inheritance.

To stop delegation yourself, use `autopilot stop <issue|pr> <n>` on a card carrying
the label. This removal-only gateway command comments on the thread; it never
grants authority or reverts a completed step.

If a task PR lost its copied label — a watcher cleanup of an unproofed copy or a
failed first inheritance — restore it with `autopilot inherit <pr>`. The verb
re-runs the authenticated copy, taking authority only from the linked issue's
current live grant; a revoked grant refuses. The task's delegation never needed
repair on the issue side, because watcher cleanups leave it untouched.

Releases, permissions, identity pins (`people.yaml`) and every other owner-reserved
decision remain with the owner. The merge path refuses delegated merges to the
release branch and changes to identity/permission configuration. Ask the owner for
any other reserved action rather than treating autopilot as blanket permission.

## Develop issues and collaborate with the owner

File each issue estimated in Backlog, keeping open questions on the issue. The owner
moves it to Scoping when discussion should start. Keep initial intake visible as described
in [Lifecycle](lifecycle.md) and [Board](board.md). When a card reaches
Scoping, take it in priority order; do not wait to be told. The board order is
priority order: the top card is dealt with first (see
[card order](board.md#card-order)). Develop it on the issue,
flipping the assignee whenever the next move changes. Set an issue's initial
Estimate at filing with `issue create --estimate`; estimate a Backlog issue filed
without one (typically a collaborator's), or revise during discussion, with
`vmethod issue estimate <n> <points>` on the [shared scale](board.md#estimate-belongs-to-the-issue).

Record dependencies only in the blocked-by relation, never in issue text: a task
brief copies the body, so a copied blocker line reads as a live blocker. Set and
clear relations with `vmethod issue block <n> <blocker>` and `vmethod issue unblock
<n> <blocker>` (`<blocker>` is `#m`, `m` or `org/repo#m`); `issue create` and
`issue edit` refuse a body whose line consists only of a dependency reference.
Migrate old bodies with `issue block` to record the relation plus an `issue edit`
that drops the prose line.

Epics are issues with sub-issues ([board](board.md)): attach or detach a
configured-repository sub-issue to a configured-repository epic with
`vmethod issue parent <n> <epic>` and `vmethod issue unparent <n> <epic>`
(`<epic>` is `#m` or `m`) instead of a raw `gh` call. A parent in another
repository or org is refused before any write, and attaching is idempotent —
an already attached issue reports so — while an issue parented elsewhere is
refused, naming its current parent, before any write. File the sub-issue
directly under its epic with
`vmethod issue create <title> <body-file> --parent <epic>`: the attachment
follows the board writes, a failed attachment keeps the created issue and names
the exact `issue parent` retry, and the issue is never recreated.

Read code, settled decisions and git history before proposing to reverse deliberate
behavior. Separate verified facts from assumptions. Present options with a
recommendation and acceptance/verification criteria. **Confirm ambiguous readings
as explicit owner decisions before Executing**, never as a retrospective note.
Explore, assess and propose issues are your own analysis, not worker task PRs;
workers only implement agreed specs.

**Core rule: the project state lives on the board; chat is only very brief pointers.**

- Owner chat is a very short, priority-ordered list of pointers: `#n` plus a few words.
  No explanations, evidence, options or status narratives in chat; they go on the issue
  or PR, where the owner reads them.
- Anything waiting on the owner is asked through vmethod (`review <pr> ask` or
  `review <pr> owner`), so the card shows the owner as assignee with an owner Progress
  state. A question asked only in chat is not tracked and does not exist.
- Spec review and Owner review have exactly one turn assignee.
- Never repeat in chat what an issue or PR already says: that is duplicate work. Point to
  it (`#n`) instead.
- Use chat for coordination across items, never as a parallel record of decisions.

Ask owner questions only with `vmethod review <pr> ask .tmp/question.md`.
For an issue without an open task PR, use `vmethod ask <issue> .tmp/question.md`.
These commands post OWNER QUESTION, assign the owner and set `👤❓` only where
the answer belongs. A PR wait leaves linked issues Executing without owner
assignment or Progress; follow Development to the PR. A question asked in chat is not tracked.
Never leave a Spec review or Owner review card unassigned: the assignee is exactly whose move it
is. Review commands and the watcher maintain this invariant and report ambiguous
or mismatched board state rather than relying on your memory.

When the owner asks a question on a PR in review, answer and hand the turn back
with `vmethod review <pr> owner --in-reply-to <comment-url> .tmp/answer.md`.
This posts your answer with the reply link and current head, assigns the owner
and restores `👤🔍`. Plain `post` does not hand the turn back; it warns when the
card is still on you after an owner comment.

Comments in a pending review are invisible until the reviewer submits it.

## Owner summons inside Executing

Use `review <pr> ask .tmp/question.md` to summon the owner without leaving Executing.
You may also use `ask <issue> .tmp/question.md` on an Executing issue; its linked
workers pause too. Owner assignment and `👤❓` (or an explicit `👤🔍` owner turn)
are the pause, not a new lifecycle column. Do not open simultaneous issue and PR summons.

If the owner asks another question rather than deciding, continue the thread and
keep the pause. **An owner comment alone never resumes execution.** After they
agree in words, quote their exact words as a Markdown blockquote in your hand-back:

```sh
vmethod review 43 answer .tmp/handback.md --owner-agreed https://github.com/org/repo/pull/43#issuecomment-123
```

The flag is your attestation that the quotation is agreement. The gateway verifies
the current comment body, the effective owner identity (editor if edited), and that
the comment was posted after the summons on the same PR, or the summoned issue.
An edit by anyone else voids it. Without valid evidence, `answer` refuses to wake
the paused worker; `changes`, `owner` and `approve` cannot bypass the pause.
The independent release is **owner self-unassignment**: the watcher returns the
turn to you with `🧭🔍`, not directly to the worker. Then hand back with `review answer`.

The watcher reminds you with `ORCHESTRATOR TURN #n: waiting on you for 30+ min (<progress>)`
after observing a card on the orchestrator for 30 minutes, then hourly while that
stretch continues. Progress beginning `🧭`, or an orchestrator assigned in review,
counts as your turn. Act on the card or explicitly hand it over; an ordinary
comment does not reset the reminder.

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
happens once, after the owner moves Scoping → Spec review.

Before opening task PRs, fold every settled discussion conclusion into the issue
body. Scoping → Spec review agrees with the conclusions, not permission to launch.
On SCOPE, leave the issue in Spec review, read its current body, rewrite the final
specification and revise Estimate from the discussion:

```sh
vmethod read issue 42
vmethod issue edit 42 .tmp/scope.md
vmethod issue estimate 42 8
vmethod scope-review 42 .tmp/scope-changes.md
```

The edit refuses a body changed since your read; re-read and reconcile rather
than overwriting it. The summary file contains a short list of changes from the
original and the new Estimate with the reason for its revision (or why it is unchanged),
without a protocol tag or hash. `scope-review` generates SCOPE REVIEW
with the live Estimate and `body sha256: …`, keeps Spec review, assigns the owner and
sets `👤🔍`. Nothing is added to the body. Have the owner read it and move it to
Executing to give go. Spec review → Scoping requests more discussion; return the
turn to yourself with reset Progress. Changes require another rewrite
and scope review. `open-task` and `merge-task` check the same body-bound evidence;
an unchanged approval covers all parts despite intervening orchestrator moves.
Always post the review with `scope-review`, which computes the digest. Do not hash
the body by hand: shell pipelines (for example `jq` output) add a trailing newline,
the digest then never matches, and the owner's approval silently fails to count.
Hand-posted reviews may wrap the hex digest in backticks; exactly one hash line is
required in either format.

An owner Scoping → Executing move on an already-final orchestrator-written issue with only trusted
orchestrator comments (or no comments) is the trivial shortcut. Trust is per
repository ([security](security.md)): only this repository's bound orchestrator is
trusted; a peer project's orchestrator comments void it, as does anyone else,
including unknown authors/editors. Your own OWNER QUESTION
handover does not: fold conclusions into the body, not comments. Projects can opt specific
labels into `scope.fastPath`, for example `{ fastPath: [bug] }` under `scope` in
`vmethod.yaml`. A matching label waives the owner wait only after SCOPE REVIEW
records the current body; explicitly move that issue to Executing before launch.
It is off by default and unset in vmethod itself.
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
When the agreed work already exists on another branch — for example the owner's —
do not merge it into the task by hand: open the task with `open-task <issue>
--from <branch>` instead. It merges that branch into the task branch with a merge
commit, so its commits and authors survive the delivery, refuses conflicting
sources with the conflicting file names, and checks the lockfile before the task
branch exists. A manual merge risks a squash losing the branch's commits.
Set the PR card's Model field, respect holds and gates, and give one worker its own
worktree. The issue card's Model is the owner's hint: omit `--model` to use it, and
launch on a different family only when your analysis says otherwise, passing
`--model-override "<reason>"` so the override is recorded on the issue and graded
with the delivery's opening model segment. `worker start` generates the first prompt with inline authority rules,
task values and the guide path; adoption, backend changes and replacement sessions
receive it again, but ordinary same-backend switches and review wakes do not. Inspect
status shortly after launch for permission or turn failures. Keep prompts and logs
in worktree-local `.tmp/`. Do not launch a replacement session in an occupied tree.

## Review rounds and verification

Keep every PR draft unless it is really mergeable now. PRs that are Executing,
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
   Answer DESIGN, QUESTION, BLOCKED and HANDOFF only through
   `review <pr> answer <file>`, optionally with
   `--in-reply-to <comment-url>` naming the worker's protocol comment, which
   records the answer on the PR, updates the board and wakes the worker. A model
   switch alone does not hand back the turn; never substitute `worker send`.
6. Hand the delivery over as OWNER REVIEW with evidence and instructions; this moves
   only the PR to Owner review. Use an Executing summons for tactical owner questions.
   Owner review → Executing is the one-step changes bounce, returning the turn to you.
   Update the agreed issue when owner feedback changes the scope.
   Return requested changes to draft; workers never toggle draft state.

Body files for `review <pr> changes|owner|answer|ask|approve`, `ask` and
`scope-review` carry no protocol header: the verb writes the `[orchestrator]
<HEADING>` line itself and refuses, before anything is written, a file whose
first non-blank line already is one (`[orchestrator] …` or `[worker] …`), so a
heading never posts twice.

Behavior a person will see or feel is judged by **trying it**, not by metrics alone.
The specification must say that the owner tries it; metric acceptance is never
presented as “done” for that work.

Work the review columns top-down ([card order](board.md#card-order)): each review
round you answer moves the PR to the top of Executing, Owner review queues
handovers oldest-first, and Approved rows merge first at the top. Trust that
column order when picking up the next PR instead of reconstructing it from
memory or timestamps.

Green CI is not semantic review. A useful recurring finding belongs in one owning
guide with a guard where possible; do not copy the same rule into every prompt.
Review temporary exceptions and trends in complexity, dependency fan-in, duplication,
runtime and CI cost. Audit measurements must identify revision and cleanliness;
unknown tools or metrics are unknown, never zero. Commit periodic audit records only
from a clean integration checkout through the project's audit process, not a task's
incidental run. Local audit recipes and cadence stay with the project.

## Merge and release

Use `merge-task` (vmethod 1.0, #8) for task deliveries. Apply the [owner approval policy](roles.md)
and repository protections. Require the PR in Approved after the owner's
Owner review → Approved move, and merge Approved PRs top-down: the top card is
merge first. Stop the worker first. Require green checks for the
exact reviewed head **and current base**: an old green merge run is stale if its
base parent moved. `refresh-checks` updates the branch to trigger
a new run; re-running the old event still tests its old base. Conflicts go back to
the worker. Record base-only changes after owner approval rather than implying a
different head was reviewed. Emergency overrides must be explicit and logged and
never replace review.

After a clean `refresh-checks` base merge, you can also carry an exact-head
autopilot approval with `merge-task <pr> --carry-approval "<reason>"` without
re-running `review <pr> owner`. The gateway proves the intervening merges are
clean base-only changes and checks that the delegation is still current, including
immediately before merging. The carry record is marked `(autopilot)`. The automatic
carry after a conflict fixer uses the same proof; a task commit or changed task
patch needs fresh review. Releases and owner-reserved identity/permission files
still require the owner.

For your own adoption, configuration or documentation changes outside the task
lifecycle, push a non-task branch and run
`vmethod pr open <branch> "<type>: <subject>" <body-file> [--draft]`.
Hand over with `review <n> owner <file>`, then use `vmethod pr merge <n>` after the
owner's Owner review → Approved move, or your exact-head review under a current
autopilot delegation. Owner approval is always required: “unimportant” is not a
self-approval path. Identity and permission files always need the owner, even
under autopilot. The same green-head/current-base gates apply; the command
squash-merges and fast-forwards the main checkout. See
[non-task PR commands](gateway.md#non-task-pr-commands) for gates and recovery.

Abandoning a delivery — an answered spike, a superseded approach — is the
orchestrator's `close-task <pr> [--comment file]` (vmethod 1.0, #288), never raw
`gh`. It refuses PRs outside the configured repository, non-task PRs and closed
PRs before any write, then stops the recorded worker like merge follow-up (no
worker record skips silently), posts the optional checked comment and closes the
PR unmerged. The watcher moves the card to Done, reports the worktree cleanup
candidate and leaves a linked issue open for your LAUNCH decision; the command's
output reminds you to run `grade <pr>` on every closed delivery, merged or not.

When a worker cannot push a workflow change because its login lacks `workflow`
scope, use `vmethod push --task <pr> [worktree] [branch]` with your orchestrator
login, not raw `git push`. Point it at the worktree containing the commit (the
default is your current directory). It submits that worktree's `HEAD` to the
task PR's pinned head branch, checks ancestry and the regular push policy, and
journals the update as yours rather than worker activity. Your login must have
the required scope; do not change worker permissions to bypass the refusal. See
[orchestrator task pushes](gateway.md#orchestrator-task-pushes).

Owner approval survives conflict fixes (owner rule, 2026-10-18). Do not ask for
re-approval merely because the approved delivery needed conflicts resolved. Use
`merge-task <pr> --carry-approval "<reason>"` after reviewing the resolution and
certifying that it changes no behaviour. The gateway requires an earlier verified
owner approval and only two-parent merges of the PR's base since that approval;
it posts the approved/current SHAs, your reason and remerge-diff file list before
the journaled merge. Green head CI, mergeability, worker-stop and current-base gates
still apply. Any ordinary task commit requires fresh approval. If resolution
changes behaviour or revamps the algorithm, re-ask the owner instead of carrying
approval. Keep conflict-only fixes in Approved. The automatic clean-base exception remains unchanged; see
[approval and testing](gateway.md#approval-and-testing).

The conflict machinery protects that approval on its own. A conflict dispatch or
escalation never moves a card out of **Approved**: it reports the approval it
finds (`owner approval kept`), the escalation keeps the column, the resolution
carries the approval when it merges, and an owner move in the same watcher cycle
is still reported. The post-resolution restore re-reads the live card first, so an
owner who moved the card to Approved while the fixer ran keeps that decision —
the stored pre-conflict turn is restored only when no owner approval intervenes.
A conflicting PR also refuses `review <pr> owner` and `review <pr> approve`
before any write, and a handover on an active conflict
resolution is refused the same way, so the owner's gate never loses a running
fixer; resolve the conflict first, then hand over.

After merge, complete issue relations, board state, Done-6, grading, branch/worktree
cleanup and main-checkout fast-forward. Reinstall dependencies when `postMerge.trigger`
changes, using `postMerge.install`, **last**, after package-owned work finishes.
External owner button-merges need the same idempotent follow-up; a partial failure
resumes rather than merging again. Read and act on newly startable work and estimates
to reconsider, re-estimating where the work changed with `vmethod issue estimate <n> <points>`.
Log archive/follow-up failures and retry with bounded backoff.

Releases wait for a **quiet base branch**. Treat a release as its own reviewed card
with included changes, compatibility, migration, benchmark and deployment evidence.
Use `checks.release` and project hooks for the actual recipe. A new package needs
its registry bootstrap and trusted publishing/provenance configuration before its
first release; check this explicitly rather than discovering it during publishing.

Before publishing, run `learnings annotate --since <last-release-ISO-date>` and
`learnings aggregate` as the orchestrator, review the cited annotations and generated
family/by-domain advice, and submit the learning changes for review. Each project
annotates its own repository; apply [private reduction](learnings.md#annotate-threads-and-regenerate-advice)
before any private evidence leaves it.

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

When launching without a Model on the issue card, `open-task` prints its own advice
before the opened-PR line: `suggest-model #<issue>: <family> (<reason>; <family>
averages $<usd>/point over <k> graded tasks)`, without the evidence clause while
`learnings` has no graded tasks for the family; and a second
`note: <chosen> is a more expensive tier than the suggestion (<chosen> averages
$<usd>/point over <k> tasks)` line when the chosen family's tier costs more than
the suggestion's. Both lines inform only — never refuse the launch over them; read
the evidence, tell the owner, and let them correct the family as in §2.6 of the
NNext adoption review.

Use a capable generalist for design, judgment and cross-cutting work; consider a
cheaper model for a well-specified bounded task, and require vision when needed.
The baseline default family is sol unless an explicit selection or an issue hint
supplies another; project policy and current learnings guide deliberate overrides.
An edit-acceptance mode is not a filesystem sandbox: workers run as your OS user,
separated by their own checkout and identity, not by file permissions. Never
bypass permissions. Owner-gated
families (`gate: owner`, today astra and fable) require two-layer authorization,
including when selected by full id: your own `--owner-approved` flag on
`open-task`, `worker start` or `worker model`, **and** an approval the gateway
can verify — the owner's task issue or task PR comment whose first line is
exactly `APPROVE MODEL <family>`, posted after the issue body's last edit (#218),
or the owner having set the issue's or task PR's card **Model** to that family
themselves (#242): GitHub records who set each project field value, and only a
value the owner set counts, while a Model written by anyone else, including
`open-task` writing the task PR card, never counts. The gateway refuses until it
can verify one of the two and names both ways. An owner comment is verified by
its pinned identity (an edit by another account voids it), so ask the owner to
post the line after agreeing scope; editing the issue body voids every earlier
line and needs a fresh one. A direct task has no issue to read at open time: its
launch still verifies the task PR for the line.

On quota or model failure, inspect status/logs, switch the existing session through
the worker wrapper and continue with its context on the same backend. A backend
change requires an idle worker and starts a fresh context with onboarding; it keeps
the recorded usage history. Do not silently replace the session or give visual
work to a text-only fallback.
Track the actual family on the PR after a successful switch.

Use `grade` (vmethod 1.0, #9) after every closed delivery, merged or not. Update the
**issue's** final Estimate, never the PR's. Grade records exact event metrics,
initial/final points, segments, structured switch reasons and outcome, not handwritten
judgement. Put **all learnable judgement in the thread**: REVIEW, OWNER REVIEW,
ANSWER and switch NOTEs, never only in chat. State round causes and findings plainly
so the later annotation can distinguish worker defects, owner changes and prompt
defects without guessing. Use `worker model --reason <category> --why "details"`;
the fixed categories and telemetry semantics are in [shared learnings](learnings.md#exact-grade-telemetry).
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

Run `watch` unwrapped, with no filtering pipe: filtering can hide the wake line
while still acknowledging its batch.

`watch` never exits on its own, so a plain background shell never wakes you. Run
it as a monitored background shell with a 30-minute timeout (`background: true`,
`monitor: true`, `timeout: 1800000` with the [opencode-monitor](adoption.md)
plugin), so each line reaches you as it prints and the timeout is the expiry.
The plugin stops forwarding after 100 lines while the command keeps running and
acknowledging; treat its `[monitor stopped …]` line as an expiry: stop that
watch and re-arm. Stop it with `watch --stop` instead of a pattern kill: the
verb verifies the lock holder before it signals, so it cannot match an
unrelated command line, and it leaves the state directory ready to re-arm; see
[stopping the watcher](gateway.md#watching-and-muting). A `quiet since the
last wake-up:` digest always rides on a wake event. A digest without its wake
line means a lost event: replay it with `watch --replay previous`.

On every re-arm, run `watch --replay previous` first, then list the cards on your
orchestrator turn and act on any you have not yet handled. Replay uses the previous
real watch start in the same state directory, so you need no cursor after context
compaction. Then start the unwrapped `watch` again. History is retained for seven
days; `watch --replay <seq|time>` supports manual inspection. See
[delivery and replay](gateway.md#watching-and-muting).

The first watch after adoption or a version bump prints the installed version,
guide path and version's release notes. Read the guide when that notice appears;
subsequent starts of the same version stay quiet.

A `button-merge` event (`PR #n MERGED by <owner>: run merge-task`) is an action
item, not information: run `merge-task <n>`. The event repeats until merge follow-up
is complete. The watcher itself never writes that follow-up.

When the watcher reports `NOT PLANNED #n`, post one short comment on the issue
mentioning its requester so they know not to wait or fork locally. Quote the owner's
reason when one was given. If the event says an open task PR remains, decide whether
to close that PR with `close-task <pr>`; the watcher does not close it
automatically.

`NEXT` names the top Scoping card whose turn is yours. A card waiting on the
owner (owner-assigned or an owner `👤…` Progress state) stays unnamed until the
owner hands the turn back, so retiring another Scoping card never wakes you for
the owner's move. Take cards in board order from there; see
[card order](board.md#card-order).

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

## Before a release

1. Merge every open `learning` PR with `learnings merge <pr>` (vmethod 1.0, #308): it
   refuses any write unless the PR is open, carries the `learning` label, passes the
   check-pr validation and has the central `check` job green on its exact head, then
   squash-merges and reports the merge commit. Then distil
   the evidence: `learnings annotate --since <last release>` and `learnings aggregate`
   regenerate `learnings/models/<family>.md` and `by-domain.md` (see `docs/learnings.md`).
   Spot-check a few annotations against their threads, review the page diff, and commit
   both in a learning PR. `learnings report` gives the numbers; add any new general lesson
   to `learnings/lessons.md`.
2. Confirm dev is green and that no approved PR is waiting to merge.
3. Publish the release candidate with `release next` (vmethod 1.0, #308): it refuses
   unless the checkout sits on `dev` (`baseBranch`) with its local head at the remote head,
   dispatches the `Publish` workflow on `dev`, waits for that run with a bound, and reports
   the published version, the npm `next` dist-tag, the git tag and the GitHub release URL.
   npm evidence polls the registry with a bound because registry propagation can lag the
   publish by minutes; when the bound expires while the tag and release exist, the verb
   still succeeds with a `npm next not visible yet (registry propagation)` warning.
   A red run reports its failed step and the run URL; rerun the workflow to repair missing
   release metadata. The owner's go for a release remains a separate decision the verb does
   not replace: a stable release still moves `master` through the release process.
