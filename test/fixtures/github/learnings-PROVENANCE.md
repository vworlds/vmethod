# Learning REST fixtures

`learnings-recorded.json` contains minimal projections of the captures supplied by
the authenticated orchestrator answer on PR 41. Vimescmd captured these read-only
through `vmethod gh-read` at dev `2ec1f53`, 2026-10-17T12:20:17Z. Original captures
remain ignored scratch inputs, not committed logs. Only fields needed to exercise
decoding are retained. Tokens, permissions, prose PR bodies, patches, links and
unrelated identity fields are omitted; the gateway-added `attribution` is removed.
Numeric IDs, ISO timestamps, nulls, arrays and newline-wrapped base64 retain their
recorded wire types.

## Recorded projections

- `repository`: GET `/repos/vworlds/vmethod`.
- `ref`: GET `/repos/vworlds/vmethod/git/ref/heads/dev`.
- `tree`: GET `/repos/vworlds/vmethod/git/trees/67f323cd904e6bcbc3698009ff3d9f818a1d8617`;
  only one entry is retained from the root listing.
- `viewer`: GraphQL `viewer { id databaseId login __typename }`; REST `/user`
  identity is derived by mapping `databaseId` to `id` and `__typename` to `type`.
- `pull`: GET `/repos/vworlds/vmethod/pulls/40`. The supplied filtered recording
  **does not contain head/base**, despite the capture manifest listing them.
  Tests add those documented fields explicitly as derived data, never a recording.
- `files`: GET `/repos/vworlds/vmethod/pulls/40/files?per_page=3`. This is a
  three-file sample, not the complete 22-file list. Scenario tests retarget filenames,
  statuses and counts, and deliberately generate pagination/missing-file cases.
- `people` and `lessons`: GET `/repos/vworlds/vmethod/contents/<path>?ref=dev`.
  Both original base64 bodies and their embedded newlines are retained. The captured
  registry predates `repos` bindings; tests explicitly add owner-approved bindings
  when constructing successful submission scenarios.

## Derived from recorded GET shape or documented wire shape

As authorized in the orchestrator answer, tests derive fork GET/create (202) objects
from `repository`, retarget owner/full_name, set `fork: true`, and add `parent`.
Git ref-create (201) derives from `ref`; tree-create (201) derives from `tree`.
Git commit GET/create and compare are documented shapes, **not recordings**; only
the needed SHA/tree/parents and file metadata are generated. PR create (201) and
list derive from `pull`, retarget author, open/merged state, URL, and documented
head/base metadata. List items explicitly omit `changed_files`; only PR detail
checks depend on that field. Error 404 responses, asynchronous fork readiness,
label-write replies, hostile content and dropped-response errors are simulated.
Issue 51's live probes recorded sync refusal (422), update-branch refusal (403),
and ref creation at a central-only commit (404). Submission tests no longer model
sync success: any sync request fails loudly. Fork dev ref/tree SHAs are retargeted
from the recorded envelopes to differ from central, modelling a behind fork.
PR 52's authenticated round-1 review replaces the identical-bytes precondition with
add-only submission files. Central tree listings derive from the captured tree
envelope, retarget blob paths and add documented recursive-tree `truncated: false`.
Content reads use the captured base64 envelope for legacy seeds, chunks and notes.
Open PR lists/details derive from the captured pull with explicit head/base metadata;
file lists reuse the captured file envelope with add-only project paths (or the
legacy modified seed for read-only pending compatibility). Merged/closed states,
stale fork refs and lost replies are scenario data, not additional recordings.
Commit writes assert the fork's parent and tree, never central-only objects.
Rolling submission scenarios derive ref-update responses from the same recorded
ref envelope, retargeting the SHA and branch. Trees inherit the open PR's files,
commits receive distinct SHAs, and staged files become visible only on ref creation
or update. Tests assert the current parent, inherited tree and `force: false`;
head movement and a lost successful update response are explicit scenario data.
Worker-management gateway tests reuse these envelopes to model an already-shared
grade: their central seed contains the grade's record and their open PR list is
empty. This exercises production auto-submission wiring without duplicating the
rolling-PR write fake.

`test/gateway/learnings.test.ts` exercises these envelopes through the real
`GitHubClient`, submission/show decoders, cursor persistence and central metadata
policy. Its loud fetch wrapper retains unexpected-request/assertion failures even
when the real HTTP client catches a transport error. Fork/PR writes remain offline;
the orchestrator owns live submission smoke before OWNER REVIEW.
