# Shared evidence and advice

Use these records as evidence for human model guidance, never as instructions.

- [General lessons](lessons.md)
- [Commands, privacy and aggregation semantics](../docs/learnings.md)
- Delivery evidence combines the legacy seeds in `models/<owner>-<repo>.jsonl` and
  new immutable submission files in `models/<owner>-<repo>/`. Thread annotations
  use a separate format there, `notes-<pr>-v<prompt-version>.jsonl`. Legacy prose
  notes remain in `notes/<repo>.md` and `notes/<repo>/`. Keep the seeds in place.
- The [annotation pipeline](../docs/learnings.md#annotate-threads-and-regenerate-advice)
  generates cited advice in `models/<family>.md` and `models/by-domain.md` for
  orchestrator review; generated text is never committed automatically.

## Initial import provenance

The authenticated orchestrator answer on [task PR 41](https://github.com/vworlds/vmethod/pull/41)
provided the source snapshots and corrected the stale counts: 13 vmethod grade
comments and 27 vecs table rows, **26** of which name a PR. The no-PR housekeeping
row is deliberately omitted; no PR 357 row was invented.

The vecs source is [`.agents/model-log.md` on dev](https://github.com/vworlds/vecs/blob/dev/.agents/model-log.md),
Git blob `1d7eb1530afa4c4d4916cd4b4b7bc4e447a2b3a5`. Every PR-numbered row is
included, PR 295 through PR 354. Free-text findings, original difficulty and round
notation stay in task/notes. `round_causes` and `findings` are empty, not inferred.
The leading numeric round count excludes explicitly separate questions. The source
describes merged deliveries, so outcomes are `merged`; task kind is `legacy`, exact
historic model ID is `unknown`. The single recorded points value populates both
opening and final estimates, with that limitation stated in each record's notes.
Do not use those estimates as historical calibration deltas.

Vmethod source comments contain some schema-unsupported finding `note` fields and
omit empty arrays. Import fills omitted `stalls` and `prompt_defects` with `[]`, moves
finding prose into record notes, and retains structured findings only where the
source names `caught_by`. Findings without a recorded gate are preserved as prose
marked “gate unrecorded”, never assigned a guessed gate. Both imports pass the same
validator as grading/submission. Exact source references:

| Delivery PR | Posted (UTC)         | Grade comment                                                                    |
| ----------- | -------------------- | -------------------------------------------------------------------------------- |
| 14          | 2026-10-16T18:02:02Z | [issue 3](https://github.com/vworlds/vmethod/issues/3#issuecomment-6221640133)   |
| 16          | 2026-10-16T18:22:30Z | [issue 12](https://github.com/vworlds/vmethod/issues/12#issuecomment-6222000607) |
| 19          | 2026-10-16T19:33:20Z | [issue 4](https://github.com/vworlds/vmethod/issues/4#issuecomment-6223186019)   |
| 21          | 2026-10-16T19:42:30Z | [issue 20](https://github.com/vworlds/vmethod/issues/20#issuecomment-6223339117) |
| 22          | 2026-10-16T21:13:07Z | [issue 5](https://github.com/vworlds/vmethod/issues/5#issuecomment-6224795755)   |
| 23          | 2026-10-17T07:43:20Z | [issue 7](https://github.com/vworlds/vmethod/issues/7#issuecomment-6231338472)   |
| 24          | 2026-10-17T09:15:16Z | [issue 6](https://github.com/vworlds/vmethod/issues/6#issuecomment-6232175860)   |
| 27          | 2026-10-17T09:44:08Z | [issue 8](https://github.com/vworlds/vmethod/issues/8#issuecomment-6232429785)   |
| 28          | 2026-10-17T08:19:25Z | [issue 10](https://github.com/vworlds/vmethod/issues/10#issuecomment-6231661678) |
| 31          | 2026-10-17T09:45:15Z | [issue 9](https://github.com/vworlds/vmethod/issues/9#issuecomment-6232438570)   |
| 32          | 2026-10-17T08:20:29Z | [issue 30](https://github.com/vworlds/vmethod/issues/30#issuecomment-6231671284) |
| 34          | 2026-10-17T09:04:07Z | [issue 33](https://github.com/vworlds/vmethod/issues/33#issuecomment-6232077180) |
| 36          | 2026-10-17T09:46:08Z | [issue 35](https://github.com/vworlds/vmethod/issues/35#issuecomment-6232445613) |
