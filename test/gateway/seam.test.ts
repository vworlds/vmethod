import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

/** Static architecture guard: inspect syntax, not text in comments/strings. */
function violations(source: string): string[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === "fetch") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch") ||
        (ts.isElementAccessExpression(callee) &&
          ts.isStringLiteral(callee.argumentExpression) &&
          callee.argumentExpression.text === "fetch")
      ) {
        findings.push("fetch call");
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "credentials") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "credentials") ||
      (ts.isBindingElement(node) &&
        (node.propertyName ?? node.name).getText(file) === "credentials")
    ) {
      findings.push("credentials read");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return findings;
}

test("only src/gateway may call fetch or read credentials", () => {
  const findings: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (relative("src", path) === "gateway") {
        continue;
      }
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".ts")) {
        for (const violation of violations(readFileSync(path, "utf8"))) {
          findings.push(`${path}: ${violation}`);
        }
      }
    }
  }
  walk("src");
  expect(findings).toEqual([]);
}, 15000);

test("seam guard detects direct/member calls and credential reads but ignores comments and strings", () => {
  expect(
    violations(
      `fetch('/x'); globalThis.fetch('/x'); deps['fetch']('/x'); const x = config.credentials; const y = config['credentials']; const {credentials: z} = config;`
    )
  ).toEqual([
    "fetch call",
    "fetch call",
    "fetch call",
    "credentials read",
    "credentials read",
    "credentials read",
  ]);
  expect(
    violations(
      `// fetch('x'); config.credentials\nconst example = 'fetch('; const label = 'credentials';`
    )
  ).toEqual([]);
}, 15000);
