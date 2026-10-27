import { runChild } from "./child-process.js";
import { buildSync } from "esbuild";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { fixture, peer, validProject } from "./helpers.js";
import { loadYaml } from "../src/config.js";

beforeAll(() => {
  const build = runChild(process.execPath, ["scripts/build.mjs"], {
    encoding: "utf8",
    timeout: 3000,
  });
  expect(build.status, build.stderr).toBe(0);
}, 5000);

test("CLI uses its built version to gate explicit permission deferral", () => {
  const root = validProject();
  rmSync(join(root, ".claude/settings.json"));
  for (const version of ["1.0.0-rc.2", "1.0.0"]) {
    const cli = join(root, `vmethod-${version}.mjs`);
    buildSync({
      entryPoints: ["src/cli/main.ts"],
      outfile: cli,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
      define: {
        __VERSION__: JSON.stringify(version),
        __BOARD_VERSION__: "2",
        __MIGRATIONS__: "[]",
        __LEARNINGS__: "{}",
      },
    });
    const run = (...args: string[]) =>
      runChild(process.execPath, [cli, "check", ...args], {
        cwd: root,
        env: { VMETHOD_ROOT: root },
        encoding: "utf8",
        timeout: 3000,
      });
    const result = run("--defer-permissions");
    expect(result.status, result.stderr).toBe(version.includes("-") ? 0 : 1);
    expect(result.stdout).toContain(
      version.includes("-")
        ? `WARN permissions deferred (prerelease ${version}): .claude/settings.json not installed`
        : "--defer-permissions is only valid on a prerelease"
    );
    expect(run().status).toBe(1);
    expect(run("--unknown").status).toBe(1);
  }
}, 15000);

