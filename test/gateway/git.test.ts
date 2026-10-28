import { expect, test, vi } from "vitest";
import { GitTransport, pushFailureMessage } from "../../src/gateway/git.js";
import type { Dependencies } from "../../src/gateway/client.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, ghConfig } from "../helpers.js";
import { runChildAsync } from "../child-process.js";

/** A transport whose repo is known, logging in as the fixture gh login. */
const transport = (exec: Dependencies["exec"]) =>
  new GitTransport(
    { repo: "example/project" },
    { GH_CONFIG_DIR: ghConfig("fake-token") },
    {
      exec,
      report: () => {},
      sleep: async () => {},
    } as unknown as Dependencies,
    "/work"
  );

/** The error shape a real execFile rejection carries; a fake may fill either stream. */
const execError = (stderr?: string, stdout?: string) => {
  const error = new Error("secret: fake-token / untrusted remote stderr") as Error & {
    stderr?: string;
    stdout?: string;
  };
  error.stderr = stderr;
  error.stdout = stdout;
  return error;
};

test("real commit-tree uses wrapper identity even with a conflicting global config", async () => {
  const root = fixture();
  const global = join(root, "global.gitconfig");
  writeFileSync(global, "[user]\nname = Wrong\nemail = wrong@example.com\n");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: global,
    GIT_AUTHOR_NAME: "Author",
    GIT_AUTHOR_EMAIL: "a@example.com",
    GIT_COMMITTER_NAME: "Committer",
    GIT_COMMITTER_EMAIL: "c@example.com",
  };
  const exec: Dependencies["exec"] = async (file, args, options) =>
    (await runChildAsync(file, [...args], { ...options, encoding: "utf8", timeout: 5000 })).stdout;
  const git = new GitTransport({}, env, { exec } as Dependencies, root);
  await git.run("init", "-q");
  const tree = (await git.run("write-tree")).trim();
  const commit = (await git.run("commit-tree", tree, "-m", "test identity")).trim();
  expect((await git.run("show", "-s", "--format=%an <%ae>|%cn <%ce>", commit)).trim()).toBe(
    "Author <a@example.com>|Committer <c@example.com>"
  );
  const missing = new GitTransport(
    {},
    { PATH: env.PATH, HOME: root },
    { exec } as Dependencies,
    root
  );
  await expect(missing.run("commit-tree", tree, "-m", "missing")).rejects.toThrow(
    "set GIT_AUTHOR_NAME/EMAIL"
  );
});

