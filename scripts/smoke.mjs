import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

export function smoke() {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), "vmethod-smoke-"));
  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  const originalPackage = readFileSync(join(repo, "test/fixtures/consumer/package.json"));
  copyFileSync(join(repo, "test/fixtures/consumer/package.json"), join(consumer, "package.json"));
  // npm ci caches tarballs, not registry metadata. Reuse its locked graph so the
  // consumer can install offline even with a fresh cache. Promote the jsdom 24
  // test alias (and its nested dependencies) to the consumer's real jsdom peer.
  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(originalPackage);
  lock.name = manifest.name;
  lock.packages[""] = manifest;
  for (const path of Object.keys(lock.packages)) {
    if (path === "node_modules/jsdom" || path.startsWith("node_modules/jsdom/")) {
      delete lock.packages[path];
    }
  }
  for (const path of Object.keys(lock.packages)) {
    if (path === "node_modules/jsdom24" || path.startsWith("node_modules/jsdom24/")) {
      lock.packages[path.replace("node_modules/jsdom24", "node_modules/jsdom")] =
        lock.packages[path];
      delete lock.packages[path];
    }
  }
  writeFileSync(join(consumer, "package-lock.json"), JSON.stringify(lock));
  function run(command, args, cwd, env = process.env) {
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`
      );
    }
    return result.stdout;
  }
  try {
    const packed = JSON.parse(
      run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], repo)
    );
    const tarball = join(temp, packed[0].filename);
    run(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--strict-peer-deps",
        "--no-save",
        tarball,
      ],
      consumer
    );
    const jsdom = JSON.parse(
      readFileSync(join(consumer, "node_modules/jsdom/package.json"), "utf8")
    );
    if (jsdom.version !== manifest.devDependencies.jsdom) {
      throw new Error(`Smoke must use lowest-supported jsdom; installed ${jsdom.version}`);
    }
    // Follow the packed npm README in a blank directory, not a source-tree copy.
    // Substitute only the registry spec with this candidate's tarball so this
    // check stays offline and tests the package being released, not npm's next tag.
    const readme = readFileSync(join(consumer, "node_modules/@vworlds/vmethod/README.md"), "utf8");
    const install = readme.match(/```sh\s*\n(npm install [^\n]+)\n```/);
    if (!install) {
      throw new Error("Packed README must provide an npm install command");
    }
    const installArgs = install[1].split(" ").slice(1);
    if (
      installArgs.length !== 4 ||
      !installArgs.includes("--save-dev") ||
      !installArgs.includes("--save-exact") ||
      !/^@vworlds\/vmethod@(?:next|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(installArgs[3])
    ) {
      throw new Error("README install must save an exact vmethod devDependency");
    }
    installArgs[3] = tarball;
    const blank = join(temp, "readme-adopter");
    mkdirSync(blank);
    run(
      "npm",
      [
        ...installArgs,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
      ],
      blank
    );
    const adopted = JSON.parse(readFileSync(join(blank, "package.json"), "utf8"));
    const installed = JSON.parse(
      readFileSync(join(blank, "node_modules/@vworlds/vmethod/package.json"), "utf8")
    );
    if (!adopted.devDependencies?.["@vworlds/vmethod"] || installed.version !== packed[0].version) {
      throw new Error("README install did not save the packed candidate as a devDependency");
    }
    const guidePaths = [...readme.matchAll(/`(node_modules\/@vworlds\/vmethod\/docs\/[^`]+)`/g)];
    if (
      guidePaths.length !== 1 ||
      guidePaths[0][1] !== "node_modules/@vworlds/vmethod/docs/adoption.md"
    ) {
      throw new Error("README must route adoption to the installed adoption guide");
    }
    const guide = readFileSync(join(blank, guidePaths[0][1]), "utf8");
    if (!guide.startsWith("# Adoption checklist\n")) {
      throw new Error("README adoption path did not resolve to the packed guide");
    }
    const bin = join(temp, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    // Only Node is on PATH: git, gh, npm, curl and download fallbacks are absent.
    const env = { PATH: bin, VMETHOD_ROOT: consumer };
    const cli = join(consumer, "node_modules/.bin/vmethod");
    const initOutput = run(cli, ["init"], consumer, env);
    if (!initOutput.includes("Owner: install templates/claude-settings.json")) {
      throw new Error("Init omitted owner permission instructions");
    }
    writeFileSync(join(consumer, "CODEOWNERS"), "* @owner\n");
    mkdirSync(join(consumer, ".claude"), { recursive: true });
    copyFileSync(
      join(consumer, "node_modules/@vworlds/vmethod/templates/claude-settings.json"),
      join(consumer, ".claude/settings.json")
    );
    const output = run(cli, ["check"], consumer, env);
    const expectedWarnings = ["sol", "astra", "sonnet", "glm", "big-pickle"]
      .map((family) => `WARN models.yaml: ${family} has no price; delivery usd is null`)
      .concat([
        "WARN vmethod is not on PATH; write it with npm exec --no -- vmethod init --launcher",
      ])
      .join("\n");
    if (output.trim() !== expectedWarnings) {
      throw new Error(`Unexpected check output: ${output}`);
    }
    copyFileSync(join(repo, "test/fixtures/diagram.md"), join(consumer, "diagram.md"));
    run(cli, ["check-markdown", "diagram.md"], consumer, env);
    const pkg = JSON.parse(
      readFileSync(join(consumer, "node_modules/@vworlds/vmethod/package.json"), "utf8")
    );
    const version = run(cli, ["version"], consumer, env);
    if (!version.includes(`vmethod ${pkg.version}`)) {
      throw new Error("Bundled version differs from packed package");
    }
    // The per-machine launcher resolves the consumer's own install with no npm exec.
    const launcherBin = join(temp, "launcher-bin");
    run(cli, ["init", "--launcher", launcherBin], consumer, env);
    const throughLauncher = run(join(launcherBin, "vmethod"), ["version"], consumer, env);
    if (!throughLauncher.includes(`vmethod ${pkg.version}`)) {
      throw new Error("Launcher did not resolve the consumer checkout's own installation");
    }
    if (!readFileSync(join(consumer, "package.json")).equals(originalPackage)) {
      throw new Error("Smoke unexpectedly modified consumer package.json");
    }
    console.log("Tarball smoke passed (README adoption; Mermaid 12.1.0, jsdom 24; no git/gh).");
    return output;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smoke();
}
