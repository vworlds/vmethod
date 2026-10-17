import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { beforeAll, expect, test } from "vitest";
import { fixture, validProject } from "./helpers.js";
import { actor, item, people } from "./gateway/helpers.js";
import { stringify } from "yaml";

const require = createRequire(import.meta.url);
let bundle: string;
beforeAll(async () => {
  bundle = join(fixture(), "vmethod.mjs");
  await build({
    entryPoints: ["src/cli/main.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    splitting: false,
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
    },
    define: { __VERSION__: '"test-old"', __BOARD_VERSION__: "1" },
  });
});

function cliFixture() {
  const root = validProject();
  const cli = join(root, "vmethod.mjs");
  copyFileSync(bundle, cli);
  const run = (args: string[], extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [...extra, cli, ...args], {
      cwd: root,
      env: { VMETHOD_ROOT: root, ...env },
      encoding: "utf8",
      timeout: 5000,
    });
  return { root, cli, run };
}

function peers(root: string) {
  const mermaid = join(root, "node_modules/mermaid");
  const jsdom = join(root, "node_modules/jsdom");
  mkdirSync(mermaid, { recursive: true });
  mkdirSync(jsdom, { recursive: true });
  writeFileSync(
    join(mermaid, "package.json"),
    '{"name":"mermaid","version":"12.1.0","type":"module","main":"index.mjs"}'
  );
  writeFileSync(
    join(mermaid, "index.mjs"),
    `export default { initialize() {}, async parse(text) { if (text.includes('BROKEN')) { const e = new Error('Parse error'); e.hash = {loc: {first_line: 2}}; throw e; } if (!text.includes('-->')) throw new Error('Unexpected diagram fixture'); } };`
  );
  writeFileSync(join(jsdom, "package.json"), '{"name":"jsdom","main":"index.cjs"}');
  writeFileSync(
    join(jsdom, "index.cjs"),
    "exports.JSDOM = class { window = { document: {}, close() {} }; };"
  );
}

