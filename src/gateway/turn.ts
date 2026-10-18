import { GitHubHttpError, type GitHubClient } from "./client.js";
import type { Person } from "./people.js";

/** Management assignees encode whose move it is; workers retain their own assignments. */
export function turnAssignees(
  people: Person[],
  repo: string,
  current: string[],
  role: "owner" | "orchestrator" | null
): string[] {
  if (role === null) {
    const managed = new Set(
      people
        .filter((p) => ["owner", "orchestrator"].includes(p.role))
        .map((p) => p.login.toLowerCase())
    );
    return current.filter((login) => !managed.has(login.toLowerCase()));
  }
  let candidates = people.filter(
    (p) => p.role === role && (role !== "orchestrator" || !p.repos || p.repos.includes(repo))
  );
  if (role === "orchestrator" && candidates.some((p) => p.repos?.includes(repo))) {
    candidates = candidates.filter((p) => p.repos?.includes(repo));
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one ${role} for ${repo}`);
  }
  return [candidates[0].login];
}

/** Apply a turn from an already-read snapshot, with no redundant assignment writes. */
export async function setTurn(
  github: GitHubClient,
  repo: string,
  number: number,
  current: string[],
  next: string[]
): Promise<void> {
  const path = `/repos/${repo}/issues/${number}/assignees`;
  const apply = async (assignees: string[]) => {
    const remove = assignees.filter((login) => !next.includes(login));
    const add = next.filter((login) => !assignees.includes(login));
    if (remove.length) {
      await github.rest(path, "DELETE", { assignees: remove });
    }
    if (add.length) {
      await github.rest(path, "POST", { assignees: add });
    }
  };
  try {
    await apply(current);
  } catch (error) {
    if (!(error instanceof GitHubHttpError) || error.status !== 422) {
      throw error;
    }
    const response = (await github.rest(`/repos/${repo}/issues/${number}`)) as {
      assignees?: { login?: string }[];
    };
    const latest = (response.assignees ?? []).flatMap((person) => person.login ?? []);
    if (sameAssignees(latest, next)) {
      return;
    }
    await apply(latest);
  }
}

function sameAssignees(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((login) => right.includes(login));
}
