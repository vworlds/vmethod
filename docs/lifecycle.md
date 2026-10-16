# Work lifecycle

Develop an idea on an issue; build and check one delivery on a task PR.

## From idea to delivery

1. Record the idea as an issue with dependencies and an initial Estimate in Backlog.
   Hand over newly filed issues promptly: estimated, In review, assigned to the
   owner, with open questions. Do not silently start implementation.
2. The owner prioritizes work in Ready. The orchestrator takes the first unblocked
   card, moves it to In review and develops it on the issue.
3. Read the relevant code and settled decisions. Present the problem, options,
   recommendation, exclusions, observable acceptance cases and verification plan.
   Resolve ambiguous readings explicitly with the owner before Approved.
4. The owner approves the agreed specification. Preserve it in the issue body;
   earlier discussion remains in the edit history and comments.
5. `open-task` (vmethod 1.0, #1) creates a draft task PR whose description is the
   complete worker prompt. Record its issue relation through the wrapper, not
   closing phrases in agent-authored prose. Move the issue to In progress.
6. One worker implements that PR in its own worktree. Questions stop work;
   authenticated amendments update the prompt. An on-hold task waits for GO.
7. The worker reports READY with green CI. The orchestrator independently reviews
   and verifies it. Changes return to the same worker for the next numbered round.
8. Hand the delivery to the owner with evidence, try-out instructions and explicit
   decisions. If feedback changes scope, update the issue as well as the PR prompt.
9. After approval, verify the exact head against its current base, stop the worker,
   then use `merge-task` (vmethod 1.0, #1). Complete board, grading and checkout
   follow-up; act on newly unblocked work rather than waiting for another event.

An issue can have several deliveries. Only its last completed delivery closes it;
earlier deliveries preserve the open issue relation. A delivery into an integration
branch does not close the issue until the integration reaches `baseBranch`.

## Shortcuts

- `open-task --direct` (vmethod 1.0, #1): the owner explicitly settled the work and
  said go in their own chat. Capture the entire agreement in the PR description
  because there is no issue specification to consult. If go is ambiguous, ask.
- `open-task --unapproved` (vmethod 1.0, #1): open before Approved only with the
  reason recorded on the issue, such as an evidenced bug with a reproducer or
  profile. It is an explicit exception, not a way to turn an investigation into
  an implementation task or to skip delivery approval.

Explore, assess and propose issues are orchestrator analysis, not task PRs.
Workers implement agreed specifications, not open owner decisions.

## Dependencies

Use **Blocked-by issue relations**, not a mention in prose alone. Record them when
filing an issue, including cross-repository blockers where needed. A blocked Ready
card stays there until its open blockers close; take the next unblocked card.
Closing a blocker prompts a fresh estimate, not automatic subtraction of points.

## Tracks and packs

A track isolates a separate orchestrator session. Membership is explicit through
the track label and linked issue; task PRs inherit it. The main session skips track
items, and a track session acts only on its own items. Select it with `track`
(`VMETHOD_TRACK`); use `baseBranch` (`VMETHOD_BASE`) for its integration base.
Give each track separate watcher state derived from `stateName` and a single reader.

Keep the integration branch current with its base by merging, not rewriting shared
history. End the track with a reviewed integration PR to the configured base.

A pack groups deliveries for integration. Test their combined heads, not just each
PR in isolation. Use the configured `branches.packPrefix` and `branches.trackPrefix`,
not hard-coded branch names. Pack integration preserves history with a merge commit;
say so in its task prompt and retain the pack head unless the owner requests deletion.
Use `merge-task --merge-commit` (vmethod 1.0, #1), not an ad hoc merge.