test("Markdown CLI ports missing-peer, broken/fixed diagram, ordinary GFM and unclosed-fence cases with stable exits", () => {
  const f = cliFixture();
  const file = join(f.root, "body.md");
  writeFileSync(file, "# Ordinary GFM\n\n- [x] complete\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  const missing = f.run(["check-markdown", file]);
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain(
    `check-markdown: dependencies missing in ${f.root}; run HUSKY=0 npm ci there`
  );
  expect(missing.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|at ModuleJob/);
  peers(f.root);
  expect(f.run(["check-markdown", file]).status).toBe(0);
  for (const source of ["graph TD; A-->B", "flowchart LR\nA-->B"]) {
    writeFileSync(file, `# Diagram\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`);
    expect(f.run(["check-markdown", file]).status).toBe(0);
  }
  writeFileSync(file, "```mermaid\ngraph TD\nBROKEN\n```");
  const broken = f.run(["check-markdown", file]);
  expect(broken.status).toBe(1);
  expect(broken.stderr).toContain("Mermaid block 1 (fence line 1, diagram line 2): Parse error");
  writeFileSync(file, "```\nunclosed");
  const fence = f.run(["check-markdown", file]);
  expect(fence.status).toBe(1);
  expect(fence.stderr).toContain("Unclosed code fence opened at line 1");
  expect(f.run(["check-markdown", join(f.root, "missing")]).status).toBe(2);
});

test("Markdown CLI refuses Mermaid version drift without networking", () => {
  const f = cliFixture();
  peers(f.root);
  writeFileSync(
    join(f.root, "node_modules/mermaid/package.json"),
    '{"name":"mermaid","version":"12.0.0","main":"index.mjs"}'
  );
  const file = join(f.root, "body.md");
  writeFileSync(file, "```mermaid\ngraph TD; A-->B\n```");
  const result = f.run(["check-markdown", file]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("mermaid must equal 12.1.0");
});

test.each([
  [24, require.resolve("jsdom24/package.json")],
  [27, require.resolve("jsdom/package.json")],
])(
  "Markdown CLI parses real Mermaid with jsdom %i",
  (major, jsdomPackage) => {
    const root = fixture();
    const cli = join(root, "vmethod.mjs");
    copyFileSync(bundle, cli);
    mkdirSync(join(root, "node_modules"));
    symlinkSync(dirname(jsdomPackage), join(root, "node_modules/jsdom"));
    symlinkSync(
      dirname(require.resolve("mermaid/package.json")),
      join(root, "node_modules/mermaid")
    );
    expect(JSON.parse(readFileSync(jsdomPackage, "utf8")).version).toMatch(
      new RegExp(`^${major}\\.`)
    );
    const file = join(root, "body.md");
    const run = () =>
      spawnSync(process.execPath, [cli, "check-markdown", file], {
        cwd: root,
        env: { VMETHOD_ROOT: root },
        encoding: "utf8",
        timeout: 15000,
      });
    copyFileSync("test/fixtures/diagram.md", file);
    const valid = run();
    expect(valid.status, valid.stderr).toBe(0);
    writeFileSync(file, "```mermaid\ngraph TD\nA -->\n```");
    const broken = run();
    expect(broken.status, broken.stderr).toBe(1);
    expect(broken.stderr).toContain("Mermaid block 1");
    writeFileSync(file, "# Ordinary GFM\n\n- [x] complete\n");
    expect(run().status).toBe(0);
    writeFileSync(file, "```\nunclosed");
    expect(run().status).toBe(1);
  },
  45000
);

test("start-task child uses PATH fakes, installs once, and continues old bundled code after package replacement", () => {
  const f = cliFixture();
  writeFileSync(join(f.root, "people.yaml"), stringify(people));
  const config = readFileSync(join(f.root, "vmethod.yaml"), "utf8").replace(
    "mainCheckout: /replace/with/consumer/checkout",
    `mainCheckout: ${f.root}`
  );
  writeFileSync(join(f.root, "vmethod.yaml"), config);
  const target = join(f.root, ".worktrees/7-task");
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const steps = join(f.root, "git-steps.json");
  const git = [
    {
      args: [
        "-c",
        "credential.helper=",
        "-c",
        'credential.helper=!f() { printf "%s\\n" "username=x-access-token" "password=$VMETHOD_GIT_TOKEN"; }; f',
        "fetch",
        "-q",
        "https://github.com/example/project.git",
        "+refs/heads/pack/x:refs/remotes/origin/pack/x",
        "+refs/heads/7-task:refs/remotes/origin/7-task",
      ],
    },
    { args: ["for-each-ref", "--format=%(refname)", "refs/heads/7-task"] },
    {
      args: ["worktree", "add", "-b", "7-task", target, "refs/remotes/origin/7-task"],
      create: true,
    },
    { args: ["rev-parse", "--show-toplevel"], output: target },
    { args: ["rev-parse", "--git-common-dir"], output: join(f.root, ".git") },
    {
      args: ["rev-parse", "--git-dir"],
      output: join(f.root, ".git/worktrees/7-task"),
    },
    { args: ["rev-parse", "--abbrev-ref", "HEAD"], output: "7-task\n" },
    { args: ["status", "--porcelain"] },
    { args: ["branch", "-q", "--set-upstream-to=origin/7-task"] },
    { args: ["rev-list", "--count", "origin/pack/x..HEAD"], output: "1" },
    { args: ["rev-list", "--count", "HEAD..origin/pack/x"], output: "2" },
  ];
  writeFileSync(steps, JSON.stringify(git));
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}\nimport fs from 'node:fs'; import assert from 'node:assert/strict'; const file=${JSON.stringify(steps)}; const steps=JSON.parse(fs.readFileSync(file)); const step=steps.shift(); assert.ok(step, 'Unexpected git call'); assert.deepEqual(process.argv.slice(2), step.args); fs.writeFileSync(file, JSON.stringify(steps)); if(step.create) { fs.mkdirSync(${JSON.stringify(target)}, {recursive:true}); fs.writeFileSync(${JSON.stringify(join(target, "package-lock.json"))}, 'lock-v1'); } process.stdout.write(step.output ?? '');`,
    { mode: 0o755 }
  );
  const installs = join(f.root, "installs");
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}\nimport fs from 'node:fs'; import assert from 'node:assert/strict'; assert.deepEqual(process.argv.slice(2), ['ci']); assert.equal(process.cwd(), ${JSON.stringify(target)}); assert.equal(process.env.HUSKY,'0'); assert.equal(process.env.EXAMPLE_GITHUB_TOKEN, undefined); fs.appendFileSync(${JSON.stringify(installs)}, 'ci\\n'); fs.writeFileSync(${JSON.stringify(f.cli)}, 'throw new Error("NEW VERSION WAS LOADED");');`,
    { mode: 0o755 }
  );
  const preload = join(f.root, "offline.mjs");
  const response = {
    data: {
      repository: {
        pullRequest: item({
          author: actor(1),
          headRefName: "7-task",
          baseRefName: "pack/x",
          state: "OPEN",
          headRepository: { nameWithOwner: "example/project" },
        }),
      },
    },
  };
  writeFileSync(
    preload,
    `import assert from 'node:assert/strict'; let calls=0; globalThis.fetch=async (url, init) => { assert.equal(String(url),'https://api.github.com/graphql'); assert.equal(++calls,1); const payload=JSON.parse(init.body); assert.equal(payload.variables.number,3); assert.ok(payload.query.includes('headRefName')); return new Response(${JSON.stringify(JSON.stringify(response))}); }; process.on('exit',()=>assert.equal(calls,1));`
  );
  const env = {
    PATH: bin,
    EXAMPLE_GITHUB_TOKEN: "fake-token",
    VMETHOD_TASK_PR: "3",
  };
  const run = () => f.run(["start-task", "3"], ["--import", preload], env);
  const first = run();
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain("ready. Next: scripts/agent/read-pr.sh 3");
  expect(first.stderr).toContain("branch 7-task keeps its 1 commit(s); 2 behind origin/pack/x");
  expect(readFileSync(f.cli, "utf8")).toContain("NEW VERSION WAS LOADED");
  expect(existsSync(join(target, "node_modules/.package-lock.sha"))).toBe(true);
  expect(readFileSync(steps, "utf8")).toBe("[]");
  expect(readFileSync(installs, "utf8")).toBe("ci\n");
  // A subsequent run loads the new version, while the first run completed entirely on the old one.
  expect(f.run(["version"]).stderr).toContain("NEW VERSION WAS LOADED");
  copyFileSync(bundle, f.cli);
  writeFileSync(steps, JSON.stringify([git[0], ...git.slice(3)]));
  const second = run();
  expect(second.status, second.stderr).toBe(0);
  expect(second.stderr).toContain("dependencies already match package-lock.json");
  expect(readFileSync(installs, "utf8")).toBe("ci\n");
  const stamp = readFileSync(join(target, "node_modules/.package-lock.sha"), "utf8");
  writeFileSync(join(target, "package-lock.json"), "lock-v2");
  writeFileSync(join(bin, "npm"), `#!${process.execPath}\nprocess.exit(7);`, {
    mode: 0o755,
  });
  writeFileSync(steps, JSON.stringify([git[0], ...git.slice(3)]));
  const failedInstall = run();
  expect(failedInstall.status).toBe(1);
  expect(failedInstall.stdout).not.toContain("ready.");
  expect(readFileSync(join(target, "node_modules/.package-lock.sha"), "utf8")).toBe(stamp);
});

