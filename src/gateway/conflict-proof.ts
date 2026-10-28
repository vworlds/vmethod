import { lockfilesOnly } from "./lockfile.js";

/** Prove a full-context remerge patch changes only textual conflict regions.
 * Unknown metadata, binary/mode/rename conflicts and retained markers fail closed.
 * This is a syntactic boundary, not a claim of semantic equivalence.
 */
export function conflictHunksOnly(patch: string): boolean {
  let inHunk = false;
  let region = false;
  let additions = false;
  let conflicts = 0;
  let separator = false;
  for (const line of patch.trimEnd().split("\n")) {
    if (!inHunk) {
      if (/^@@ -1(?:,\d+)? \+1(?:,\d+)? @@/.test(line)) {
        inHunk = true;
      } else if (
        !/^(diff --git |index [a-f\d]+\.\.[a-f\d]+ 100(?:644|755)$|remerge CONFLICT \(content\): |--- a\/|\+\+\+ b\/)/.test(
          line
        )
      ) {
        return false;
      }
      continue;
    }
    if (line === "\\ No newline at end of file") {
      continue;
    }
    const operation = line[0];
    const text = line.slice(1);
    if (![" ", "+", "-"].includes(operation)) {
      return false;
    }
    if (operation === "+") {
      if (!(region || additions) || /^(<{7}|={7}|>{7}|\|{7})(?: |$)/.test(text)) {
        return false;
      }
      continue;
    }
    if (/^<{7} /.test(text)) {
      if (region || operation !== "-") {
        return false;
      }
      region = true;
      separator = false;
      additions = true;
      conflicts++;
    } else if (/^>{7} /.test(text)) {
      if (!region || !separator || operation !== "-") {
        return false;
      }
      region = false;
    } else if (text === "=======") {
      if (!region || separator || operation !== "-") {
        return false;
      }
      separator = true;
    } else if (!region) {
      if (operation === "-") {
        return false;
      }
      additions = false;
    }
  }
  return inHunk && conflicts > 0 && !region;
}

/** Prove exact merge parents and every remerge-diff path. Lockfile-only conflicts
 * allow whole-lockfile regeneration; mixed conflicts retain the textual hunk rule.
 * Lockfile sync and green checks must be established separately by the caller.
 */
export async function proveConflictMerge(
  git: (...args: string[]) => Promise<string>,
  head: string,
  previous: string,
  base: string,
  files: string[]
): Promise<boolean> {
  const parents = (await git("show", "-s", "--format=%P", head)).trim().split(" ");
  if (parents.length !== 2 || parents[0] !== previous || parents[1] !== base) {
    return false;
  }
  const changed = (await git("show", "--remerge-diff", "--format=", "--name-only", "-z", head))
    .split("\0")
    .filter(Boolean);
  if (lockfilesOnly(files)) {
    return lockfilesOnly(changed);
  }
  if (!changed.length || changed.some((file) => !files.includes(file))) {
    return false;
  }
  for (const file of changed) {
    const patch = await git(
      "show",
      "--remerge-diff",
      "--format=",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=2147483647",
      head,
      "--",
      file
    );
    if (!conflictHunksOnly(patch)) {
      return false;
    }
  }
  return true;
}
