# Tooling incident rules

Preserve state and fail visibly when automation cannot prove its next action is safe.

## No silenced failures

Never suppress errors on anything that drives state with `2>/dev/null || true` or
equivalent without a logged, actionable failure. Distinguish expected absence from
failed reads. Do not turn unknown state into empty data, successful writes or zero
measurements. Preserve the original error, command outcome and retry guidance.
Retries are bounded and idempotent; documented retry outcomes are not BLOCKED.

Parse machine output explicitly: select named fields or consume every documented
column with a trailing discard field. Do not let the final meaningful field absorb
new columns. Normalize numeric values before comparing them.

## One reader per state directory

The watcher takes a lock before reading or advancing state. A second reader refuses
the same directory; distinct tracks have distinct state. Preserve `stateName` and
existing once, graded and merged markers during adoption so old events do not replay.
State and caches belong under the OS user's state/cache roots, not the package tree.
Each user runs the package from their own checkout; never another user's installation.

## GraphQL budget and listing lag

Reuse the existing board poll for grading, launch and progress decisions. Do not
add a query per card, busy-loop board reads or loop failed calls. The account budget
is shared across sessions and repositories. Pace requests against response headers
for remaining budget and reset time, **not** the query's `rateLimit` field or a
separate rate-limit endpoint. Retain the lowest remaining count for a reset window,
keep a reserve and back off until reset. Queue deferred writes explicitly.

A newly added card can be missing from board listings while the issue already
shows membership. Read the issue-side relation through the gateway before “fixing”
or duplicating the card. Migrations batch and pace writes, pause above the reserve
and report what remains.

## Fakes and guards fail loudly

Gateway tests inject fetch/exec and run offline through fake APIs, boards, workers
and commands. Any unexpected request or command fails the test; there is no silent
default. Include hostile titles, bodies and branches, untrusted authors, fake tags
and closing syntax as data. Every test and suite has a timeout.

Test behavior, not source greps. Patchers and fixture rewriters assert anchors and
replacement counts. Missing scan/build inputs fail rather than produce an empty
pass. Consumer hooks can use the shared testing kit when available; project-specific
verification recipes remain local hooks rather than shared assumptions.

## A package replacing itself

A merge can reinstall the very package that is running. Avoid **version mixing**:
later sourced helpers, scripts or lazy imports must not load the new version halfway
through an old run.

- Build a single readable bundle without split, lazily loaded chunks.
- Snapshot the whole legacy tree into a per-run temporary directory at startup;
  every legacy step runs from that snapshot.
- Wrap every remaining Bash entry point with `main "$@"; exit` so a fast-forward
  cannot append newly read script text to the active run.
- Finish archiving and board updates before dependency reinstall, which is last.
- Test replacement between steps and assert that all steps use the starting version.

Launch packaged Bash as `bash <file>`, never by relying on executable bits outside
bin targets. The packed-install smoke test proves this distribution behavior.
