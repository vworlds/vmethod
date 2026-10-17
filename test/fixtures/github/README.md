# GitHub board field regression

`board-fields.json` is a minimal projection of the field shape reported by the
orchestrator's live vworlds/vmethod run in PR #24 review round 2. The creation-time
value (`2026-10-16T11:12:25Z`) and ISO string wire type come from that report.
The report did not include a full response recording: the connection envelope is
the queried GraphQL shape, and the field identifier is an offline placeholder.
Only the Progress field is retained to exercise snapshot decoding and writing.

Do not represent this as an unmodified full API capture. Future full recordings
should retain the original wire types and document their redactions here.
