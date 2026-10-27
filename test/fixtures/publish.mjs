import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publish } from "../../scripts/publish.mjs";

const options = JSON.parse(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "vmethod-publish-"));
const original = process.cwd();
const calls = [];
let published = false;
let release = false;
let fail = options.fail;
let notes;
const errors = [];
try {
  process.chdir(root);
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 10000 }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  mkdirSync("changes/unreleased", { recursive: true });
  // Use the actual package allowlist, not a fixture that assumes notes are shipped.
  const pkg = JSON.parse(readFileSync(join(original, "package.json"), "utf8"));
  writeFileSync("package.json", JSON.stringify(pkg));
  const fragment = (number, kind, body) =>
    writeFileSync(`changes/unreleased/${number}.md`, `kind: ${kind}\n\n${body}\n`);
  const commit = () => {
    git("add", ".");
    git("commit", "--quiet", "-m", "test");
  };
  fragment(10, options.onlyFix ? "breaking" : "fix", "Old stable fix");
  commit();
  if (!options.first) {
    git("tag", "v1.2.3");
  }
  fragment(20, "feature", "Previous RC feature");
  commit();
  if (!options.first) {
    git("tag", "v1.3.0-rc.1");
  }
  if (options.onlyFix || options.noAdded) {
    git("tag", "--force", "v1.2.3");
  }
  const previous = git("rev-parse", "HEAD");
  fragment(10, options.onlyFix ? "breaking" : "fix", "Edited old fragment");
  if (!options.noAdded) {
    fragment(30, "fix", "New fix");
    if (!options.onlyFix) {
      fragment(40, "breaking", "Migration steps\n\n- Keep this list\n- And this item");
      fragment(50, "feature", "New feature");
    }
  }
  commit();
  const head = git("rev-parse", "HEAD");
  process.env.GITHUB_EVENT_NAME = options.stable ? "push" : "workflow_dispatch";
  process.env.GITHUB_REF = options.wrongRef
    ? "refs/heads/other"
    : options.stable
      ? "refs/heads/master"
      : "refs/heads/dev";
  const version = `${options.onlyFix ? "1.2.4" : "2.0.0"}${options.stable ? "" : "-rc.1"}`;
  const run = (bin, args, settings) => {
    calls.push([bin, ...args]);
    if (bin === "git" && args[0] === "push") {
      if (fail && options.tagFailure) {
        fail = false;
        throw new Error("tag push failed");
      }
      return "";
    }
    if (bin === "git") {
      if (options.tagLookupFailure && args[0] === "tag" && args[1] === "--merged") {
        throw new Error("git tag lookup failed");
      }
      return execFileSync(bin, args, settings);
    }
    if (bin === "npm" && args[0] === "view") {
      if (options.registryFailure) {
        throw Object.assign(new Error("offline"), { stderr: "E503" });
      }
      if (options.first && !published) {
        throw Object.assign(new Error("not found"), { stderr: "E404" });
      }
      // Recorded npm CLI projections, 2026-10-27:
      // npm view @vworlds/vmethod --json (versions/dist-tags only), and
      // npm view '@vworlds/vmethod@1.0.0-rc.9 || 1.0.0-rc.10' version gitHead --json.
      // The single-version form returns an object rather than an array.
      // Version numbers and commit IDs below are replaced by this git fixture.
      return JSON.stringify(
        args[1] !== pkg.name
          ? (() => {
              const entries = args[1]
                .slice(pkg.name.length + 1)
                .split(" || ")
                .map((entryVersion) => ({
                  version: entryVersion,
                  gitHead: published && entryVersion === version ? head : previous,
                }));
              return entries.length === 1 ? entries[0] : entries;
            })()
          : {
              versions: ["1.2.3", "1.3.0-rc.1", ...(published ? [version] : [])],
              "dist-tags": { latest: options.stable && published ? version : "1.2.3" },
            }
      );
    }
    if (bin === "npm" && args.join(" ") === "run build") {
      return "";
    }
    if (bin === "npm" && args[0] === "publish") {
      if (options.authFailure) {
        throw Object.assign(new Error("authentication failed"), {
          stderr: "ENEEDAUTH trusted publishing unavailable",
        });
      }
      if (published) {
        throw new Error("Published twice");
      }
      published = true;
      notes = readFileSync("RELEASE-NOTES.md", "utf8");
      return "";
    }
    if (bin === "gh" && args[0] === "api") {
      if (options.releaseLookupFailure) {
        throw new Error("Release listing unavailable");
      }
      return JSON.stringify([release ? [{ tag_name: `v${version}` }] : []]);
    }
    if (bin === "gh" && args[0] === "release" && args[1] === "create") {
      if (fail) {
        fail = false;
        throw Object.assign(new Error("denied"), { stderr: "denied" });
      }
      release = true;
      return "";
    }
    throw new Error(`Unexpected command: ${bin} ${args.join(" ")}`);
  };
  const attempt = () => {
    try {
      publish(run);
    } catch (error) {
      errors.push(error.message);
    }
  };
  attempt();
  const firstCalls = calls.length;
  if (options.retry) {
    attempt();
  }
  const pack = published
    ? JSON.parse(
        execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
          encoding: "utf8",
          timeout: 20000,
        })
      )[0]
    : null;
  console.log(
    JSON.stringify({
      calls,
      retryCalls: calls.slice(firstCalls),
      errors,
      notes,
      offlineNotes: published ? readFileSync("RELEASE-NOTES.md", "utf8") : null,
      pack: pack?.files.map((file) => file.path) ?? [],
      packedNotes: pack?.files.some((file) => file.path === "RELEASE-NOTES.md")
        ? execFileSync("tar", ["-xOf", pack.filename, "package/RELEASE-NOTES.md"], {
            encoding: "utf8",
            timeout: 10000,
          })
        : null,
      release,
      packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
    })
  );
} finally {
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
}
