import { readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { init } from "../src/init.js";
import { check } from "../src/check.js";
import { loadYaml } from "../src/config.js";
import { fixture, peer, templates } from "./helpers.js";

test("consumer examples initialize valid configs without installing agent routing or permissions", () => {
  const root = fixture();
  init(root, templates);
  expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
  expect(existsSync(join(root, "opencode.json"))).toBe(false);
  expect(loadYaml(root, "people")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "owner", id: 1 }),
      expect.objectContaining({ role: "orchestrator", id: 2 }),
      expect.objectContaining({ role: "worker", id: 3 }),
      expect.objectContaining({ role: "collaborator", id: 4 }),
      expect.objectContaining({
        role: "system",
        events: ["check_run", "status", "workflow_run"],
      }),
    ])
  );
  expect(loadYaml(root, "models")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "opencode", gate: "owner" }),
      expect.objectContaining({ kind: "claude", gate: "none" }),
    ])
  );
  peer(root);
  expect(check(root).messages).toContain(
    "Install owner-approved .claude/settings.json from templates/claude-settings.json"
  );
  mkdirSync(join(root, ".claude"));
  copyFileSync(join(templates, ".claude/settings.json"), join(root, ".claude/settings.json"));
  expect(check(root)).toEqual({ code: 0, messages: [] });
  expect(init(root, templates)).toEqual([]);
}, 15000);

test("Claude destination template and the CLI compatibility template contain identical policy data", () => {
  const readJson = (path: string): unknown =>
    JSON.parse(readFileSync(join(templates, path), "utf8"));
  expect(readJson(".claude/settings.json")).toEqual(readJson("claude-settings.json"));
}, 15000);
