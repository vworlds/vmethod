# Package commands

Node 24 or newer is required. Pin `@vworlds/vmethod` exactly as a devDependency.
Run `npm ci` in every worktree, then `npm exec --no -- vmethod <verb>`; never use a downloading `npx` fallback.

- `version`: published package version, bundled board version and running Node version.
- `config get <dotted.key>`: YAML 1.2 config after validated environment overrides.
- `check`: offline config, people, models, Mermaid pin, permissions and secret checks. Exit 0 means OK, 1 findings, 2 missing dependency (takes precedence). No GitHub identity resolution is attempted offline; numeric ids must already be owner-approved.
- `init [--dry-run]`: write absent config files and registered compatibility stubs. Only stubs with an exact `# vmethod stub` line can be updated. Config files are never overwritten. Stubs use `VMETHOD_ROOT` first, then git repository discovery; set `VMETHOD_ROOT` for copied build contexts without `.git`. Permission installation remains the owner's responsibility: copy `templates/claude-settings.json` to `.claude/settings.json`.

Every verb except `version` resolves the project root once per run exactly as the stubs do: `VMETHOD_ROOT` first, then `git rev-parse --show-toplevel` from the current directory. The cwd is never the root, so commands work from any subdirectory of a checkout.

Template identities and model ids are examples, not real credentials or an authoritative allowlist.
Configure real values before adoption. Mermaid is optional at install time but `check` requires exactly 12.1.0. Diagram validation also uses the installed jsdom peer (24 or newer).
The permission template denies raw `git push` and allows the `push` compatibility stub and local CLI. See [worker commands](gateway.md#worker-commands) for the six worker verbs, their arguments and branch policy.

## Environment mapping

`board.number` maps to `VMETHOD_BOARD_NUMBER`, `baseBranch` to `VMETHOD_BASE_BRANCH`, etc.
Strings remain strings; integer, boolean and array overrides are parsed as YAML 1.2 then validated.
Only `VMETHOD_*` variables are read. `VECS_*`, `SPACEROCKS_*` and bare `BASE` are ignored without warnings.
Consumers rename their project-prefixed variables on adoption.

Supported `VMETHOD_` switches:

| Suffix | Config key    | Meaning                                       |
| ------ | ------------- | --------------------------------------------- |
| BOARD  | board.enabled | `off` disables board steps, `on` enables them |
| TRACK  | track         | Track name                                    |
| BASE   | baseBranch    | Active base branch                            |

There are no board-writing verbs in this skeleton. Future board verbs must honour `board.enabled: false`.
`VMETHOD_OWNER` and `VMETHOD_BOARD_PROJECT` are ignored. Owner authority comes only from numeric ids and roles in `people.yaml`, never from environment variables. Select the board with `VMETHOD_BOARD_OWNER` (the org) and `VMETHOD_BOARD_NUMBER` (the number), not an owner login or project node id.

`models.tsv` conversion accepts a plain or `#`-commented tab-separated header with `family`, `provider/id` (or `model`), `kind` and `gate`. TSV gate `-` becomes YAML `none`; `none` and `owner` are preserved. `kind: opencode` requires `provider/id`; `kind: claude` requires a bare model id. Other comment lines are ignored. It validates before writing, preserves the TSV, and never converts again once `models.yaml` exists.

## Development and releases

Run format:check, lint, typecheck, test, build, smoke and knip. Tests and smoke create consumer projects under `os.tmpdir()`, outside the repo, so they cannot inherit its dependencies or config. They run offline and have explicit timeouts. Real Mermaid Markdown checks cover jsdom majors 24 and 27; the packed-tarball consumer installs jsdom 24 with peer validation enabled. Run `npm ci` first to populate npm's cache for the offline smoke install. Only Node is on PATH during CLI smoke checks.

CI also runs `vmethod check` against this repo's config, allowing only the missing owner-installed `.claude/settings.json` finding. It skips cleanly if `vmethod.yaml` is absent.

Every PR adds `changes/unreleased/<number>.md` with `kind: breaking`, `feature` or `fix`, a blank line and a description. The next release PR collects previously released fragments into `CHANGELOG.md` and removes them from `unreleased`.

The repository version stays `0.0.0-dev`. Publishing reads npm's latest stable version and only fragments added since its `vX.Y.Z` tag: breaking → major, feature → minor, otherwise patch. Before the first tag, all fragments are considered; no new fragments means "nothing to release". A master push publishes to latest; manual dispatch **on dev only** publishes the next `X.Y.Z-rc.N` to next. Both use npm OIDC trusted publishing with provenance, then tag the source commit. There is no bump commit, npm token or tag overwrite. The owner must configure the npm trusted publisher for this repository and `publish.yml` first. Source maps embed the editable schema and baseline sources; tests verify they match byte-for-byte.
