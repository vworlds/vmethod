import { execFileSync } from "node:child_process";

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
const needsTypecheck = staged.some((file) =>
  /(?:^|\/)(?:tsconfig(?:\.[^/]*)?\.json|[^/]+\.(?:ts|tsx|mts|cts))$/.test(file)
);

if (needsTypecheck) {
  execFileSync("npm", ["run", "typecheck"], { stdio: "inherit" });
}
