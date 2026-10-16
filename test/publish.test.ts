import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "./helpers.js";

function publish({
  authFailure = false,
  candidate = false,
  previousRelease = false,
  added = ["changes/unreleased/14.md"],
  refStatus = previousRelease ? 0 : 1,
}: {
  authFailure?: boolean;
  candidate?: boolean;
  previousRelease?: boolean;
  added?: string[];
  refStatus?: number;
} = {}) {
  const root = fixture();
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "changes/unreleased"), { recursive: true });
  copyFileSync("package.json", join(root, "package.json"));
  writeFileSync(
    join(root, "changes/unreleased/14.md"),
    `kind: ${previousRelease ? "fix" : "feature"}\n\nPackage skeleton\n`
  );
  if (previousRelease) {
    writeFileSync(
      join(root, "changes/unreleased/1.md"),
      "kind: breaking\n\nAlready released breaking change\n"
    );
  }
  const latest = previousRelease ? "1.2.3" : "0.0.0";
  const next = previousRelease ? "1.2.4" : candidate ? "0.1.0-rc.2" : "0.1.0";
  const calls = join(root, "calls.jsonl");
  // Only this finite set of exact calls can succeed. Everything else throws.
  const expectations = {
    npm: {
      '["view","@vworlds/vmethod","--json"]': {
        output: JSON.stringify({
          "dist-tags": { latest },
          versions: ["0.1.0-rc.1"],
        }),
      },
      '["run","build"]': { output: "" },
      [JSON.stringify([
        "publish",
        "--provenance",
        "--access",
        "public",
        "--tag",
        candidate ? "next" : "latest",
      ])]: authFailure ? { error: "ENEEDAUTH trusted publishing unavailable" } : { output: "" },
    },
    git: {
      [JSON.stringify(["show-ref", "--verify", "--quiet", `refs/tags/v${latest}`])]: {
        status: refStatus,
      },
      [JSON.stringify([
        "diff",
        "--name-only",
        "--diff-filter=A",
        `v${latest}..HEAD`,
        "--",
        "changes/unreleased",
      ])]: { output: added.join("\n") },
      [JSON.stringify(["tag", `v${next}`])]: {
        output: "",
      },
      [JSON.stringify(["push", "origin", `refs/tags/v${next}`])]: {
        output: "",
      },
    },
  };
  for (const [tool, expected] of Object.entries(expectations)) {
    const file = join(bin, tool);
    writeFileSync(
      file,
      `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(tool)}, ...args]) + '\\n');\nconst expected = ${JSON.stringify(expected)};\nconst result = expected[JSON.stringify(args)];\nif (!result) { console.error('Unexpected ${tool} call: ' + JSON.stringify(args)); process.exit(99); }\nif (result.error) { console.error(result.error); process.exit(1); }\nif (result.status !== undefined) process.exit(result.status);\nconsole.log(result.output);\n`
    );
    chmodSync(file, 0o755);
  }
  const result = spawnSync(process.execPath, [resolve("scripts/publish.mjs")], {
    cwd: root,
    env: {
      PATH: bin,
      GITHUB_EVENT_NAME: candidate ? "workflow_dispatch" : "push",
      GITHUB_REF: candidate ? "refs/heads/dev" : "refs/heads/master",
    },
    encoding: "utf8",
    timeout: 10000,
  });
  return {
    result,
    pkg: JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    calls: readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}

test.each([false, true])(
  "publishes workspace-only version with provenance then immutable tag (RC=%s)",
  (candidate) => {
    const { result, pkg, calls } = publish({ candidate });
    expect(result.status, result.stderr).toBe(0);
    expect(pkg.version).toBe(candidate ? "0.1.0-rc.2" : "0.1.0");
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["npm", "view"],
      ["git", "show-ref"],
      ["npm", "run"],
      ["npm", "publish"],
      ["git", "tag"],
      ["git", "push"],
    ]);
    expect(JSON.parse(readFileSync("package.json", "utf8")).version).toBe("0.0.0-dev");
  },
  15000
);

test("missing trusted publisher fails clearly without creating or pushing a tag", () => {
  const { result, calls } = publish({ authFailure: true });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("trusted publisher not configured");
  expect(calls.filter((call) => call[0] === "git")).toEqual([
    ["git", "show-ref", "--verify", "--quiet", "refs/tags/v0.0.0"],
  ]);
}, 15000);

test("a previously tagged breaking fragment is excluded; a newly added fix produces a patch", () => {
  const { result, pkg, calls } = publish({ previousRelease: true });
  expect(result.status, result.stderr).toBe(0);
  expect(pkg.version).toBe("1.2.4");
  expect(calls).toContainEqual([
    "git",
    "diff",
    "--name-only",
    "--diff-filter=A",
    "v1.2.3..HEAD",
    "--",
    "changes/unreleased",
  ]);
  expect(calls.at(-1)).toEqual(["git", "push", "origin", "refs/tags/v1.2.4"]);
}, 15000);

test("no fragments added after the previous tag means nothing to release", () => {
  const { result, pkg, calls } = publish({ previousRelease: true, added: [] });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("nothing to release");
  expect(pkg.version).toBe("0.0.0-dev");
  expect(calls.map((call) => call.slice(0, 2))).toEqual([
    ["npm", "view"],
    ["git", "show-ref"],
    ["git", "diff"],
  ]);
}, 15000);

test("git ref lookup errors do not silently release every fragment", () => {
  const { result, pkg, calls } = publish({
    previousRelease: true,
    refStatus: 128,
  });
  expect(result.status).not.toBe(0);
  expect(pkg.version).toBe("0.0.0-dev");
  expect(calls.map((call) => call.slice(0, 2))).toEqual([
    ["npm", "view"],
    ["git", "show-ref"],
  ]);
}, 15000);

test("manual publication outside dev fails before any external call", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/publish.mjs")], {
    cwd: fixture(),
    env: {
      PATH: "",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/master",
    },
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Publishing requires refs/heads/dev");
}, 15000);
