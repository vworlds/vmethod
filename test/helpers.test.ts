import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { fixture } from "./helpers.js";

test("consumer fixtures cannot inherit the repo's installed peers or config", () => {
  const root = fixture();
  expect(dirname(root)).toBe(tmpdir());
  expect(relative(process.cwd(), root)).toMatch(/^\.\./);
  const repoRequire = createRequire(import.meta.url);
  expect(repoRequire.resolve("mermaid")).toBeTruthy();
  expect(repoRequire.resolve("jsdom")).toBeTruthy();
  const consumerRequire = createRequire(join(root, "package.json"));
  expect(() => consumerRequire.resolve("mermaid")).toThrow(/Cannot find module/);
  expect(() => consumerRequire.resolve("jsdom")).toThrow(/Cannot find module/);
  for (let directory = root; ; directory = dirname(directory)) {
    expect(existsSync(join(directory, "vmethod.yaml"))).toBe(false);
    if (dirname(directory) === directory) {
      break;
    }
  }
});
