import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import { OpencodeClient, type Dependencies } from "./client.js";
import { GitTransport, validateBranch } from "./git.js";
import { assertLockfileInSync, lockfileCheckable, npmCiEnvironment } from "./lockfile.js";
import { object } from "./people.js";
import { workerCheckout, workerWorktreeName } from "./worker-path.js";

/** The task-scoped environment `vmethod` verbs load in a worker worktree (see taskEnvironment). */
export const taskEnvironmentFile = ".vmethod/.env";

/** Package installs and builds outlast the default 30-second subprocess budget. */
const installTimeout = 900000;

export interface WorkerTask {
  pr: number;
  branch: string;
  base: string;
}

/**
 * Worker worktrees live in the worker checkout, never in the orchestrator's. They are
 * created through OpenCode's worktree API (so OpenCode and OpenChamber list them), on
 * the task branch, with dependencies installed and `.vmethod/.env` naming the task.
 */
export class WorkerWorktrees {
  readonly checkout: string;

  constructor(
    private root: string,
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies
  ) {
    this.checkout = workerCheckout(root, config);
  }

  /** The registered worktree of the worker checkout on this branch, if any. */
  async find(branch: string): Promise<string | undefined> {
    validateBranch(branch);
    return (await this.registered()).find((tree) => tree.branch === branch)?.path;
  }

