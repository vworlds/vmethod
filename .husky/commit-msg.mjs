import { readFileSync } from "node:fs";

const message = readFileSync(process.argv[2], "utf8").split("\n", 1)[0];
const valid = /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|BREAKING CHANGE): .+$/;

if (!valid.test(message)) {
  console.error("Commit subject must be '<type>: <subject>' with no scope.");
  process.exit(1);
}
