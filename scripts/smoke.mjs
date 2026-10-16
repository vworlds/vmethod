import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

export function smoke() {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const consumer = join(repo, "test/fixtures/consumer");
  const originalPackage = readFileSync(join(consumer, "package.json"));
  mkdirSync(join(repo, ".tmp/smoke"), { recursive: true });
  const temp = mkdtempSync(join(repo, ".tmp/smoke/run-"));
  function run(command, args, cwd, env = process.env) {
    const result = spawnSync(command, args, {
      cwd,
      env: { ...env, npm_config_cache: join(repo, ".tmp/npm-cache") },
      encoding: "utf8",
      timeout: 60000,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `${command} ${args.join(" ")} failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`
      );
    return result.stdout;
  }
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], repo)
  );
  const tarball = join(temp, packed[0].filename);
  try {
    run(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--legacy-peer-deps",
        "--no-save",
        tarball,
      ],
      consumer
    );
    const bin = join(temp, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    // Only Node is on PATH: git, gh, npm, curl and download fallbacks are absent.
    const env = { PATH: bin, VMETHOD_ROOT: consumer };
    const cli = join(consumer, "node_modules/.bin/vmethod");
    const initOutput = run(cli, ["init"], consumer, env);
    if (!initOutput.includes("Owner: install templates/claude-settings.json"))
      throw new Error("Init omitted owner permission instructions");
    mkdirSync(join(consumer, ".claude"), { recursive: true });
    copyFileSync(
      join(consumer, "node_modules/@vworlds/vmethod/templates/claude-settings.json"),
      join(consumer, ".claude/settings.json")
    );
    const output = run(cli, ["check"], consumer, env);
    if (!output.includes("vmethod check: ok"))
      throw new Error(`Unexpected check output: ${output}`);
    const pkg = JSON.parse(
      readFileSync(join(consumer, "node_modules/@vworlds/vmethod/package.json"), "utf8")
    );
    const version = run(cli, ["version"], consumer, env);
    if (!version.includes(`vmethod ${pkg.version}`))
      throw new Error("Bundled version differs from packed package");
    if (!readFileSync(join(consumer, "package.json")).equals(originalPackage))
      throw new Error("Smoke unexpectedly modified consumer package.json");
    console.log("Tarball smoke passed (metadata-only Mermaid fixture; no git/gh).");
    return output;
  } finally {
    // These files belong solely to the fixture smoke run.
    for (const path of [
      "node_modules",
      "vmethod.yaml",
      "people.yaml",
      "models.yaml",
      "scripts",
      ".claude",
    ])
      rmSync(join(consumer, path), { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) smoke();
