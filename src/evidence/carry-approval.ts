const shaPattern = /^[a-f\d]{40}$/i;

/** Prove every task-side commit is a base merge; report its remerge-diff paths.
 * Unlike cleanBaseMerges, this does not certify semantic equivalence: the orchestrator does.
 */
export async function approvalCarryFiles(
  git: (...args: string[]) => Promise<string>,
  approved: string,
  head: string,
  base: string
): Promise<string[] | null> {
  if (![approved, head, base].every((value) => shaPattern.test(value)) || approved === head) {
    return null;
  }
  try {
    const lines = (await git("rev-list", "--parents", `${approved}..${head}`, "--not", base))
      .trim()
      .split("\n");
    const commits = new Map<string, string[]>();
    for (const line of lines) {
      const [commit, ...parents] = line.split(/\s+/);
      if (
        parents.length !== 2 ||
        ![commit, ...parents].every((value) => shaPattern.test(value)) ||
        commits.has(commit)
      ) {
        return null;
      }
      commits.set(commit, parents);
    }
    const paths = new Set<string>();
    let current = head;
    let visited = 0;
    while (current !== approved) {
      const parents = commits.get(current);
      if (!parents || ++visited > commits.size) {
        return null;
      }
      const taskParents = parents.filter((parent) => parent === approved || commits.has(parent));
      if (taskParents.length !== 1) {
        return null;
      }
      const task = taskParents[0];
      const baseParent = parents.find((parent) => parent !== task)!;
      await git("merge-base", "--is-ancestor", baseParent, base);
      for (const path of (
        await git("show", "--remerge-diff", "--format=", "--name-only", "-z", current)
      )
        .split("\0")
        .filter(Boolean)) {
        paths.add(path);
      }
      current = task;
    }
    return visited === commits.size ? [...paths].sort() : null;
  } catch {
    // Missing objects, unsupported remerge-diff or failed ancestry checks are not proof.
    return null;
  }
}
