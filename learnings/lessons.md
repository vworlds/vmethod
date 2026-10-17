# Lessons

Project-independent practices learned by VWorlds orchestrators. Each entry names its source
and evidence. Entries are advice, not rules: a lesson becomes a rule only through a
`change-request` (see `docs/change-process.md`).

## Models

### Finish on a cheaper model once the hard thinking is done

_Source: SpaceRocks orchestrator, shared at the owner's request (2026-10-16). Evidence:
spacerocks PR #346; vmethod PRs #22 and #23._

When an expensive model has settled the diagnosis and the design, switch **the same worker
session** to a cheaper model to finish the mechanical part: focused tests, commit and push,
re-running measurements on the final commit, waiting for CI, the READY report. The session
keeps its whole context, so nothing has to be re-explained.

**Signal to switch:** only verification and reporting remain. Quota exhaustion on the
expensive model (for example, the provider answering 502 "all subscriptions are temporarily
disabled") is a natural moment to check.

**Before switching**, confirm the remaining work really is mechanical: read the worker's
uncommitted diff and its last focused test result.

**How:**

1. Switch the model in place (`worker model <pr> <family>`, #9). An owner-gated family
   needs `--owner-approved`, and the PR card's Model field follows the switch.
2. Send an explicit finish list with `--now`: what is already done (name the uncommitted
   files), the exact remaining steps in order, and "no further design changes unless a check
   shows a regression; then ask, with numbers".
3. Cancel any scheduled resume for the expensive model.
4. Record the switch in the model log as a new `segment` with `why: "quota"` (or
   `"escalation"` / `"finish"`).
