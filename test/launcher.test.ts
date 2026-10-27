import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { expect, test } from "vitest";
import { installLauncher, launcherDir } from "../src/init.js";
import { launcher, launcherMark } from "../src/registry.js";
import { launcherReport } from "../src/check.js";
import { runChild } from "./child-process.js";
import { fixture, validProject } from "./helpers.js";

const nodeBin = dirname(process.execPath);
let gitBin: string | undefined;
function gitDirectory(): string {
  const found = (gitBin ??= (() => {
    const result = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8", timeout: 2000 });
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error("Launcher resolution tests need a real git");
    }
    return dirname(result.stdout.trim());
  })());
  return found;
}

/** The install the launcher must exec: it records its cwd and the exact argv received. */
const recorderSource =
  `import { writeFileSync } from "node:fs";\n` +
  `writeFileSync(process.env.RECORDER_FILE, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), file: import.meta.filename }));\n`;

/** One repository per checkout; a real repository is the only discovery input. */
function checkout(name: string): string {
  const root = fixture();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, type: "module" }));
  execFileSync("git", ["init", "-q"], { cwd: root, timeout: 3000 });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "add", "-A"], {
    cwd: root,
    timeout: 3000,
  });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "init"], {
    cwd: root,
    timeout: 3000,
  });
  return root;
}

function recorderInstall(root: string): void {
  const dir = join(root, "node_modules/.bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vmethod"), `#!${process.execPath}\n${recorderSource}`);
  chmodSync(join(dir, "vmethod"), 0o755);
}

function selfHostInstall(root: string): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/vmethod.mjs"), recorderSource);
  chmodSync(join(root, "dist/vmethod.mjs"), 0o755);
}

function runLauncher(
  launcherPath: string,
  cwd: string,
  env: Record<string, string>,
  args: string[] = []
) {
  return runChild("/bin/sh", [launcherPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 2000,
  });
}

test("the launcher resolves the checkout a worktree command runs in", () => {
  const main = checkout("example/consumer");
  recorderInstall(main);
  const worktree = join(main, ".worktrees/tree with spaces");
  execFileSync("git", ["worktree", "add", worktree, "HEAD"], { cwd: main, timeout: 3000 });
  // worker start prepares each task worktree's own installation; npm never links
  // a package's own bin, so vmethod's own worktrees carry dist instead.
  recorderInstall(worktree);
  const cwd = join(worktree, "nested");
  mkdirSync(cwd);
  const bin = fixture();
  installLauncher(bin);
  const launcherPath = join(bin, "vmethod");
  const record = join(bin, "record.json");
  const result = runLauncher(
    launcherPath,
    cwd,
    { PATH: [bin, gitDirectory(), nodeBin].join(":"), RECORDER_FILE: record },
    ["board", "status", "--fix"]
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
    cwd: realpathSync(cwd),
    argv: ["board", "status", "--fix"],
    file: join(realpathSync(worktree), "node_modules/.bin/vmethod"),
  });
  rmSync(join(worktree, "node_modules/.bin/vmethod"));
  const absent = runLauncher(launcherPath, cwd, {
    PATH: [bin, gitDirectory(), nodeBin].join(":"),
    RECORDER_FILE: record,
  });
  expect(absent.status).toBe(2);
  expect(absent.stderr).toContain("run npm ci");
}, 4000);

test("in vmethod's own checkout the launcher runs the build output, with no linked bin", () => {
  const own = checkout("@vworlds/vmethod");
  selfHostInstall(own);
  const bin = fixture();
  installLauncher(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const record = join(bin, "record.json");
  const result = runLauncher(
    join(bin, "vmethod"),
    own,
    { PATH: [bin, gitDirectory(), nodeBin].join(":"), RECORDER_FILE: record },
    ["version"]
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
    cwd: realpathSync(own),
    argv: ["version"],
    file: join(realpathSync(own), "dist/vmethod.mjs"),
  });
  // The self-host branch is keyed on the package name; the linked bin plays no part.
  expect(existsSync(join(own, "node_modules/.bin/vmethod"))).toBe(false);
}, 4000);

