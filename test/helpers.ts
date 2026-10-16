import { mkdirSync, mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";
import { init } from "../src/init.js";

export const templates = resolve("templates");
export function fixture(): string {
  mkdirSync(".tmp/tests", { recursive: true });
  return mkdtempSync(resolve(".tmp/tests/project-"));
}
export function validProject(): string {
  const root = fixture();
  init(root, templates);
  mkdirSync(join(root, ".claude"));
  cpSync(join(templates, "claude-settings.json"), join(root, ".claude/settings.json"));
  peer(root);
  return root;
}
export function peer(root: string, version = "12.1.0"): void {
  const dir = join(root, "node_modules/mermaid");
  mkdirSync(dir, { recursive: true });
  // Metadata-only fixture; any attempt to use a renderer fails loudly.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mermaid", version, main: "index.cjs" })
  );
  writeFileSync(
    join(dir, "index.cjs"),
    'throw new Error("Unexpected renderer call on metadata-only fixture");\n'
  );
}
