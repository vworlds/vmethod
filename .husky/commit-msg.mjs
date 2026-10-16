import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isValidSubject(message) {
  return (
    /^(?:Merge |Revert ")/.test(message) ||
    /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|BREAKING CHANGE): .+$/.test(message)
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const message = readFileSync(process.argv[2], "utf8").split("\n", 1)[0];
  if (!isValidSubject(message)) {
    console.error("Commit subject must be '<type>: <subject>' with no scope.");
    process.exit(1);
  }
}
