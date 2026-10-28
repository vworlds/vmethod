import { expect, test } from "vitest";
import { runChild } from "./child-process.js";
import { readFileSync } from "node:fs";

function scenario(options: Record<string, boolean> = {}) {
  const result = runChild(
    process.execPath,
    ["test/fixtures/publish.mjs", JSON.stringify(options)],
    {
      encoding: "utf8",
      timeout: 30000,
    }
  );
  expect(result.status, result.stderr).toBe(0);
  return { ...JSON.parse(result.stdout.trim().split("\n").at(-1)!), stderr: result.stderr };
}

test("publishes only added fragments since the previous RC, grouped and PR-linked, offline too", () => {
  const result = scenario();
  expect(result.errors).toEqual([]);
  expect(result.notes).toBe(`# v2.0.0-rc.1

## Breaking

### [#40](https://github.com/vworlds/vmethod/pull/40)

Migration steps

- Keep this list
- And this item

## Features

### [#50](https://github.com/vworlds/vmethod/pull/50)

New feature

## Fixes

### [#30](https://github.com/vworlds/vmethod/pull/30)

New fix
`);
  expect(result.pack).toContain("RELEASE-NOTES.md");
  expect(result.packedNotes).toBe(result.notes);
  expect(result.offlineNotes).toBe(result.notes);
  const creation = result.calls.find((call: string[]) => call[0] === "gh" && call[1] === "release");
  expect(creation).toContain("--prerelease");
  expect(creation.slice(creation.indexOf("--notes-file"), -1)).toEqual([
    "--notes-file",
    "RELEASE-NOTES.md",
  ]);
}, 40000);

test.each([false, true])(
  "failed release is named and retries skip npm, build and tags (stable=%s)",
  (stable) => {
    const result = scenario({ fail: true, retry: true, stable });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`GitHub release failed for 2.0.0${stable ? "" : "-rc.1"}`);
    expect(result.release).toBe(true);
    expect(
      result.retryCalls
        .filter((call: string[]) => call[0] === "npm")
        .every((call: string[]) => call[1] === "view")
    ).toBe(true);
    expect(
      result.retryCalls.some(
        (call: string[]) =>
          call[0] === "git" && (call[1] === "push" || (call[1] === "tag" && call[2] !== "--merged"))
      )
    ).toBe(false);
    expect(
      result.retryCalls.filter((call: string[]) => call[0] === "gh" && call[1] === "release")
    ).toHaveLength(1);
    expect(result.offlineNotes).toBe(result.notes);
  },
  40000
);

test("an already completed retry creates nothing", () => {
  const result = scenario({ retry: true });
  expect(result.errors).toEqual([]);
  expect(
    result.retryCalls.filter((call: string[]) => call[0] === "gh" && call[1] === "release")
  ).toEqual([]);
}, 40000);

test("publication followed by tag push failure is repaired without publishing or tagging twice", () => {
  const result = scenario({ fail: true, tagFailure: true, retry: true });
  expect(result.errors).toEqual(["tag push failed"]);
  expect(result.release).toBe(true);
  expect(
    result.calls.filter((call: string[]) => call[0] === "npm" && call[1] === "publish")
  ).toHaveLength(1);
  expect(
    result.calls.filter((call: string[]) => call[0] === "git" && call[1] === "push")
  ).toHaveLength(1);
  const creation = result.retryCalls.find(
    (call: string[]) => call[0] === "gh" && call[1] === "release"
  );
  expect(creation).toContain("--target");
  expect(result.offlineNotes).toBe(result.notes);
}, 40000);

test("first publication includes all fragments and stable releases are not prereleases", () => {
  const result = scenario({ first: true, stable: true });
  expect(result.errors).toEqual([]);
  expect(result.notes).toContain("Previous RC feature");
  expect(result.notes).toContain("Edited old fragment");
  expect(
    result.calls.find((call: string[]) => call[0] === "gh" && call[1] === "release")
  ).not.toContain("--prerelease");
}, 40000);

test.each(["registryFailure", "wrongRef", "releaseLookupFailure"])(
  "%s fails visibly rather than treating unknown state as absence",
  (option) => {
    const result = scenario({ [option]: true });
    expect(result.errors).toHaveLength(1);
    expect(result.release).toBe(false);
    expect(
      result.calls.filter((call: string[]) => call[0] === "gh" && call[1] === "release")
    ).toEqual([]);
  },
  40000
);

test.each([false, true])(
  "workspace-only version, provenance and immutable tag are preserved (RC=%s)",
  (candidate) => {
    const result = scenario({ stable: !candidate });
    expect(result.packageVersion).toBe(candidate ? "2.0.0-rc.1" : "2.0.0");
    expect(JSON.parse(readFileSync("package.json", "utf8")).version).toBe("0.0.0-dev");
    const writes = result.calls.filter(
      (call: string[]) =>
        (call[0] === "npm" && ["run", "publish"].includes(call[1])) ||
        (call[0] === "git" && (call[1] === "push" || (call[1] === "tag" && call[2] !== "--merged")))
    );
    expect(writes).toEqual([
      ["npm", "run", "build"],
      [
        "npm",
        "publish",
        "--provenance",
        "--access",
        "public",
        "--tag",
        candidate ? "next" : "latest",
      ],
      ["git", "tag", `v${result.packageVersion}`],
      ["git", "push", "origin", `refs/tags/v${result.packageVersion}`],
    ]);
  },
  40000
);

test("missing trusted publisher fails clearly without creating or pushing a tag", () => {
  const result = scenario({ authFailure: true });
  expect(result.stderr).toContain("trusted publisher not configured");
  expect(result.errors[0]).toContain("ENEEDAUTH trusted publishing unavailable");
  expect(
    result.calls.filter(
      (call: string[]) =>
        call[0] === "git" && (call[1] === "push" || (call[1] === "tag" && call[2] !== "--merged"))
    )
  ).toEqual([]);
  expect(result.release).toBe(false);
}, 40000);

test("already released breaking fragments do not change a new fix's patch bump", () => {
  const result = scenario({ onlyFix: true, stable: true });
  expect(result.errors).toEqual([]);
  expect(result.packageVersion).toBe("1.2.4");
  expect(result.notes).toContain("New fix");
  expect(result.notes).not.toContain("Edited old fragment");
}, 40000);

test.each(["noAdded", "tagLookupFailure"])(
  "%s fails without publication or workspace version change",
  (option) => {
    const result = scenario({ [option]: true });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      option === "noAdded" ? "nothing to release" : "git tag lookup failed"
    );
    expect(result.packageVersion).toBe("0.0.0-dev");
    expect(
      result.calls.filter(
        (call: string[]) => call[0] === "npm" && ["run", "publish"].includes(call[1])
      )
    ).toEqual([]);
  },
  40000
);

test("manual publication outside dev fails before any external call", () => {
  const cli = runChild(process.execPath, ["scripts/publish.mjs"], {
    env: { PATH: "", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master" },
    encoding: "utf8",
    timeout: 1000,
  });
  expect(cli.status).toBe(1);
  expect(cli.stderr).toContain("Publishing requires refs/heads/dev");
  const result = scenario({ wrongRef: true });
  expect(result.errors).toEqual(["Publishing requires refs/heads/dev"]);
  expect(result.calls).toEqual([]);
}, 40000);
