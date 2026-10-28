import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { configValue, getConfig, loadYaml } from "../src/config.js";
import { validProject } from "./helpers.js";
import { check } from "../src/check.js";

test("quota configuration defaults, overrides and validation", () => {
  const root = validProject();
  expect(getConfig(root, {}).limits).toEqual({ enabled: true, atRisk: 15, pollSeconds: 300 });
  expect(
    getConfig(root, {
      VMETHOD_LIMITS_ENABLED: "false",
      VMETHOD_LIMITS_AT_RISK: "20",
      VMETHOD_LIMITS_POLL_SECONDS: "60",
    }).limits
  ).toEqual({ enabled: false, atRisk: 20, pollSeconds: 60 });
  for (const [key, value] of [
    ["AT_RISK", "-1"],
    ["AT_RISK", "101"],
    ["POLL_SECONDS", "0"],
    ["POLL_SECONDS", "1.5"],
    ["ENABLED", "yes"],
  ]) {
    expect(() => getConfig(root, { [`VMETHOD_LIMITS_${key}`]: value })).toThrow("vmethod.yaml:");
  }
  const file = join(root, "models.yaml");
  writeFileSync(
    file,
    "- family: sol\n  kind: opencode\n  model: custom/model\n  provider: codexbal\n  gate: none\n  tier: standard\n"
  );
  expect(loadYaml(root, "models")).toMatchObject([{ provider: "codexbal" }]);
  writeFileSync(file, readFileSync(file, "utf8").replace("codexbal", "invalid/provider"));
  expect(() => loadYaml(root, "models")).toThrow("models.yaml:");
});

test.each([undefined, "auto-", ""])(
  "worker worktree prefix accepts %j and defaults to auto-",
  (prefix) => {
    const root = validProject();
    const file = join(root, "vmethod.yaml");
    if (prefix !== undefined) {
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "branches:",
          `branches:\n  worktreePrefix: ${JSON.stringify(prefix)}`
        )
      );
    }
    expect((getConfig(root, {}).branches as Record<string, unknown>).worktreePrefix).toBe(
      prefix ?? "auto-"
    );
  }
);

test.each([undefined, "premium", "expensive", "standard", "cheap"])(
  "models require an explicit valid tier (%s)",
  (tier) => {
    const root = validProject();
    writeFileSync(
      join(root, "models.yaml"),
      `- family: sol\n  kind: opencode\n  model: provider/id\n  gate: none\n${tier === undefined ? "" : `  tier: ${tier}\n`}`
    );
    const result = check(root);
    if (["expensive", "standard", "cheap"].includes(String(tier))) {
      expect(result.code).toBe(0);
    } else {
      expect(result.code).toBe(1);
      expect(result.messages.join("\n")).toMatch(/tier|allowed values/);
    }
  }
);

test.each([
  { kind: "opencode", model: "provider/model", gate: "none", valid: true },
  { kind: "opencode", model: "claude-code/claude-opus-5-5[1m]", gate: "owner", valid: true },
  { kind: "opencode", model: "bare-model", gate: "none", valid: false },
  { kind: "opencode", model: "provider/model with spaces", gate: "none", valid: false },
  { kind: "claude", model: "claude-sonnet-5-5", gate: "none", valid: false },
  { kind: "claude", model: "claude-code/claude-sonnet-5-5", gate: "none", valid: false },
  { kind: "opencode", model: "provider/model", gate: "-", valid: false },
])(
  "models schema validates kind=$kind model=$model gate=$gate (valid=$valid)",
  ({ kind, model, gate, valid }) => {
    const root = validProject();
    writeFileSync(
      join(root, "models.yaml"),
      `- family: other\n  kind: ${kind}\n  model: ${model}\n  gate: "${gate}"\n  tier: standard\n`
    );
    if (valid) {
      expect(loadYaml(root, "models")).toEqual([
        { family: "other", kind, model, gate, tier: "standard" },
      ]);
    } else {
      expect(() => loadYaml(root, "models")).toThrow("models.yaml:");
    }
  },
  15000
);

