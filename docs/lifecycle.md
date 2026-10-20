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
4. An owner Approved move initially agrees with the discussion's conclusions,
   not permission to start. Move the issue to In progress, rewrite its body into
   the final scope, then request [scope review](orchestrator-guide.md#scope-review).
   The owner reads that body and moves it to Approved again. Approval is bound to
   the body hash recorded in SCOPE REVIEW; changing the body voids it.
5. `open-task` (vmethod 1.0, #8) creates a draft task PR whose description is the
   complete worker prompt. Record its issue relation through the wrapper, not
   closing phrases in agent-authored prose. Move the issue to In progress.
6. One worker implements that PR in its own worktree. Questions stop work;
   authenticated amendments update the prompt. An on-hold task waits for GO.
7. The worker reports READY with green CI. The orchestrator independently reviews
   and verifies it. Changes return to the same worker for the next numbered round.
8. Hand the delivery to the owner with evidence, try-out instructions and explicit
   decisions. If feedback changes scope, update the issue as well as the PR prompt.
9. After approval, verify the exact head against its current base, stop the worker,
   then use `merge-task` (vmethod 1.0, #8). Complete board, grading and checkout
   follow-up; act on newly unblocked work rather than waiting for another event.

Approval survives base-merge conflict fixes without a new owner review. After
checking that the resolution changes no behaviour, the orchestrator uses
`merge-task <pr> --carry-approval "<reason>"` to certify the carry on the PR;
only base-merge commits may follow the approved head. Behaviour changes or an
algorithmic revamp require fresh owner approval, as do ordinary task commits.
All other merge gates remain in force. See the
[owner rule and merge procedure](orchestrator-guide.md#merge-and-release).

An issue can have several deliveries. Only its last completed delivery closes it;
earlier deliveries preserve the open issue relation. A delivery into an integration
branch does not close the issue until the integration reaches `baseBranch`.
An unchanged approved body covers every part; only a changed body needs scope
re-approval. Orchestrator board moves between parts do not revoke that approval.

## Shortcuts

- `open-task --direct` (vmethod 1.0, #8): the owner explicitly settled the work and
  said go in their own chat. Capture the entire agreement in the PR description
  because there is no issue specification to consult. If go is ambiguous, ask.
- `open-task --unapproved` (vmethod 1.0, #8): open before Approved only with the
  reason recorded on the issue, such as an evidenced bug with a reproducer or
  profile. It is an explicit exception, not a way to turn an investigation into
  an implementation task or to skip delivery approval.
- An orchestrator-written issue with only trusted orchestrator comments (or no
  comments) can use its owner's Approved move directly. Trust is per repository:
  only comments by the repository's own bound orchestrator count, and a peer
  project orchestrator is never trusted here. A comment from anyone
  else, including an unknown author or editor, voids this trivial shortcut; use
  SCOPE REVIEW instead. The orchestrator folds conclusions into the body, so its
  own OWNER QUESTION handover does not void the shortcut.
- Projects may configure `scope.fastPath` with label names. A matching issue still
  needs a current body-bound SCOPE REVIEW, but does not wait for owner scope approval.
  This is off by default; vmethod leaves it unset. Delivery approval is unchanged.

Explore, assess and propose issues are orchestrator analysis, not task PRs.
Workers implement agreed specifications, not open owner decisions.

## Dependencies

Dependencies live **only** in the blocked-by issue relation, never in issue text: open-task
copies the body into the task brief, where a prose blocker line reads as a live blocker.
Set relations with `vmethod issue block <n> <blocker>` and clear them with
`vmethod issue unblock <n> <blocker>` (`<blocker>` is `#m`, `m` or `org/repo#m`);
`issue create` and `issue edit` refuse a body whose line consists only of a dependency
reference. Record relations when filing an issue, including cross-repository blockers
where needed. A blocked Ready card stays there until its open blockers close; take the
next unblocked card. Closing a blocker prompts a fresh estimate, not automatic
subtraction of points.

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
Use `merge-task --merge-commit` (vmethod 1.0, #8), not an ad hoc merge.
