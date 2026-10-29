const shaPattern = /^[a-f\d]{40}$/i;

/** Server-only proof: a clean merge tree alone is insufficient; the task patch must survive. */
export async function cleanBaseMerges(
  git: (...args: string[]) => Promise<string>,
  approved: string,
  head: string,
  base: string
): Promise<boolean> {
  if (![approved, head, base].every((value) => shaPattern.test(value)) || approved === head) {
    return false;
  }
  try {
    const lines = (await git("rev-list", "--first-parent", "--parents", `${approved}..${head}`))
      .trim()
      .split("\n");
    let expected = head;
    for (const line of lines) {
      const [commit, first, second, extra] = line.trim().split(/\s+/);
      if (
        commit !== expected ||
        extra ||
        ![commit, first, second].every((value) => shaPattern.test(value ?? ""))
      ) {
        return false;
      }
      await git("merge-base", "--is-ancestor", second, base);
      const computed = (await git("merge-tree", "--write-tree", first, second)).trim();
      if (
        !shaPattern.test(computed) ||
        computed !== (await git("rev-parse", `${commit}^{tree}`)).trim()
      ) {
        return false;
      }
      expected = first;
    }
    if (expected !== approved) {
      return false;
    }
    const before = (await git("merge-base", approved, base)).trim();
    const after = (await git("merge-base", head, base)).trim();
    if (![before, after].every((value) => shaPattern.test(value))) {
      return false;
    }
    const paths = [
      ...new Set(
        (
          (await git("diff", "--name-only", "-z", before, approved)) +
          (await git("diff", "--name-only", "-z", after, head))
        )
          .split("\0")
          .filter(Boolean)
      ),
    ].sort();
    if (!paths.length) {
      return false;
    }
    return (
      (await git("diff", "--binary", "--full-index", before, approved, "--", ...paths)) ===
      (await git("diff", "--binary", "--full-index", after, head, "--", ...paths))
    );
  } catch {
    // A missing object or conflict is not a proof. Approval fails closed.
    return false;
  }
}
