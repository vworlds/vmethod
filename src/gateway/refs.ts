import type { Config } from "../config.js";

export interface ThreadRef {
  repo: string;
  number: number;
  owner: string;
  name: string;
  link: string;
}

/** Thread references accept `<number>` or `org/repo#n` within the configured org. */
export function reference(value: string, config: Config): ThreadRef {
  const match = /^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#)?([1-9]\d*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) {
    throw new Error("Expected <number> or <org/repo#number>");
  }
  const repo = match[1] ?? String(config.repo);
  const [owner, name] = repo.split("/");
  if (owner.toLowerCase() !== String(config.org).toLowerCase()) {
    throw new Error("Repository is outside configured org");
  }
  return {
    repo,
    number: Number(match[2]),
    owner,
    name,
    link: `https://github.com/${repo}/issues/${match[2]}`,
  };
}

/** Blocker arguments also accept a leading `#` (`#m`), normalized before the org-scoped thread ref. */
export function blockerReference(value: string, config: Config): ThreadRef {
  return reference(value.startsWith("#") ? value.slice(1) : value, config);
}

/** Same-repository blockers read as `#n`; cross-repository blockers keep their `org/repo#n`. */
export function blockerLabel(ref: ThreadRef, config: Config): string {
  return ref.repo.toLowerCase() === String(config.repo).toLowerCase()
    ? `#${ref.number}`
    : `${ref.repo}#${ref.number}`;
}