test("packed consumer installs offline with real Mermaid and lowest-supported jsdom, without git/gh", () => {
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
  const result = runChild(process.execPath, ["scripts/smoke.mjs"], {
    encoding: "utf8",
    timeout: 60000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Tarball smoke passed");
  const root = validProject();
  const cli = resolve("dist/vmethod.mjs");
  const run = () =>
    runChild(process.execPath, [cli, "check"], {
      cwd: root,
      env: { VMETHOD_ROOT: root },
      encoding: "utf8",
      timeout: 3000,
    });
  expect(run().status).toBe(0);
  peer(root, "0.0.0");
  expect(run().status).toBe(1);
  rmSync(join(root, "node_modules/mermaid"), { recursive: true });
  expect(run().status).toBe(2);
}, 65000);

test("built CLI initializes and checks the verbatim public vecs TSV registry offline", () => {
  const root = validProject();
  rmSync(join(root, "models.yaml"));
  copyFileSync("test/fixtures/models-vecs.tsv", join(root, "models.tsv"));
  const cli = resolve("dist/vmethod.mjs");
  const run = (args: string[]) =>
    runChild(process.execPath, [cli, ...args], {
      cwd: root,
      env: { VMETHOD_ROOT: root },
      encoding: "utf8",
      timeout: 3000,
    });
  const initialized = run(["init"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  expect(initialized.stdout).toContain("Wrote models.yaml");
  expect(loadYaml(root, "models")).toEqual(
    expect.arrayContaining([
      {
        family: "astra",
        model: "codexbal/gpt-6-astra",
        tier: "expensive",
        kind: "opencode",
        gate: "owner",
      },
      {
        family: "sonnet",
        model: "claude-code/claude-sonnet-5-5",
        tier: "standard",
        kind: "opencode",
        gate: "none",
      },
      {
        family: "opus",
        model: "claude-code/claude-opus-5-5",
        tier: "standard",
        kind: "opencode",
        gate: "none",
      },
    ])
  );
  const checked = run(["check"]);
  expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
  expect(checked.stdout).toBe(
    ["sol", "luna", "astra", "sonnet", "opus", "glm", "glm-flash", "big-pickle"]
      .map((family) => `WARN models.yaml: ${family} has no price; delivery usd is null\n`)
      .join("") +
      "WARN vmethod is not on PATH; write it with npm exec --no -- vmethod init --launcher\n"
  );
  expect(run(["init"]).stdout).toContain("Already initialized");
  expect(readFileSync(join(root, "models.tsv"))).toEqual(
    readFileSync("test/fixtures/models-vecs.tsv")
  );
}, 6000);

test("offline CLI verbs need no identity while check --online reports missing credentials", () => {
  const root = validProject();
  const cli = resolve("dist/vmethod.mjs");
  for (const args of [["version"], ["check"], ["config", "get", "repo"]]) {
    const result = runChild(process.execPath, [cli, ...args], {
      cwd: root,
      env: { VMETHOD_ROOT: root },
      encoding: "utf8",
      timeout: 3000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }
  const online = runChild(process.execPath, [cli, "check", "--online"], {
    cwd: root,
    env: { VMETHOD_ROOT: root },
    encoding: "utf8",
    timeout: 3000,
  });
  expect(online.status, online.stderr).toBe(1);
  expect(online.stdout).toContain("GH_CONFIG_DIR: Missing GH_CONFIG_DIR");
}, 15000);

test("online checking composes with prerelease permission deferral and preserves CODEOWNERS warnings", () => {
  const root = validProject();
  const cli = resolve("dist/vmethod.mjs");
  rmSync(join(root, ".claude/settings.json"));
  rmSync(join(root, "CODEOWNERS"));
  const run = (args: string[]) =>
    runChild(process.execPath, [cli, "check", ...args], {
      cwd: root,
      env: { VMETHOD_ROOT: root },
      encoding: "utf8",
      timeout: 3000,
    });
  for (const args of [
    ["--online", "--defer-permissions"],
    ["--defer-permissions", "--online"],
  ]) {
    const result = run(args);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("WARN permissions deferred");
    expect(result.stdout).toContain("CODEOWNERS");
    expect(result.stdout).toContain("GH_CONFIG_DIR: Missing GH_CONFIG_DIR");
    expect(result.stdout).not.toContain("Install owner-approved");
    expect(result.stderr).toBe("");
  }
  for (const flag of ["--online", "--defer-permissions"]) {
    const result = run([flag, flag]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: vmethod check [--online] [--defer-permissions]");
    expect(result.stdout).toBe("");
  }
}, 15000);

test("CI self-check skips absent config and explicitly defers only missing owner settings", () => {
  const script = resolve("scripts/check-self.mjs");
  const run = (root: string) =>
    runChild(process.execPath, [script], {
      cwd: root,
      env: {},
      encoding: "utf8",
      timeout: 3000,
    });
  const absent = run(fixture());
  expect(absent.status, absent.stderr).toBe(0);
  expect(absent.stdout).toContain("Skipping vmethod self-check");
  const root = validProject();
  expect(run(root).status).toBe(0);
  writeFileSync(join(root, ".claude/settings.json"), "{}");
  expect(run(root).status).toBe(1);
  writeFileSync(join(root, ".claude/settings.json"), "invalid JSON");
  expect(run(root).status).toBe(1);
  rmSync(join(root, ".claude/settings.json"));
  const ownerOnly = run(root);
  expect(ownerOnly.status, ownerOnly.stderr).toBe(0);
  expect(ownerOnly.stdout).toBe(
    ["sol", "astra", "sonnet", "glm", "big-pickle"]
      .map((family) => `WARN models.yaml: ${family} has no price; delivery usd is null\n`)
      .join("") +
      "WARN permissions deferred (prerelease 0.0.0-dev): .claude/settings.json not installed\n" +
      "WARN vmethod is not on PATH; write it with npm exec --no -- vmethod init --launcher\n"
  );
  writeFileSync(join(root, "people.yaml"), "invalid: config");
  expect(run(root).status).toBe(1);
  rmSync(join(root, "node_modules/mermaid"), { recursive: true });
  expect(run(root).status).toBe(2);
}, 12000);
