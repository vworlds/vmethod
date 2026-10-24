# Autopilot label-event recording

`autopilot-wire.json` is the complete response supplied by the verified repository
orchestrator in PR #244's ANSWER on 2026-10-24. It was recorded through the
orchestrator credential against closed smoke issue #239 (adding and removing
`enhancement`) and PR #231 (empty label history). Only JSON whitespace is formatted;
wire fields and types are unchanged. Scratch originals are `.tmp/autopilot-wire.json`
and `.tmp/autopilot-wire-recorded.graphql` in the task worktree.

Tests project the label name to `autopilot`, identities to isolated numeric pins,
and IDs, timestamps and thread numbers to deterministic scenarios. Node identity
and repository fields use the existing issue-scope recording projection. Aliased
batched envelopes and pagination reuse the recorded connection shape. Inheritance
metadata and thread comments are application data, not additional API recordings.
