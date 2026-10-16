# Package commands

Node 24 or newer is required. Pin `@vworlds/vmethod` exactly as a devDependency.
Run `npm ci` in every worktree, then `npm exec --no -- vmethod <verb>`; never use a downloading `npx` fallback.

- `version`: published package version, bundled board version and running Node version.
- `config get <dotted.key>`: YAML 1.2 config after validated environment overrides.
- `check`: offline config, people, models, Mermaid pin, permissions and secret checks. Exit 0 means OK, 1 findings, 2 missing dependency (takes precedence). No GitHub identity resolution is attempted offline; numeric ids must already be owner-approved.
- `init [--dry-run]`: write absent config files and registered compatibility stubs. Only stubs with an exact `# vmethod stub` line can be updated. Config files are never overwritten. With git absent, stubs require `VMETHOD_ROOT`. Permission installation remains the owner's responsibility: copy `templates/claude-settings.json` to `.claude/settings.json`.

Template identities and model ids are examples, not real credentials or an authoritative allowlist.
Configure real values before adoption. Mermaid is optional at install time but `check` requires exactly 12.1.0. jsdom is reserved for future diagram checks.

## Environment mapping

`board.number` maps to `VMETHOD_BOARD_NUMBER`, `baseBranch` to `VMETHOD_BASE_BRANCH`, etc.
Strings remain strings; integer, boolean and array overrides are parsed as YAML 1.2 then validated.
Only `VMETHOD_*` variables are read. `VECS_*`, `SPACEROCKS_*` and bare `BASE` are ignored without warnings.
Consumers rename their project-prefixed variables on adoption.

Supported `VMETHOD_` switches:

| Suffix        | Config key    | Meaning                                       |
| ------------- | ------------- | --------------------------------------------- |
| BOARD         | board.enabled | `off` disables board steps, `on` enables them |
| TRACK         | track         | Track name                                    |
| BASE          | baseBranch    | Active base branch                            |
| OWNER         | board.owner   | Board owner                                   |
| BOARD_PROJECT | board.number  | Numeric board project                         |

There are no board-writing verbs in this skeleton. Future board verbs must honour `board.enabled: false`.
If both spellings are set, the dotted-key mapping (e.g. `VMETHOD_BOARD_NUMBER`) wins over the switch (`VMETHOD_BOARD_PROJECT`).

`models.tsv` conversion accepts a tab-separated header with `family`, `model` (`provider/id`), `kind` and `gate` (`none` or `owner`). It validates before writing, preserves the TSV, and never converts again once `models.yaml` exists.

## Development and releases

Run format:check, lint, typecheck, test, build, knip and smoke. Tests and smoke use `.tmp/`, run offline and have explicit timeouts. The tarball consumer uses a labelled metadata-only Mermaid fixture which throws on any renderer call. Only Node is on PATH during CLI smoke checks.

Every PR adds `changes/unreleased/<number>.md` with `kind: breaking`, `feature` or `fix`, a blank line and a description. The next release PR collects previously released fragments into `CHANGELOG.md` and removes them from `unreleased`.

The repository version stays `0.0.0-dev`. Publishing reads npm's latest stable version and unreleased fragments: breaking → major, feature → minor, otherwise patch. A master push publishes to latest; manual dispatch **on dev only** publishes the next `X.Y.Z-rc.N` to next. Both use npm OIDC trusted publishing with provenance, then tag the source commit. There is no bump commit, npm token or tag overwrite. The owner must configure the npm trusted publisher for this repository and `publish.yml` first. Source maps embed the editable schema and baseline sources; tests verify they match byte-for-byte.
