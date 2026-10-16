# Gateway

`src/gateway/` owns GitHub and opencode access. CLI verbs call a typed `Transport`;
the shipped transport runs the server in process. Only server-side code reads
credentials or handles unfiltered responses. This is not yet a separate credential
sandbox: owner-installed permissions remain necessary.

## Identity pins (pre-1.0 migration)

Every `people.yaml` entry now requires `login`, numeric `id`, `type` (`User` or
`Bot`, exactly GitHub's account type), and `role`. System entries also require
nonempty `events` and `appIds` arrays. All template numbers are placeholders: the
owner must replace them with verified identities and application IDs. There is no
default trusted application, and missing pins fail configuration validation.
`vmethod check` reports invalid pins with source line numbers. Do not let agents
change their own trust list.

Login, numeric ID and type must agree. Edited text is attributed to its verified
editor; a missing editor on edited text fails closed. Repository ownership must
match `org`. System comments are dropped. Check runs yield only structured facts
from applications explicitly pinned to a system entry permitting `check_run`.
Names, titles, protocol tags and commit metadata confer no authority.

## Commands

- `vmethod read pr <n> [--files|--diff|--reviews|--checks]`
- `vmethod read issue <n>`
- `vmethod read comment <id>` (numeric issue-comment ID in the configured repo)
- `vmethod read checks <n>` (PR number)
- `vmethod read registry <package>` (untrusted npm metadata)
- `vmethod post <ref> <file>`
- `vmethod gh-read <endpoint|file.graphql>`
- `vmethod dropped [--since <ISO-date>]`

Thread references also accept `org/repo#n` within the configured org. Invoke the
installed package with `npm exec --no -- vmethod`, never a downloading fallback.

Read operations gate metadata before fetching bodies, comments, reviews, files,
diffs or checks, and recheck identity on body responses. Accepted text is labelled
`from <login> (<role>)` and enclosed in an untrusted-data fence longer than any
backtick run in its content. A protocol tag inside that fence is only data.

`post` reads a file, checks nonempty Markdown and balanced fences, parses Mermaid
diagrams using the exact-version installed Mermaid peer and jsdom, rejects
closing/association syntax, and verifies the target thread. It sends the exact
file content, with **no footer**. Posts on unaccepted threads are refused.

`gh-read` accepts scoped `/repos/org/repo/...` GET endpoints, not arbitrary URLs or
method switches. GraphQL files are parsed in full: exactly one query is allowed;
mutations, subscriptions and additional operations are refused before networking.
The server augments known author-bearing selections with identity, editor and
repository metadata, including aliases and fragments. Reserved `__vm_` aliases
cannot be supplied by callers. Known author-bearing REST output is filtered too;
unverifiable REST edits are dropped rather than guessed. Check/status/workflow
diagnostics yield allowlisted structured fields, never system free text. All
diagnostic output is fenced as untrusted data, including registry metadata.

The diagnostic verb is not a generic write transport. New writes belong in named,
policy-enforcing server operations. Future operations can extend the typed map
without exposing raw clients to CLI verbs.

## Credentials and budget

`credentials.githubToken` is the **name** of the launching wrapper's token
environment variable. The server never consults git configuration or token
command-line arguments. Opencode uses `OPENCODE_BASE_URL`,
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`; Basic authorization is
built in memory and sent only in a header. Neither client follows redirects.

`gateway.reserve` defaults to 100 and `gateway.maxRetries` to 3. GitHub responses
at or below reserve plus one schedule a pause until the header's reset time before
the next request, reporting `BUDGET`. Only `x-ratelimit-*` headers drive pacing,
never a GraphQL `rateLimit` field. Secondary 403/429 limits honor `retry-after`
and report `BUDGET (secondary)` even when the primary budget looks healthy.
Network errors and 5xx responses retry with reported exponential backoff. Terminal
errors propagate; nonempty GraphQL errors reject even HTTP 200 with partial data.

Dropped records live in
`$XDG_STATE_HOME/vmethod/<stateName>/dropped.jsonl`, defaulting to
`~/.local/state`. They contain only timestamps and GitHub links. The owner digest
prints links and counts, never bodies, titles or author names. Repeated reads can
produce repeated drops; the counts are observations, not unique contributions.

## Approval and testing

`isOwnerApproved` returns `true`, `false` or `'unknown'`. A verified owner review
must be APPROVED on the current head. A Status-to-Approved project timeline event
must identify the owner as its actor; missing actors yield unknown, not approval.
Current card Status and peer-session relays never approve. Chat approvals remain
the harness's responsibility and are never synthesized into GitHub records.

Tests inject strict fake fetch/exec, clock and sleep implementations. No test
needs a real GitHub token, opencode server or git process. Mermaid tests use
installed local peer fixtures. Optional peer usage is intentional, so Knip's
referenced-optional-peer rule is disabled; other dependency checks remain enabled.
