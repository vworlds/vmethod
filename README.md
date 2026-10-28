# Adopting vmethod in a repository

If you are an agent asked to adopt `vworlds/vmethod` via npm, start here.
Use Node ≥24 and install the current release candidate as an exactly pinned devDependency:

```sh
npm install --save-dev --save-exact @vworlds/vmethod@next
```

`next` selects the release candidate; `--save-exact` records its resolved version,
not a moving tag or range. Commit `package.json` and the lockfile with adoption.
If the owner specifies a version, use that exact version instead.

Read `node_modules/@vworlds/vmethod/docs/adoption.md` and follow it in order.
Use that installed guide, not the repository's default branch: it matches your pin.
Its interview explains what you can discover and what you must ask the owner;
collect the owner-only setup into one handoff before continuing.
Never run `gh` yourself or install/change your own permissions. Before bootstrap
authentication exists, ask the owner for verified identities rather than bypassing it.

## About vmethod

VWorlds' shared development methodology is distributed as `@vworlds/vmethod` (MIT).
The package includes the [methodology guides](docs/README.md),
[package commands](docs/package.md) and [consumer templates](templates/README.md).

To develop vmethod itself, run `npm ci` and `npm run build`.
See the [architecture](docs/architecture.md) for its design.