test("YAML 1.2 strings, nested keys, explicit validation and unknown keys", () => {
  const root = validProject();
  const path = join(root, "vmethod.yaml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("stateName: example-state", 'stateName: "1.10"\ntrack: no')
  );
  expect(configValue(getConfig(root, {}), "track")).toBe("no");
  expect(configValue(getConfig(root, {}), "stateName")).toBe("1.10");
  expect(configValue(getConfig(root, {}), "board.number")).toBe(1);
  expect(() => configValue(getConfig(root, {}), "unknown")).toThrow("Unknown config key");
  writeFileSync(path, readFileSync(path, "utf8").replace("number: 1", "number: wrong"));
  const numberLine =
    readFileSync(path, "utf8")
      .split("\n")
      .findIndex((line) => line.includes("number: wrong")) + 1;
  expect(numberLine).toBeGreaterThan(0);
  expect(() => getConfig(root, {})).toThrow(new RegExp(`vmethod.yaml:${numberLine}:.*integer`));
}, 15000);

test.each(["legacyState", "legacyWorkers"])(
  "%s is an optional list of safe, unique directory names",
  (key) => {
    const root = validProject();
    const path = join(root, "vmethod.yaml");
    const original = readFileSync(path, "utf8");
    expect(getConfig(root, {})[key]).toBeUndefined();
    for (const value of ["[]", "[spacerocks-watch, spacerocks-watch-audit, rebase-watch]"]) {
      writeFileSync(path, `${original}\n${key}: ${value}\n`);
      expect(Array.isArray(getConfig(root, {})[key])).toBe(true);
    }
    for (const value of [
      "vecs-watch",
      "[../vecs-watch]",
      "[/tmp/watch]",
      "[vecs-watch, vecs-watch]",
      "[null]",
    ]) {
      writeFileSync(path, `${original}\n${key}: ${value}\n`);
      expect(() => getConfig(root, {})).toThrow(key);
    }
  },
  15000
);

test("legacyWorkers accepts nested relative paths but rejects traversal and empty segments", () => {
  const root = validProject();
  const path = join(root, "vmethod.yaml");
  const original = readFileSync(path, "utf8");
  writeFileSync(
    path,
    `${original}\nlegacyWorkers: [vecs-orchestrator/workers, spacerocks-orchestrator/claude-workers]\n`
  );
  expect(getConfig(root, {}).legacyWorkers).toEqual([
    "vecs-orchestrator/workers",
    "spacerocks-orchestrator/claude-workers",
  ]);
  for (const value of [
    "../workers",
    "a/../workers",
    "a/./workers",
    "a//workers",
    "a/",
    "/a",
    "a\\workers",
    ".",
    "..",
    "",
  ]) {
    writeFileSync(path, `${original}\nlegacyWorkers: ${JSON.stringify([value])}\n`);
    expect(() => getConfig(root, {})).toThrow("legacyWorkers");
  }
  writeFileSync(path, `${original}\nlegacyState: [vecs-orchestrator/workers]\n`);
  expect(() => getConfig(root, {})).toThrow("legacyState");
});

test("VMETHOD overrides config; VECS, SPACEROCKS and bare BASE are ignored", () => {
  const root = validProject();
  expect(
    getConfig(root, {
      VECS_BASE: "foreign",
      SPACEROCKS_BASE: "foreign",
      BASE: "foreign",
    }).baseBranch
  ).toBe("dev");
  expect(
    getConfig(root, {
      VMETHOD_BOARD_NUMBER: "7",
      VECS_BOARD_PROJECT: "8",
      SPACEROCKS_BOARD_NUMBER: "9",
    }).board
  ).toMatchObject({ number: 7 });
  expect(getConfig(root, { VMETHOD_BASE: "track", VECS_BASE: "legacy" }).baseBranch).toBe("track");
  expect(() => getConfig(root, { VMETHOD_BOARD_NUMBER: "wrong" })).toThrow("integer");
}, 15000);

