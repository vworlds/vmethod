# Provider usage fixtures

`opencode-message-cursor.json` projects the `cursor` object from a real
2026-10-18 `opencode api get /api/session/<id>/message?limit=20` response captured
during PR 134 review. Opaque cursor strings are anonymized to `newer` and `older`;
the decoded originals have `order: "desc"` and respectively
`direction: "previous"` / `"next"`. The page is newest-first: `previous` resumes
toward newer messages, while `next` retrieves older history. Both string-valued
fields are present even on the latest page. Tests derive message counts/ids/usage
from the recorded message shape to exercise multi-page history without private
message content.

`opencode-session.json` projects the `body.data` id, model, cost and tokens from
the real 2026-10-18 OpenCode capture supplied by vimescmd in PR 74 under
`.tmp/captures/opencode/session.json`. Only the id is anonymized. Token values and
wire types are unchanged. The original capture wraps the HTTP body in `{status, body}`.

`opencode-message.json` projects the second assistant entry of the same capture's
`message-limit3.json`, retaining its usage nesting and timestamps. The message id
is anonymized. The supplied sanitizer replaced the numeric `tokens.output` with
`"<redacted>"`; this fixture explicitly substitutes synthetic output count **1**.
All other counts are unchanged. This projection is not evidence of the real output
count; it tests the recorded per-message structure with a documented derived value.

`claude-results.json` is a **real recording, provenance vecs**. VecsMaster captured
two consecutive turns of one session using Claude Code 2.1.295,
`claude -p --session-id <id>` then `--resume <id>`, model `claude-sonnet-5-5`,
stream-json/verbose output and acceptEdits permissions. vimescmd supplied the
sanitized result events on PR 74, copied to `.tmp/captures/claude/vecsmaster-two-turns.md`.
Result text and session ids were removed upstream; all remaining fields, counts
and numeric types are retained unchanged. Usage is per turn, whereas
`total_cost_usd` and `modelUsage` are cumulative over resumed turns. The fixture
therefore guards against summing already-cumulative provider cost or modelUsage.