  /** Every worktree of the worker checkout that is on a branch, the checkout itself excluded. */
  async registered(): Promise<{ path: string; branch: string }[]> {
    this.assertCheckout();
    const output = await this.git(this.checkout, "worktree", "list", "--porcelain", "-z");
    return output.split("\0\0").flatMap((record) => {
      const fields = record.split("\0");
      const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
      const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18);
      return path && branch && resolve(path) !== this.checkout ? [{ path, branch }] : [];
    });
  }

  /** Find or create the task's worktree, then verify it, install and write the task env. */
  async prepare(task: WorkerTask): Promise<string> {
    this.assertCheckout();
    const own = resolve(
      this.root,
      (await this.git(this.root, "rev-parse", "--git-common-dir")).trim()
    );
    if (realpathSync(own) === realpathSync(await this.commonDir())) {
      throw new Error(
        "workerCheckout shares the orchestrator's .git; clone the repository for workers"
      );
    }
    let directory = await this.find(task.branch);
    if (!directory) {
      directory = await this.create(task);
    }
    await this.verify(directory, task.branch);
    await this.git(directory, "branch", "-q", `--set-upstream-to=origin/${task.branch}`);
    await this.install(directory);
    await this.writeTaskEnvironment(directory, task.pr);
    return directory;
  }

  /** Verify an existing task worktree without creating, installing or writing anything. */
  async locate(branch: string): Promise<string> {
    const directory = await this.find(branch);
    if (!directory) {
      throw new Error(`No worktree of the worker checkout is on ${branch}`);
    }
    await this.verify(directory, branch);
    return directory;
  }

  /** Remove a worktree through OpenCode, so its inventory forgets it as well. */
  async remove(directory: string): Promise<void> {
    await this.client().request("DELETE", "/api/worktree", {
      projectID: await this.projectId(),
      directory,
      force: true,
    });
  }

  private async create(task: WorkerTask): Promise<string> {
    validateBranch(task.base);
    if (
      !(await new GitTransport(this.config, this.env, this.deps, this.checkout).transferOk(
        "fetch",
        [
          `+refs/heads/${task.base}:refs/remotes/origin/${task.base}`,
          `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`,
        ]
      ))
    ) {
      throw new Error("error: fetch into the worker checkout failed");
    }
    const local = (
      await this.git(
        this.checkout,
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${task.branch}`
      )
    ).trim();
    if (!local) {
      await this.git(
        this.checkout,
        "branch",
        "--no-track",
        task.branch,
        `refs/remotes/origin/${task.branch}`
      );
    }
    // OpenCode checks out the branch's commit detached; switch onto the branch itself.
    const created = object(
      await this.client().request("POST", "/api/worktree", {
        projectID: await this.projectId(),
        from: this.checkout,
        name: workerWorktreeName(this.config, task.branch),
        branch: task.branch,
      })
    );
    if (typeof created.directory !== "string" || !created.directory.startsWith("/")) {
      throw new Error("OpenCode returned no worktree directory");
    }
    await this.git(created.directory, "checkout", "-q", task.branch);
    return created.directory;
  }

  private async verify(directory: string, branch: string): Promise<void> {
    if (
      realpathSync((await this.git(directory, "rev-parse", "--show-toplevel")).trim()) !==
      realpathSync(directory)
    ) {
      throw new Error("Worker directory is not its own worktree");
    }
    if ((await this.git(directory, "rev-parse", "--abbrev-ref", "HEAD")).trim() !== branch) {
      throw new Error("Worker directory is not on the PR's branch");
    }
    const common = resolve(
      directory,
      (await this.git(directory, "rev-parse", "--git-common-dir")).trim()
    );
    if (
      common === resolve(directory, (await this.git(directory, "rev-parse", "--git-dir")).trim())
    ) {
      throw new Error("Worker start requires a linked task worktree, not a main checkout");
    }
    if (realpathSync(common) !== realpathSync(await this.commonDir())) {
      throw new Error("Worker worktree does not belong to the worker checkout");
    }
  }

  /** npm ci when package-lock.json changed since the last install; self-hosting also builds. */
  private async install(directory: string): Promise<void> {
    if (!lockfileCheckable(directory)) {
      return;
    }
    const env = npmCiEnvironment(this.env);
    this.deps.report(`checking lockfile sync in ${directory}`);
    await assertLockfileInSync(this.deps, directory, env);
    const stamp = join(directory, "node_modules/.package-lock.sha");
    const want = createHash("sha256")
      .update(readFileSync(join(directory, "package-lock.json")))
      .digest("hex");
    if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== want) {
      // Package lifecycle scripts get no gateway credentials.
      await this.deps.exec("npm", ["ci"], { cwd: directory, env, timeout: installTimeout });
      mkdirSync(join(directory, "node_modules"), { recursive: true });
      writeFileSync(stamp, `${want}\n`);
    }
    const selfHosting =
      object(JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))).name ===
      "@vworlds/vmethod";
    if (selfHosting) {
      await this.deps.exec("npm", ["run", "build"], {
        cwd: directory,
        env,
        timeout: installTimeout,
      });
    }
    try {
      accessSync(
        join(directory, selfHosting ? "dist/vmethod.mjs" : "node_modules/.bin/vmethod"),
        selfHosting ? constants.R_OK : constants.X_OK
      );
    } catch {
      throw new Error(
        selfHosting
          ? "Missing built dist/vmethod.mjs in task worktree"
          : "Missing node_modules/.bin/vmethod after npm ci in the task worktree"
      );
    }
  }

  /** Name the task once for every vmethod verb run in the worktree; git never sees the file. */
  private async writeTaskEnvironment(directory: string, pr: number): Promise<void> {
    mkdirSync(join(directory, ".vmethod"), { recursive: true });
    writeFileSync(
      join(directory, taskEnvironmentFile),
      `VMETHOD_ROLE=worker\nVMETHOD_TASK_PR=${pr}\n`
    );
    const info = join(await this.commonDir(), "info");
    const exclude = join(info, "exclude");
    const line = `/${taskEnvironmentFile}`;
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.split(/\r?\n/).includes(line)) {
      mkdirSync(info, { recursive: true });
      appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
    }
  }

  private async commonDir(): Promise<string> {
    return resolve(
      this.checkout,
      (await this.git(this.checkout, "rev-parse", "--git-common-dir")).trim()
    );
  }

  private async projectId(): Promise<string> {
    const location = object(
      await this.client().request(
        "GET",
        `/api/location?location%5Bdirectory%5D=${encodeURIComponent(this.checkout)}`
      )
    );
    const id = object(location.project).id;
    if (typeof id !== "string" || !/^[\w-]+$/.test(id)) {
      throw new Error("OpenCode returned no project for the worker checkout");
    }
    return id;
  }

  private assertCheckout(): void {
    if (!existsSync(join(this.checkout, ".git"))) {
      throw new Error(`workerCheckout ${this.checkout} is not a git clone`);
    }
  }

  private client(): OpencodeClient {
    return new OpencodeClient(this.env, this.deps.fetch, this.deps.now, this.deps.report);
  }

  private git(cwd: string, ...args: string[]): Promise<string> {
    return this.deps.exec("git", args, { cwd, env: { PATH: this.env.PATH, HOME: this.env.HOME } });
  }
}