test("commit-tree receives explicit wrapper identities, never global config or secrets", async () => {
  const identity = {
    GIT_AUTHOR_NAME: "Worker",
    GIT_AUTHOR_EMAIL: "worker@example.com",
    GIT_COMMITTER_NAME: "Bot",
    GIT_COMMITTER_EMAIL: "bot@example.com",
  };
  const exec = vi.fn(async () => "commit");
  const git = new GitTransport(
    {},
    { ...identity, SECRET: "hidden" },
    { exec } as unknown as Dependencies,
    "/work"
  );
  await git.run("commit-tree", "tree");
  expect(exec).toHaveBeenCalledWith("git", ["commit-tree", "tree"], {
    cwd: "/work",
    env: {
      ...identity,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
});

test.each([
  {},
  { GIT_AUTHOR_NAME: "Only name" },
  { GIT_AUTHOR_NAME: "Author", GIT_AUTHOR_EMAIL: "a@b" },
])("commit-tree requires all explicit identities: %j", async (env) => {
  const exec = vi.fn(async () => "");
  const git = new GitTransport({}, env, { exec } as unknown as Dependencies, "/work");
  await expect(git.run("commit-tree", "tree")).rejects.toThrow(
    "set GIT_AUTHOR_NAME/EMAIL in the orchestrator environment"
  );
  expect(exec).not.toHaveBeenCalled();
});

test("transfer reports a successful transfer as ok (fetch and push)", async () => {
  const exec = vi.fn(async () => "");
  const git = transport(exec);
  expect(await git.transfer("push", ["b:c"])).toEqual({ ok: true });
  expect(await git.transferOk("fetch", ["b:refs/remotes/origin/b"])).toBe(true);
});

test("workflow-scope and auth refusals classify and stop after a single attempt", async () => {
  for (const refusal of [
    {
      stderr:
        "remote: refusing to allow an OAuth token to create or update workflow `.github/workflows/ci.yml`",
      outcome: "workflow-scope",
    },
    {
      stderr:
        "remote: refusing to allow an OAuth app to create or update workflow `.github/workflows/ci.yml`",
      outcome: "workflow-scope",
    },
    {
      stderr:
        "fatal: unable to access 'https://github.com/example/project.git/': The requested URL returned error: 403",
      outcome: "auth",
    },
    { stderr: "Permission denied (publickey).", outcome: "auth" },
  ]) {
    const exec = vi.fn(async () => {
      throw execError(refusal.stderr);
    });
    expect(await transport(exec).transfer("push", ["b:c"])).toEqual({
      ok: false,
      outcome: refusal.outcome,
      detail: refusal.stderr,
    });
    expect(exec, refusal.outcome).toHaveBeenCalledTimes(1);
  }
});

test("moved refusals classify from either stream and keep today's bounded retries", async () => {
  for (const marker of [
    "! [rejected]        head -> b (fetch first)",
    "! [rejected]        head -> b (stale info)",
    "! [rejected]        head -> b (non-fast-forward)",
    "error: another git process [rejected] the same ref",
  ] as const) {
    const exec = vi.fn(async () => {
      throw execError(`remote: untrusted hint text\n${marker}`);
    });
    // Line 2's moved marker classifies; detail stays the redacted first line.
    const result = await transport(exec).transfer("push", ["b:c"]);
    expect(result).toEqual({ ok: false, outcome: "moved", detail: "remote: untrusted hint text" });
    expect(exec).toHaveBeenCalledTimes(3);
  }
});

test("a porcelain-only stdout rejection still classifies as moved", async () => {
  const exec = vi.fn(async () => {
    throw execError(undefined, "!	<old> <new>	b (fetch first)");
  });
  const git = transport(exec);
  expect(await git.transfer("push", ["b:c"])).toEqual({
    ok: false,
    outcome: "moved",
    detail: "!	<old> <new>	b (fetch first)",
  });
  expect(await git.transferOk("fetch", ["b:refs/remotes/origin/b"])).toBe(false);
});

test("a workflow-scope refusal wins over unrelated moved hints on the same stderr", async () => {
  const exec = vi.fn(async () => {
    throw execError(
      "! [rejected]        head -> b (fetch first)\n" +
        "remote: refusing to allow an OAuth token to create or update workflow `.github/workflows/ci.yml`"
    );
  });
  expect(await transport(exec).transfer("push", ["b:c"])).toEqual({
    ok: false,
    outcome: "workflow-scope",
    detail: "! [rejected]        head -> b (fetch first)",
  });
  expect(exec).toHaveBeenCalledTimes(1);
});

test("the last attempt's detail redacts the token value and URL user:password", async () => {
  const stderr =
    "fatal: refused for fake-token (from https://x-access-token:fake-token@github.com/example/project.git)";
  const exec = vi.fn(async () => {
    throw execError(stderr);
  });
  const result = await transport(exec).transfer("push", ["b:c"]);
  expect(result).toEqual({
    ok: false,
    outcome: "other",
    detail: "fatal: refused for  (from https://github.com/example/project.git)",
  });
  if (result.ok) {
    throw new Error("refusal expected");
  }
  expect(pushFailureMessage(result, "example/project")).toBe(
    "push failed: fatal: refused for  (from https://github.com/example/project.git)"
  );
});

test("pushFailureMessage keeps the moved guidance and names the repo on auth", () => {
  expect(
    pushFailureMessage({ ok: false, outcome: "moved", detail: "unused" }, "example/project")
  ).toBe("error: the remote branch moved: fetch and merge it (never force-push)");
  expect(
    pushFailureMessage({ ok: false, outcome: "auth", detail: "unused" }, "example/project")
  ).toBe("push refused: the gh login in GH_CONFIG_DIR is not authorized for example/project");
});
