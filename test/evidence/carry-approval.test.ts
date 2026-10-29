import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "../helpers.js";
import { approvalCarryFiles } from "../../src/evidence/carry-approval.js";

const exec = promisify(execFile);

test("real git conflict resolutions, either parent order, and multiple base merges carry approval, not task edits", async () => {
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
    await git("add", "conflict.txt");
    await git("commit", "-m", "test");
    return (await git("rev-parse", "HEAD")).trim();
  };
  await git("init", "-b", "dev");
  await commit("initial\n");
  await git("checkout", "-b", "task");
  const approved = await commit("task\n");
  await git("checkout", "dev");
  let base = await commit("base\n");
  await git("checkout", "task");
  await expect(git("merge", "--no-edit", "dev")).rejects.toThrow();
  const head = await commit("task with base\n");
  expect(await approvalCarryFiles(git, approved, head, base)).toEqual(["conflict.txt"]);
  const tree = (await git("rev-parse", `${head}^{tree}`)).trim();
  const reversed = (
    await git("commit-tree", tree, "-p", base, "-p", approved, "-m", "reversed")
  ).trim();
  expect(await approvalCarryFiles(git, approved, reversed, base)).toEqual(["conflict.txt"]);
  await git("checkout", "dev");
  writeFileSync(join(root, "base.txt"), "more base\n");
  await git("add", "base.txt");
  await git("commit", "-m", "base advance");
  base = (await git("rev-parse", "HEAD")).trim();
  await git("checkout", "task");
  await git("merge", "--no-edit", "dev");
  const second = (await git("rev-parse", "HEAD")).trim();
  expect(await approvalCarryFiles(git, approved, second, base)).toEqual(["conflict.txt"]);
  const edit = await commit("new task behaviour\n");
  expect(await approvalCarryFiles(git, approved, edit, base)).toBeNull();
  expect(await approvalCarryFiles(git, head, head, base)).toBeNull();
  expect(await approvalCarryFiles(git, "bad", head, base)).toBeNull();
}, 15000);

test.each([
  "ordinary commit",
  "non-base parent",
  "unrelated approval",
  "extra parent",
  "diff failure",
])("carry proof fails closed: %s", async (scenario) => {
  const approved = "a".repeat(40),
    head = "b".repeat(40),
    base = "c".repeat(40),
    other = "d".repeat(40);
  const unexpected: string[] = [];
  const git = async (...args: string[]) => {
    if (args[0] === "rev-list") {
      return scenario === "ordinary commit"
        ? `${head} ${approved}`
        : scenario === "extra parent"
          ? `${head} ${approved} ${base} ${other}`
          : scenario === "unrelated approval"
            ? `${head} ${other} ${base}`
            : `${head} ${approved} ${other}`;
    }
    if (args.join(" ") === `merge-base --is-ancestor ${other} ${base}`) {
      if (scenario === "non-base parent") {
        throw new Error("not on base");
      }
      return "";
    }
    if (
      args.join(" ") === `show --remerge-diff --format= --name-only -z ${head}` &&
      scenario === "diff failure"
    ) {
      throw new Error("cannot read diff");
    }
    unexpected.push(args.join(" "));
    throw new Error("Unexpected git request");
  };
  expect(await approvalCarryFiles(git, approved, head, base)).toBeNull();
  expect(unexpected).toEqual([]);
});
