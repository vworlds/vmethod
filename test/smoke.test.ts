import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { peer, validProject } from "./helpers.js";
import { loadYaml } from "../src/config.js";

beforeAll(() => {
  const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(build.status, build.stderr).toBe(0);
}, 30000);

test("packed consumer installs offline with a metadata-only Mermaid fixture and no git/gh", () => {
  const map = JSON.parse(readFileSync("dist/vmethod.mjs.map", "utf8")) as {
    sources: string[];
    sourcesContent: string[];
  };
  for (const file of [
    "schema/vmethod.schema.json",
    "schema/people.schema.json",
    "schema/models.schema.json",
    "board/migrations/0001-baseline.json",
  ]) {
    const index = map.sources.findIndex(
      (source) => resolve(dirname("dist/vmethod.mjs.map"), source) === resolve(file)
    );
    expect(index, `${file} must be embedded in the bundle sourcemap`).toBeGreaterThanOrEqual(0);
    expect(map.sourcesContent[index], `${file} must match the editable source`).toBe(
      readFileSync(file, "utf8")
    );
  }
  const result = spawnSync(process.execPath, ["scripts/smoke.mjs"], {
    encoding: "utf8",
    timeout: 90000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Tarball smoke passed");
  const root = validProject();
  const cli = resolve("dist/vmethod.mjs");
  const run = () =>
    spawnSync(process.execPath, [cli, "check"], {
      cwd: root,
      env: { VMETHOD_ROOT: root },
      encoding: "utf8",
      timeout: 5000,
    });
  expect(run().status).toBe(0);
  peer(root, "0.0.0");
  expect(run().status).toBe(1);
  rmSync(join(root, "node_modules/mermaid"), { recursive: true });
  expect(run().status).toBe(2);
}, 120000);

test("built CLI initializes and checks the verbatim public vecs TSV registry offline", () => {
  const root = validProject();
  rmSync(join(root, "models.yaml"));
  copyFileSync("test/fixtures/models-vecs.tsv", join(root, "models.tsv"));
  const cli = resolve("dist/vmethod.mjs");
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: { VMETHOD_ROOT: root },
      encoding: "utf8",
      timeout: 5000,
    });
  const initialized = run(["init"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  expect(initialized.stdout).toContain("Wrote models.yaml");
  expect(loadYaml(root, "models")).toEqual(
    expect.arrayContaining([
      {
        family: "astra",
        model: "codexbal/gpt-6-astra",
        kind: "opencode",
        gate: "owner",
      },
      {
        family: "sonnet",
        model: "claude-sonnet-5-5",
        kind: "claude",
        gate: "none",
      },
      {
        family: "opus",
        model: "claude-opus-5-5",
        kind: "claude",
        gate: "none",
      },
    ])
  );
  const checked = run(["check"]);
  expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
  expect(checked.stdout).toContain("vmethod check: ok");
  expect(run(["init"]).stdout).toContain("Already initialized");
  expect(readFileSync(join(root, "models.tsv"))).toEqual(
    readFileSync("test/fixtures/models-vecs.tsv")
  );
}, 15000);
