import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { check } from "../src/check.js";
import { peer, validProject } from "./helpers.js";

test("check returns 0 for a valid project, 1 for findings, 2 for a missing dependency", () => {
  const root = validProject();
  expect(check(root)).toEqual({ code: 0, messages: [] });
  peer(root, "11.0.0");
  expect(check(root)).toMatchObject({
    code: 1,
    messages: ["mermaid must equal 12.1.0; installed 11.0.0"],
  });
  rmSync(join(root, "node_modules/mermaid"), { recursive: true });
  expect(check(root)).toMatchObject({
    code: 2,
    messages: ["Dependency missing: install mermaid@12.1.0"],
  });
}, 15000);

test("permissions, numeric ids, model families and secret-looking values are checked without leaking secrets", () => {
  const root = validProject();
  writeFileSync(join(root, ".claude/settings.json"), "{}");
  writeFileSync(join(root, "people.yaml"), "- login: owner\n  id: wrong\n  role: owner\n");
  writeFileSync(
    join(root, "models.yaml"),
    "- family: wrong\n  model: a/b\n  kind: opencode\n  gate: none\n"
  );
  const path = join(root, "vmethod.yaml");
  const token = "ghp_" + "a".repeat(36);
  writeFileSync(path, readFileSync(path, "utf8") + `\ntrack: ${token}\n`);
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.messages.join("\n")).toContain("Secret-looking config value at track");
  expect(result.messages.join("\n")).not.toContain(token);
  expect(result.messages.join("\n")).toContain("people.yaml:");
  expect(result.messages.join("\n")).toContain("models.yaml:");
  expect(result.messages.join("\n")).toContain("Permission deny rule missing");
  expect(check(root, { VMETHOD_TRACK: "safe-override" }).messages.join("\n")).toContain(
    "environment overrides do not hide stored secrets"
  );
}, 15000);
