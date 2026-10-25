import { runChild } from "./child-process.js";
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
import { parse, stringify } from "yaml";
import recorded from "./fixtures/github/learnings-recorded.json" with { type: "json" };
import { stub } from "../src/registry.js";

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

// Cold CLI ~0.2–0.4 s; start-task also launches Node-backed git/npm fakes.
function cliFixture(timeout = 3000) {
  const root = validProject();
  const cli = join(root, "vmethod.mjs");
  copyFileSync(bundle, cli);
  const run = (args: string[], extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    runChild(process.execPath, [...extra, cli, ...args], {
      cwd: root,
      env: { VMETHOD_ROOT: root, ...env },
      encoding: "utf8",
      timeout,
    });
  return { root, cli, run };
}

test("board migrate failures print a JSON error and exit nonzero", () => {
  const f = cliFixture();
  const result = f.run(["board", "migrate"], [], { VMETHOD_ROLE: "orchestrator" });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: expect.any(String) });
});

test("annotation batch failures reach the real CLI with a summary and non-zero exit", () => {
  const f = cliFixture(10000);
  writeFileSync(join(f.root, "people.yaml"), stringify(people));
  const configPath = join(f.root, "vmethod.yaml");
  writeFileSync(
    configPath,
    stringify({ ...parse(readFileSync(configPath, "utf8")), learningsPrivacy: "public" })
  );
  mkdirSync(join(f.root, ".vmethod"));
  const record = {
    date: "2026-10-19",
    repo: "example/project",
    task: "test",
    kind: "tooling",
    segments: [{ family: "glm", model: "fake/glm", rounds: [1], why: "start" }],
    points_open: 3,
    points_final: 3,
    rounds: 1,
    round_causes: [],
    outcome: "merged",
    prompt_defects: [],
    stalls: [],
    findings: [],
    notes: "",
  };
  writeFileSync(
    join(f.root, ".vmethod/model-log.jsonl"),
    [31, 32].map((pr) => JSON.stringify({ ...record, pr })).join("\n") + "\n"
  );
  const preload = join(f.root, "annotation-failure.mjs");
  writeFileSync(
    preload,
    `globalThis.fetch = async (url,init) => {
    if (String(url) !== 'https://api.github.com/graphql') throw new Error('Unexpected URL: '+url);
    const body = JSON.parse(init.body);
    if (body.query.includes('GatewayIdentity')) return Response.json({data:{viewer:${JSON.stringify(actor(2))}}});
    return Response.json({errors:[{message:'fixture bundle unavailable'}]});
  };`
  );
  const result = f.run(["learnings", "annotate"], ["--import", preload], {
    VMETHOD_ROLE: "orchestrator",
    EXAMPLE_GITHUB_TOKEN: "fake-token",
    XDG_STATE_HOME: join(f.root, "state"),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("0 annotated, 2 failed (#31, #32)");
  expect(result.stderr).toContain("#31:");
  expect(result.stderr).toContain("#32:");
});

test("generated stub uses cached worktree context through the CLI; explicit task PR wins", () => {
  const f = cliFixture();
  writeFileSync(join(f.root, "people.yaml"), stringify(people));
  const preload = join(f.root, "worker-identity.mjs");
  writeFileSync(
    preload,
    `import assert from 'node:assert/strict';
    let calls=0;
    globalThis.fetch=async (url, init)=> {
      assert.equal(String(url),'https://api.github.com/graphql');
      assert.equal(init.method,'POST');
      assert.equal(++calls,1);
      assert.equal(JSON.parse(init.body).query,'query GatewayIdentity { viewer { databaseId login __typename } }');
      return Response.json({data:{viewer:${JSON.stringify(actor(1))}}});
    };
    if (!process.argv[1].endsWith('/git')) process.on('exit',()=>assert.equal(calls,1));`
  );
  const bin = join(f.root, "fake-bin");
  mkdirSync(bin);
  const git = join(bin, "git");
  writeFileSync(
    git,
    `#!${process.execPath}
const command = process.argv.slice(2).join(' ');
const responses = {
  'rev-parse --git-dir': '.git/worktrees/task',
  'rev-parse --git-common-dir': '.git',
  'rev-parse --abbrev-ref HEAD': '64-task',
  'rev-parse HEAD': '${"a".repeat(40)}',
};
if (!(command in responses)) throw new Error('Unexpected git command: ' + command);
console.log(responses[command]);
`
  );
  chmodSync(git, 0o755);
  mkdirSync(join(f.root, ".tmp"));
  writeFileSync(
    join(f.root, ".tmp", "worker-context.json"),
    JSON.stringify({ branch: "64-task", head: "a".repeat(40), taskPr: 65 })
  );
  mkdirSync(join(f.root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(f.cli, join(f.root, "node_modules", ".bin", "vmethod"));
  chmodSync(f.cli, 0o755);
  // The generated stub delegates inference to the same CLI used by direct invocations.
  const script = join(f.root, "post.sh");
  writeFileSync(script, stub("post"));
  const run = (env: NodeJS.ProcessEnv) =>
    runChild("/bin/sh", [script, "65", ".tmp/must-not-exist.md"], {
      cwd: f.root,
      env: {
        VMETHOD_ROOT: f.root,
        PATH: `${bin}:${dirname(process.execPath)}`,
        EXAMPLE_GITHUB_TOKEN: "fake-token",
        NODE_OPTIONS: `--import=${preload}`,
        ...env,
      },
      encoding: "utf8",
      timeout: 3000,
    });
  const inferred = run({});
  expect(inferred.status, inferred.stderr).toBe(1);
  expect(inferred.stderr).toContain("ENOENT");
  expect(inferred.stderr).not.toContain("own taskPr");
  const explicit = run({ VMETHOD_TASK_PR: "90" });
  expect(explicit.status, explicit.stderr).toBe(1);
  expect(explicit.stderr).toContain("own taskPr");
  expect(explicit.stderr).not.toContain("ENOENT");
}, 10000);

test.each([0, 1, 2, 3])(
  "wait-checks CLI preserves verdict exit %s and prints it last without real networking",
  (code) => {
    const f = cliFixture();
    writeFileSync(join(f.root, "people.yaml"), stringify(people));
    const sha = "a".repeat(40);
    const pull = {
      state: "open",
      user: { login: "worker", id: 102, type: "User" },
      head: { sha, ref: "3-task", repo: { full_name: "example/project" } },
      base: { sha: "b".repeat(40), ref: "dev", repo: { full_name: "example/project" } },
      mergeable: code !== 3,
      mergeable_state: code === 3 ? "dirty" : "clean",
    };
    const runs = {
      check_runs:
        code >= 2
          ? []
          : [
              {
                id: 10,
                head_sha: sha,
                name: "ci",
                app: { id: 909 },
                status: "completed",
                conclusion: code === 0 ? "success" : "failure",
              },
            ],
    };
    const responses = [pull, runs, ...(code < 2 ? [pull] : [])];
    const paths = [
      "/pulls/3",
      `/commits/${sha}/check-runs?filter=all&per_page=100&page=1`,
      ...(code < 2 ? ["/pulls/3"] : []),
    ];
    const preload = join(f.root, "offline.mjs");
    writeFileSync(
      preload,
      `import assert from 'node:assert/strict'; let identities=0; const responses=${JSON.stringify(responses)}; const paths=${JSON.stringify(paths)}; globalThis.fetch=async (url, init)=> { assert.equal(init.redirect,'error'); if (String(url)==='https://api.github.com/graphql') { assert.equal(++identities,1); assert.equal(init.method,'POST'); assert.equal(JSON.parse(init.body).query,'query GatewayIdentity { viewer { databaseId login __typename } }'); return Response.json({data:{viewer:${JSON.stringify(actor(1))}}}); } assert.equal(String(url), 'https://api.github.com/repos/example/project'+paths.shift()); assert.equal(init.method,'GET'); assert.ok(responses.length); return new Response(JSON.stringify(responses.shift())); }; process.on('exit',()=>{ assert.equal(identities,1); assert.equal(responses.length,0); assert.equal(paths.length,0); });`
    );
    const result = f.run(["wait-checks", "3", "0"], ["--import", preload], {
      VMETHOD_TASK_PR: "3",
      EXAMPLE_GITHUB_TOKEN: "fake-token",
    });
    expect(result.status, result.stderr).toBe(code);
    expect(result.stdout.trim().split("\n").at(-1)).toMatch(/^checks:/);
    expect(result.stderr).toBe("");
  },
  5000
);

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

test("check --online reports both credential identities through the built CLI", () => {
  const f = cliFixture();
  // Captured viewer (learnings-PROVENANCE.md), projected to the requested fields.
  const viewer = {
    databaseId: recorded.viewer.databaseId,
    login: recorded.viewer.login,
    __typename: recorded.viewer.__typename,
  };
  writeFileSync(
    join(f.root, "people.yaml"),
    stringify([
      {
        login: viewer.login,
        id: viewer.databaseId,
        type: viewer.__typename,
        role: "orchestrator",
        repos: ["example/project"],
      },
      people[1],
    ])
  );
  const preload = join(f.root, "online-check.mjs");
  writeFileSync(
    preload,
    `import assert from 'node:assert/strict';
    const viewers=${JSON.stringify([viewer, actor(1)])};
    const tokens=['Bearer orchestrator-token','Bearer worker-token'];
    globalThis.fetch=async (url, init)=> {
      assert.equal(String(url),'https://api.github.com/graphql');
      assert.equal(init.method,'POST');
      assert.equal(init.headers.authorization,tokens.shift());
      assert.equal(JSON.parse(init.body).query,'query GatewayIdentity { viewer { databaseId login __typename } }');
      assert.ok(viewers.length);
      return Response.json({data:{viewer:viewers.shift()}});
    };
    process.on('exit',()=>{assert.equal(viewers.length,0);assert.equal(tokens.length,0);});`
  );
  const result = f.run(["check", "--online"], ["--import", preload], {
    EXAMPLE_GITHUB_TOKEN: "orchestrator-token",
    EXAMPLE_WORKER_GITHUB_TOKEN: "worker-token",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("credentials.githubToken: vimescmd (orchestrator)");
  expect(result.stdout).toContain("credentials.workerGithubToken: worker (worker)");
  expect(result.stdout).not.toContain("orchestrator-token");
  expect(result.stdout).not.toContain("worker-token");
}, 5000);

test("Markdown CLI reports missing peers with a stable exit", () => {
  const f = cliFixture();
  const file = join(f.root, "body.md");
  writeFileSync(file, "# Ordinary GFM\n\n- [x] complete\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  const missing = f.run(["check-markdown", file]);
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain(
    `check-markdown: dependencies missing in ${f.root}; run HUSKY=0 npm ci there`
  );
  expect(missing.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|at ModuleJob/);
}, 5000);

test.each(["graph TD; A-->B", "flowchart LR\nA-->B"])(
  "Markdown CLI accepts a fixed diagram: %s",
  (source) => {
    const f = cliFixture();
    peers(f.root);
    const file = join(f.root, "body.md");
    writeFileSync(file, `# Diagram\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`);
    expect(f.run(["check-markdown", file]).status).toBe(0);
  },
  5000
);

test("Markdown CLI accepts ordinary GFM", () => {
  const f = cliFixture();
  peers(f.root);
  const file = join(f.root, "body.md");
  writeFileSync(file, "# Ordinary GFM\n\n- [x] complete\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  expect(f.run(["check-markdown", file]).status).toBe(0);
}, 5000);

test("Markdown CLI reports a broken diagram with a stable exit", () => {
  const f = cliFixture();
  peers(f.root);
  const file = join(f.root, "body.md");
  writeFileSync(file, "```mermaid\ngraph TD\nBROKEN\n```");
  const broken = f.run(["check-markdown", file]);
  expect(broken.status).toBe(1);
  expect(broken.stderr).toContain("Mermaid block 1 (fence line 1, diagram line 2): Parse error");
}, 5000);

test("Markdown CLI reports an unclosed fence with a stable exit", () => {
  const f = cliFixture();
  peers(f.root);
  const file = join(f.root, "body.md");
  writeFileSync(file, "```\nunclosed");
  const fence = f.run(["check-markdown", file]);
  expect(fence.status).toBe(1);
  expect(fence.stderr).toContain("Unclosed code fence opened at line 1");
}, 5000);

test("Markdown CLI reports a missing file with a stable exit", () => {
  const f = cliFixture();
  peers(f.root);
  expect(f.run(["check-markdown", join(f.root, "missing")]).status).toBe(2);
}, 5000);

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
}, 5000);

const realMarkdownCases = [
  { name: "valid diagram", source: readFileSync("test/fixtures/diagram.md", "utf8"), code: 0 },
  { name: "broken diagram", source: "```mermaid\ngraph TD\nA -->\n```", code: 1 },
  { name: "ordinary GFM", source: "# Ordinary GFM\n\n- [x] complete\n", code: 0 },
  { name: "unclosed fence", source: "```\nunclosed", code: 1 },
];

test.each(
  [
    [24, require.resolve("jsdom24/package.json")],
    [27, require.resolve("jsdom/package.json")],
  ].flatMap(([major, jsdomPackage]) =>
    realMarkdownCases.map((scenario) => ({
      major,
      jsdomPackage: String(jsdomPackage),
      ...scenario,
    }))
  )
)(
  "Markdown CLI parses real Mermaid with jsdom $major: $name",
  ({ major, jsdomPackage, source, code, name }) => {
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
    writeFileSync(file, source);
    const result = runChild(process.execPath, [cli, "check-markdown", file], {
      cwd: root,
      env: { VMETHOD_ROOT: root },
      encoding: "utf8",
      timeout: 30000,
    });
    expect(result.status, result.stderr).toBe(code);
    if (name === "broken diagram") {
      expect(result.stderr).toContain("Mermaid block 1");
    }
  },
  30000
);

test.each(["auto-", ""])(
  "start-task prefix %j uses PATH fakes, installs once, and continues old bundled code after package replacement",
  (prefix) => {
    const f = cliFixture(6000);
    writeFileSync(join(f.root, "people.yaml"), stringify(people));
    const config = readFileSync(join(f.root, "vmethod.yaml"), "utf8").replace(
      "mainCheckout: /replace/with/consumer/checkout",
      `mainCheckout: ${f.root}`
    );
    writeFileSync(
      join(f.root, "vmethod.yaml"),
      config.replace("branches:", `branches:\n  worktreePrefix: ${JSON.stringify(prefix)}`)
    );
    const target = join(f.root, ".worktrees", `${prefix}7-task`);
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
      `#!${process.execPath}\nimport fs from 'node:fs'; import assert from 'node:assert/strict'; const file=${JSON.stringify(steps)}; const steps=JSON.parse(fs.readFileSync(file)); const step=steps.shift(); assert.ok(step, 'Unexpected git call'); assert.deepEqual(process.argv.slice(2), step.args); fs.writeFileSync(file, JSON.stringify(steps)); if(step.create) { fs.mkdirSync(${JSON.stringify(target)}, {recursive:true}); fs.writeFileSync(${JSON.stringify(join(target, "package.json"))}, '{"name":"example/project","version":"1.0.0"}'); fs.writeFileSync(${JSON.stringify(join(target, "package-lock.json"))}, 'lock-v1'); } process.stdout.write(step.output ?? '');`,
      { mode: 0o755 }
    );
    const installs = join(f.root, "installs");
    writeFileSync(
      join(bin, "npm"),
      `#!${process.execPath}\nimport fs from 'node:fs'; import assert from 'node:assert/strict'; const args=process.argv.slice(2); assert.ok(args.length >= 1 && args[0] === 'ci', JSON.stringify(args)); assert.equal(process.cwd(), ${JSON.stringify(target)}); assert.equal(process.env.HUSKY,'0'); assert.equal(process.env.EXAMPLE_GITHUB_TOKEN, undefined); if (args.length === 1) { fs.appendFileSync(${JSON.stringify(installs)}, 'ci\\n'); fs.writeFileSync(${JSON.stringify(f.cli)}, 'throw new Error("NEW VERSION WAS LOADED");'); } else { assert.deepEqual(args, ['ci','--dry-run','--no-audit','--no-fund','--ignore-scripts']); fs.appendFileSync(${JSON.stringify(installs)}, 'dry\\n'); }`,
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
      `import assert from 'node:assert/strict'; let calls=0; globalThis.fetch=async (url, init) => { assert.equal(String(url),'https://api.github.com/graphql'); const payload=JSON.parse(init.body); if (++calls===1) { assert.equal(payload.query,'query GatewayIdentity { viewer { databaseId login __typename } }'); return Response.json({data:{viewer:${JSON.stringify(actor(1))}}}); } assert.equal(calls,2); assert.equal(payload.variables.number,3); assert.ok(payload.query.includes('headRefName')); return new Response(${JSON.stringify(JSON.stringify(response))}); }; process.on('exit',()=>assert.equal(calls,2));`
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
    expect(first.stderr).toContain("checking lockfile sync");
    expect(readFileSync(f.cli, "utf8")).toContain("NEW VERSION WAS LOADED");
    expect(existsSync(join(target, "node_modules/.package-lock.sha"))).toBe(true);
    expect(readFileSync(steps, "utf8")).toBe("[]");
    expect(readFileSync(installs, "utf8")).toBe("dry\nci\n");
    // A subsequent run loads the new version, while the first run completed entirely on the old one.
    expect(f.run(["version"]).stderr).toContain("NEW VERSION WAS LOADED");
    copyFileSync(bundle, f.cli);
    writeFileSync(steps, JSON.stringify([git[0], ...git.slice(3)]));
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toContain("dependencies already match package-lock.json");
    expect(readFileSync(installs, "utf8")).toBe("dry\nci\ndry\n");
    const stamp = readFileSync(join(target, "node_modules/.package-lock.sha"), "utf8");
    writeFileSync(join(target, "package-lock.json"), "lock-v2");
    writeFileSync(
      join(bin, "npm"),
      `#!${process.execPath}\nconst dry = process.argv.slice(2)[1] === '--dry-run'; if (dry) { process.exit(0); } process.exit(7);`,
      {
        mode: 0o755,
      }
    );
    writeFileSync(steps, JSON.stringify([git[0], ...git.slice(3)]));
    const failedInstall = run();
    expect(failedInstall.status).toBe(1);
    expect(failedInstall.stdout).not.toContain("ready.");
    expect(readFileSync(join(target, "node_modules/.package-lock.sha"), "utf8")).toBe(stamp);
    // An out-of-sync lockfile stops before the install, with the one-line refusal.
    writeFileSync(
      join(bin, "npm"),
      `#!${process.execPath}\nimport fs from 'node:fs'; if (process.argv.slice(2)[1] === '--dry-run') { process.stderr.write("npm error code EUSAGE\\nnpm error \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with \`npm install\` before continuing.\\nnpm error Invalid: lock file's yaml@2.9.1 does not satisfy yaml@2.9.0\\n"); process.exit(1); } process.exit(7);`,
      {
        mode: 0o755,
      }
    );
    writeFileSync(steps, JSON.stringify([git[0], ...git.slice(3)]));
    const refused = run();
    expect(refused.status).toBe(1);
    expect(refused.stdout).not.toContain("ready.");
    expect(refused.stderr).toContain(
      "lockfile out of sync with package.json: regenerate it on the task branch before starting"
    );
    expect(refused.stderr).toContain("Invalid: lock file's yaml@2.9.1 does not satisfy yaml@2.9.0");
    expect(refused.stderr).not.toContain("npm error code EUSAGE");
    expect(readFileSync(join(target, "node_modules/.package-lock.sha"), "utf8")).toBe(stamp);
  },
  15000
);

function stubFixture() {
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
    runChild("/bin/sh", [join(f.root, "scripts/agent", name), ...args], {
      cwd: nested,
      env,
      encoding: "utf8",
      timeout: 3000,
    });

  // Git discovery: both the stub and the CLI resolve the root via git,
  // with no VMETHOD_ROOT set, from a directory far below the root.
  const gitEnv = {
    PATH: `${bin}:${dirname(process.execPath)}`,
    VMETHOD_TASK_PR: "3",
  };
  return { f, nested, stub, gitEnv };
}

test.each([
  { name: "ordinary GFM", source: "# Ordinary GFM\n", code: 0 },
  { name: "unclosed fence", source: "```\nunclosed", code: 1 },
])(
  "Markdown stub resolves the root from a nested directory: $name",
  ({ source, code }) => {
    const { nested, stub, gitEnv } = stubFixture();
    writeFileSync(join(nested, "body.md"), source);
    const result = stub("check-markdown.sh", ["body.md"], gitEnv);
    expect(result.status).toBe(code);
    if (code === 1) {
      expect(result.stderr).toContain("Unclosed code fence opened at line 1");
    }
  },
  5000
);

test("stubs run from a nested directory resolve the repository root, never the cwd", () => {
  const { f, stub, gitEnv } = stubFixture();
  const push = stub("push.sh", [], gitEnv);
  expect(push.status, push.stderr).toBe(1);
  expect(push.stderr).toContain("Missing configured GitHub token environment variable");
  expect(push.stderr).not.toContain("ENOENT");
  const config = stub("config.sh", ["get", "repo"], gitEnv);
  expect(config.status, config.stderr).toBe(0);
  expect(config.stdout).toBe("example/project\n");

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
}, 6000);