test("the launcher refuses with the stub message when there is no checkout or no install", () => {
  const bin = fixture();
  installLauncher(bin);
  const launcherPath = join(bin, "vmethod");
  const consumer = checkout("example/consumer");
  const noInstall = runLauncher(launcherPath, consumer, {
    PATH: [bin, gitDirectory(), nodeBin].join(":"),
  });
  expect(noInstall.status).toBe(2);
  expect(noInstall.stderr).toContain(
    "run npm ci (set VMETHOD_ROOT when no repository is available)"
  );
  const own = checkout("@vworlds/vmethod");
  const noBuild = runLauncher(launcherPath, own, {
    PATH: [bin, gitDirectory(), nodeBin].join(":"),
  });
  expect(noBuild.status).toBe(2);
  expect(noBuild.stderr).toContain("run npm ci");
  // Outside any repository: discovery fails with today's stub message before exec.
  const outside = runLauncher(launcherPath, fixture(), {
    PATH: [bin, gitDirectory(), nodeBin].join(":"),
  });
  expect(outside.status).toBe(2);
  expect(outside.stderr).toContain("git could not find a repository; set VMETHOD_ROOT");
  expect(outside.stderr).toContain("run npm ci");
}, 4000);

test("VMETHOD_ROOT takes precedence over the current repository and works without git", () => {
  const here = checkout("example/here");
  recorderInstall(here);
  const target = checkout("example/target");
  recorderInstall(target);
  const bin = fixture();
  installLauncher(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const record = join(bin, "record.json");
  const withGit = runLauncher(
    join(bin, "vmethod"),
    here,
    { PATH: [bin, gitDirectory(), nodeBin].join(":"), VMETHOD_ROOT: target, RECORDER_FILE: record },
    ["read", "pr", "304", "$(touch should-not-exist)", "a; echo bad", "with spaces"]
  );
  expect(withGit.status, withGit.stderr).toBe(0);
  expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
    cwd: realpathSync(here),
    argv: ["read", "pr", "304", "$(touch should-not-exist)", "a; echo bad", "with spaces"],
    file: join(realpathSync(target), "node_modules/.bin/vmethod"),
  });
  const gitless = runLauncher(join(bin, "vmethod"), here, {
    PATH: bin,
    VMETHOD_ROOT: target,
    RECORDER_FILE: record,
  });
  expect(gitless.status, gitless.stderr).toBe(0);
  expect(JSON.parse(readFileSync(record, "utf8")).file).toBe(
    join(realpathSync(target), "node_modules/.bin/vmethod")
  );
  expect(existsSync(join(here, "should-not-exist"))).toBe(false);
}, 4000);

test("init --launcher writes mode 755, refuses a foreign file and replaces an older launcher", () => {
  const dir = fixture();
  const target = join(dir, "vmethod");
  expect(installLauncher(dir)).toBe(`Wrote ${target}`);
  expect(readFileSync(target, "utf8")).toBe(launcher());
  expect(statSync(target).mode & 0o777).toBe(0o755);
  // An older launcher carries the marker, so it is replaced without asking.
  writeFileSync(target, "#!/bin/sh\n# vmethod launcher\nold-resolution\n");
  expect(installLauncher(dir)).toBe(`Wrote ${target}`);
  expect(readFileSync(target, "utf8")).toBe(launcher());
  // A file without the marker must not be clobbered.
  const foreign = "#!/bin/sh\necho custom\n";
  writeFileSync(target, foreign);
  expect(() => installLauncher(dir)).toThrow(
    "Refusing to overwrite a file that is not a vmethod launcher"
  );
  expect(readFileSync(target, "utf8")).toBe(foreign);
  // Neither is a directory at the same path.
  rmSync(target);
  mkdirSync(target);
  expect(() => installLauncher(dir)).toThrow("not a vmethod launcher");
  rmSync(target, { recursive: true });
  const other = join(dir, "other");
  writeFileSync(other, launcher());
  symlinkSync(other, target);
  expect(() => installLauncher(dir)).toThrow("not a vmethod launcher");
  expect(readFileSync(other, "utf8")).toBe(launcher());
  rmSync(target);
  symlinkSync(join(dir, "missing"), target);
  expect(() => installLauncher(dir)).toThrow("not a vmethod launcher");
  expect(existsSync(join(dir, "missing"))).toBe(false);
}, 4000);

test("init --launcher targets ~/.local/bin by default and expands home-relative dirs", () => {
  // vitest redirects HOME, so the default stays inside the test sandbox.
  expect(launcherDir()).toBe(join(homedir(), ".local/bin"));
  expect(launcherDir("~")).toBe(homedir());
  expect(launcherDir("~/bin")).toBe(join(homedir(), "bin"));
  expect(installLauncher(launcherDir())).toBe(`Wrote ${join(homedir(), ".local/bin/vmethod")}`);
  expect(readFileSync(join(homedir(), ".local/bin/vmethod"), "utf8")).toBe(launcher());
  expect(readFileSync(join(homedir(), ".local/bin/vmethod"), "utf8")).toContain(launcherMark);
});