test("stubs run from a nested directory resolve the repository root, never the cwd", () => {
  const f = cliFixture();
  peers(f.root);
  // The stub execs the pinned CLI from the resolved root's node_modules.
  mkdirSync(join(f.root, "node_modules/.bin"), { recursive: true });
  copyFileSync(bundle, join(f.root, "node_modules/.bin/vmethod"));
  chmodSync(join(f.root, "node_modules/.bin/vmethod"), 0o755);
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args === "rev-parse --show-toplevel") {
  process.stdout.write(${JSON.stringify(f.root)} + "\\n");
} else if (args === "rev-parse --abbrev-ref HEAD") {
  process.stdout.write("7-worker-verbs\\n");
} else {
  process.exit(1);
}
`,
    { mode: 0o755 }
  );
  const nested = join(f.root, "packages/lib/deep");
  mkdirSync(nested, { recursive: true });
  const stub = (name: string, args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync("/bin/sh", [join(f.root, "scripts/agent", name), ...args], {
      cwd: nested,
      env,
      encoding: "utf8",
      timeout: 10000,
    });

  // Git discovery: both the stub and the CLI resolve the root via git,
  // with no VMETHOD_ROOT set, from a directory far below the root.
  const gitEnv = {
    PATH: `${bin}:${dirname(process.execPath)}`,
    VMETHOD_TASK_PR: "3",
  };
  const push = stub("push.sh", [], gitEnv);
  expect(push.status, push.stderr).toBe(1);
  expect(push.stderr).toContain("Missing configured GitHub token environment variable");
  expect(push.stderr).not.toContain("ENOENT");
  const config = stub("config.sh", ["get", "repo"], gitEnv);
  expect(config.status, config.stderr).toBe(0);
  expect(config.stdout).toBe("example/project\n");
  writeFileSync(join(nested, "body.md"), "# Ordinary GFM\n");
  expect(stub("check-markdown.sh", ["body.md"], gitEnv).status).toBe(0);
  writeFileSync(join(nested, "body.md"), "```\nunclosed");
  const fence = stub("check-markdown.sh", ["body.md"], gitEnv);
  expect(fence.status).toBe(1);
  expect(fence.stderr).toContain("Unclosed code fence opened at line 1");

  // VMETHOD_ROOT when git is unavailable: only Node is on PATH.
  const nodeOnly = join(f.root, "node-only");
  mkdirSync(nodeOnly);
  symlinkSync(process.execPath, join(nodeOnly, "node"));
  const fallback = stub("config.sh", ["get", "repo"], {
    PATH: nodeOnly,
    VMETHOD_ROOT: f.root,
  });
  expect(fallback.status, fallback.stderr).toBe(0);
  expect(fallback.stdout).toBe("example/project\n");
});