test("default board switch, arrays and credential-name overrides are typed and validated", () => {
  const root = validProject();
  const path = join(root, "vmethod.yaml");
  expect(getConfig(root, {})).toMatchObject({ board: { enabled: true } });
  expect(getConfig(root, {})).toMatchObject({ credentials: { sshKey: "EXAMPLE_SSH_KEY" } });
  expect(
    getConfig(root, {
      VMETHOD_CREDENTIALS_SSH_KEY: "OTHER_KEY",
      VMETHOD_BOARD_REPOS: "[example/one, example/two]",
    })
  ).toMatchObject({
    credentials: { sshKey: "OTHER_KEY" },
    board: { repos: ["example/one", "example/two"] },
  });
  expect(() => getConfig(root, { VMETHOD_CREDENTIALS_SSH_KEY: "literal-value" })).toThrow(
    "pattern"
  );
  // GitHub access comes from GH_CONFIG_DIR alone; a token variable name is refused.
  writeFileSync(path, `${readFileSync(path, "utf8")}  githubToken: GH_TOKEN\n`);
  expect(() => getConfig(root, {})).toThrow("/credentials must NOT have additional properties");
}, 15000);

test("VMETHOD board, track and base switches map to config", () => {
  const root = validProject();
  const config = getConfig(root, {
    VMETHOD_BOARD: "off",
    VMETHOD_TRACK: "track-name",
    VMETHOD_BASE: "track/base",
    VECS_BOARD: "on",
    VECS_TRACK: "foreign",
    VECS_BASE: "foreign",
    VECS_OWNER: "foreign",
    VECS_BOARD_PROJECT: "99",
  });
  expect(config).toMatchObject({
    track: "track-name",
    baseBranch: "track/base",
    board: { enabled: false, owner: "example", number: 1 },
  });
  expect(getConfig(root, { VMETHOD_BOARD: "on" })).toMatchObject({
    board: { enabled: true },
  });
}, 15000);

test("owner authority cannot be supplied by VMETHOD_OWNER; obsolete board node-id switch is ignored", () => {
  const root = validProject();
  const people = loadYaml(root, "people");
  const config = getConfig(root, {
    VMETHOD_OWNER: "attacker",
    VMETHOD_BOARD_PROJECT: "PVT_node_id",
  });
  expect(config).toEqual(getConfig(root, {}));
  expect(loadYaml(root, "people", { VMETHOD_OWNER: "attacker" })).toEqual(people);
  expect(
    getConfig(root, {
      VMETHOD_BOARD_OWNER: "board-org",
      VMETHOD_BOARD_NUMBER: "42",
    })
  ).toMatchObject({ board: { owner: "board-org", number: 42 } });
}, 15000);

test("schema rejects missing numeric ids, unknown model families, duplicate YAML keys and unknown config keys", () => {
  const root = validProject();
  writeFileSync(join(root, "people.yaml"), "- login: owner\n  role: owner\n");
  expect(() => loadYaml(root, "people")).toThrow(/people.yaml:1:.*id/);
  writeFileSync(
    join(root, "models.yaml"),
    "- family: imaginary\n  model: provider/model\n  kind: opencode\n  gate: none\n"
  );
  expect(() => loadYaml(root, "models")).toThrow(/models.yaml:1:.*allowed/);
  const path = join(root, "vmethod.yaml");
  writeFileSync(path, readFileSync(path, "utf8") + "\nunknown: value\n");
  expect(() => getConfig(root, {})).toThrow("additional properties");
  writeFileSync(path, "repo: a/b\nrepo: c/d\n");
  expect(() => getConfig(root, {})).toThrow("DUPLICATE_KEY");
}, 15000);

test("learningsTimeoutSeconds is validated, injected as 900 when unset and overridable", () => {
  const root = validProject();
  const path = join(root, "vmethod.yaml");
  const original = readFileSync(path, "utf8");
  const config = () => getConfig(root, {}) as Record<string, unknown>;
  expect(config().learningsTimeoutSeconds).toBe(900);
  writeFileSync(path, original + "\nlearningsTimeoutSeconds: 1200\n");
  expect(config().learningsTimeoutSeconds).toBe(1200);
  for (const invalid of ["0", "-1", "1.5", "soon"]) {
    writeFileSync(path, original + `\nlearningsTimeoutSeconds: ${invalid}\n`);
    expect(() => getConfig(root, {})).toThrow(/learningsTimeoutSeconds/);
  }
  writeFileSync(path, original);
}, 15000);