test("check reports whether the vmethod on PATH is this launcher", () => {
  const bin = fixture();
  expect(launcherReport({ PATH: bin })).toBe(
    "WARN vmethod is not on PATH; write it with npm exec --no -- vmethod init --launcher"
  );
  // A foreign file is what a shell would run; the report names that entry, not a later one.
  writeFileSync(join(bin, "vmethod"), "#!/bin/sh\necho custom\n");
  chmodSync(join(bin, "vmethod"), 0o755);
  expect(launcherReport({ PATH: bin })).toBe(
    `WARN vmethod on PATH is ${join(bin, "vmethod")}, not a vmethod launcher; ` +
      `remove or rename it, then run vmethod init --launcher ${bin}`
  );
  rmSync(join(bin, "vmethod"));
  expect(installLauncher(bin)).toBe(`Wrote ${join(bin, "vmethod")}`);
  expect(launcherReport({ PATH: bin })).toBe(
    `vmethod on PATH is the vmethod launcher: ${join(bin, "vmethod")}`
  );
  // A symlink to the launcher is still the launcher.
  const linked = fixture();
  symlinkSync(join(bin, "vmethod"), join(linked, "vmethod"));
  expect(launcherReport({ PATH: linked })).toBe(
    `vmethod on PATH is the vmethod launcher: ${join(linked, "vmethod")}`
  );
  // A directory named vmethod cannot execute; the next PATH entry decides.
  const directory = fixture();
  mkdirSync(join(directory, "vmethod"));
  expect(launcherReport({ PATH: `${directory}:${linked}` })).toBe(
    `vmethod on PATH is the vmethod launcher: ${join(linked, "vmethod")}`
  );
  expect(launcherReport({ PATH: directory })).toBe(
    "WARN vmethod is not on PATH; write it with npm exec --no -- vmethod init --launcher"
  );
  const nonExecutable = fixture();
  writeFileSync(join(nonExecutable, "vmethod"), launcher(), { mode: 0o644 });
  expect(launcherReport({ PATH: `${nonExecutable}:${bin}` })).toBe(
    `vmethod on PATH is the vmethod launcher: ${join(bin, "vmethod")}`
  );
  // Without a PATH at all there is nothing to find.
  expect(launcherReport({})).toBe(
    "WARN vmethod is not on PATH; write it with npm exec --no -- vmethod init --launcher"
  );
}, 4000);

test("self-host detection parses the root package name rather than nested names", () => {
  const root = checkout("example/consumer");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "example/consumer",
      type: "module",
      nested: { name: "@vworlds/vmethod" },
    })
  );
  recorderInstall(root);
  selfHostInstall(root);
  const bin = fixture();
  installLauncher(bin);
  const record = join(bin, "record.json");
  const result = runLauncher(join(bin, "vmethod"), root, {
    PATH: [bin, gitDirectory(), nodeBin].join(":"),
    RECORDER_FILE: record,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(record, "utf8")).file).toBe(
    join(realpathSync(root), "node_modules/.bin/vmethod")
  );
});

test("the built init CLI installs outside a repository, defaults to HOME and refuses bad arguments", () => {
  const root = fixture();
  const home = join(root, "home");
  const cli = resolve("dist/vmethod.mjs");
  const run = (args: string[]) =>
    runChild(process.execPath, [cli, "init", ...args], {
      cwd: root,
      env: { HOME: home },
      encoding: "utf8",
      timeout: 3000,
    });
  const installed = run(["--launcher"]);
  expect(installed.status, installed.stderr).toBe(0);
  const target = join(home, ".local/bin/vmethod");
  expect(readFileSync(target, "utf8")).toBe(launcher());
  expect(statSync(target).mode & 0o777).toBe(0o755);
  expect(run(["--launcher", join(root, "custom bin")]).status).toBe(0);
  const checked = runChild(process.execPath, [cli, "check"], {
    cwd: root,
    env: { VMETHOD_ROOT: validProject(), PATH: dirname(target) },
    encoding: "utf8",
    timeout: 3000,
  });
  expect(checked.status, checked.stderr).toBe(0);
  expect(checked.stdout).toContain(`vmethod on PATH is the vmethod launcher: ${target}`);
  for (const args of [
    ["--launcher", "a", "b"],
    ["--launcher", "--dry-run"],
    ["--dry-run", "--launcher"],
  ]) {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: vmethod init");
  }
  writeFileSync(target, "foreign\n");
  expect(run(["--launcher"]).status).toBe(1);
  expect(readFileSync(target, "utf8")).toBe("foreign\n");
}, 15000);
