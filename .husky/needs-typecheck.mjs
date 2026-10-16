import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function needsTypecheck(paths) {
  return paths.some((path) => {
    if (/\.(?:md|mdx|txt|rst)$/.test(path)) {
      return false;
    }
    const name = path.split("/").at(-1);
    return (
      /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(path) ||
      /(?:^|\/)(?:tests?|bench)\//.test(path) ||
      /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|.*lock.*|tsconfig.*|.*eslint.*|.*vitest.*)$/.test(
        name
      )
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  if (needsTypecheck(staged)) {
    execFileSync("npm", ["run", "typecheck"], { stdio: "inherit" });
  }
}
