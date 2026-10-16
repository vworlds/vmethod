# Consumer templates

Review these examples with the owner before installing them in a consumer.

| Template                                       | Consumer destination                                             | Installed by                     |
| ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| [AGENTS.md](AGENTS.md)                         | Root agent routing entry point                                   | Consumer adoption PR             |
| [vmethod.yaml](vmethod.yaml)                   | Root project config                                              | `init` if absent                 |
| [people.yaml](people.yaml)                     | Root identity allowlist                                          | `init` if absent, owner verifies |
| [models.yaml](models.yaml)                     | Root model registry                                              | `init` if absent                 |
| [task-pr.md](task-pr.md)                       | Draft task PR description                                        | Orchestrator fills placeholders  |
| [.claude/settings.json](.claude/settings.json) | `.claude/settings.json`                                          | Owner only                       |
| [claude-settings.json](claude-settings.json)   | Same Claude settings; compatibility filename used by current CLI | Owner only                       |
| [opencode.json](opencode.json)                 | `opencode.json`                                                  | Owner only                       |

The Claude files contain identical settings; keep them synchronized. Permission
templates are data shipped by the package, not permission changes for the agent
preparing an adoption PR. `init` deliberately does not install them or the routing
file. Merge with existing settings without removing unrelated protections.

Replace every example identity, id, path and recipe. Do not grant a sample account
authority, run a placeholder model, or treat these examples as secrets. Add consumer
domain and engineering routes to AGENTS.md; its package links resolve **after**
installation in the consumer, not in this template directory.

## Permission boundary

Both backends prompt for unlisted shell operations and permit the local pinned CLI
and reviewed compatibility stubs. Claude deny entries take precedence; OpenCode V2
uses ordered rules with the last matching rule winning, so denies follow allows.
The OpenCode shape follows its [V2 permissions reference](https://opencode.ai/v2/docs/permissions).
Do not substitute the deprecated singular V1 `permission` / `bash` object.

Direct `gh`, `npx`, HTTP clients targeting GitHub and `git push` are denied. The
intended push route is the reviewed `push` verb (vmethod 1.0, #1), not a direct push
exception. Generic invocation/stub allows cover future verbs but do not implement
them. Prompted commands are not permission to bypass the gateway.

These are command-policy templates, **not a network sandbox**. The owner must
review effective global, project and agent overrides, writable scripts, alternate
HTTP clients, interpreters, MCP tools and saved approvals. Protect installed
permission files and gateway stubs from worker edits. A mutable shell wrapper or
alternate transport must not become an unreviewed API escape hatch. Test both a
denied raw call and an allowed gateway call in the actual backend during adoption;
schema validity alone cannot prove effective permissions.
