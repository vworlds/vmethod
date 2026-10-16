import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function fragmentKind(text) {
  const matches = [...text.matchAll(/^kind: (breaking|feature|fix)\r?$/gm)];
  if (matches.length !== 1)
    throw new Error("Changelog fragment must declare kind: breaking, feature or fix");
  if (text.trim().split(/\r?\n/).length < 3)
    throw new Error("Changelog fragment must include a description");
  return matches[0][1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const number = process.argv[2];
  if (!/^\d+$/.test(number)) throw new Error("Expected numeric PR number");
  fragmentKind(readFileSync(`changes/unreleased/${number}.md`, "utf8"));
}
