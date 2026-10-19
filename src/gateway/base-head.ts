import type { GitHubClient } from "./client.js";
import { validateBranch, type GitTransport } from "./git.js";
import { object } from "./people.js";

/** Resolve the live base, never a PR snapshot. Git callers must fetch the ref first. */
export async function liveBaseHead(
  base: string,
  source: { github: GitHubClient; repo: string } | { git: GitTransport }
): Promise<string> {
  validateBranch(base);
  const head =
    "git" in source
      ? (await source.git.run("rev-parse", `refs/remotes/origin/${base}`)).trim()
      : object(
          object(
            await source.github.rest(`/repos/${source.repo}/branches/${encodeURIComponent(base)}`)
          ).commit
        ).sha;
  if (typeof head !== "string" || !/^[a-f\d]{40}$/i.test(head)) {
    throw new Error("Invalid live base SHA");
  }
  return head;
}
