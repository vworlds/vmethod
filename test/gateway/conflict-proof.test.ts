import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "../helpers.js";
import { conflictHunksOnly, proveConflictMerge } from "../../src/gateway/conflict-proof.js";

const exec = promisify(execFile);

test("real remerge diff admits conflict hunks, refuses same-file and other-file edits", async () => {
  const root = fixture();
  const git = async (...args: string[]) =>
    (
      await exec("git", args, {
        cwd: root,
        timeout: 5000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      })
    ).stdout;
  const commit = async (text: string) => {
    writeFileSync(join(root, "conflict.txt"), text);
    await git("add", ".");
    await git("commit", "-qm", "test");
    return (await git("rev-parse", "HEAD")).trim();
  };
  await git("init", "-b", "dev");
  await commit("unchanged prefix\ninitial\nunchanged suffix\n");
  await git("checkout", "-b", "task");
  const task = await commit("unchanged prefix\ntask\nunchanged suffix\n");
  await git("checkout", "dev");
  const base = await commit("unchanged prefix\nbase\nunchanged suffix\n");
  await git("checkout", "task");
  await expect(git("merge", "--no-edit", "dev")).rejects.toThrow();
  const head = await commit("unchanged prefix\ntask\nbase\nunchanged suffix\n");
  expect(await proveConflictMerge(git, head, task, base, ["conflict.txt"])).toBe(true);
  expect(await proveConflictMerge(git, head, base, task, ["conflict.txt"])).toBe(false);
  // Construct alternative merge trees, preserving the exact original two parents.
  for (const outside of ["same file", "other file"]) {
    writeFileSync(
      join(root, "conflict.txt"),
      outside === "same file"
        ? "changed prefix\ntask\nbase\nunchanged suffix\n"
        : "unchanged prefix\ntask\nbase\nunchanged suffix\n"
    );
    if (outside === "other file") {
      writeFileSync(join(root, "unrelated.txt"), "not a conflict\n");
    }
    await git("add", ".");
    const tree = (await git("write-tree")).trim();
    const bad = (
      await git("commit-tree", tree, "-p", task, "-p", base, "-m", "bad resolution")
    ).trim();
    expect(await proveConflictMerge(git, bad, task, base, ["conflict.txt"])).toBe(false);
  }
}, 15000);

test.each(["", "Binary files a/x and b/x differ", "old mode 100644\nnew mode 100755"])(
  "unknown or nontextual remerge evidence fails closed: %s",
  (patch) => {
    expect(conflictHunksOnly(patch)).toBe(false);
  }
);
