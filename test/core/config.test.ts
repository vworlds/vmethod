import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, expectTypeOf, test, vi } from "vitest";
import {
  DEFAULT_MODEL_FAMILY,
  getConfig,
  loadYaml,
  ModelRegistry,
  type ModelEntry,
  type Person,
} from "../../src/core/config.js";
import { GatewayServices } from "../../src/gateway/server.js";
import type { Dependencies } from "../../src/gateway/client.js";
import { ghConfig, validProject } from "../helpers.js";

test("project loaders expose typed values without changing overrides or diagnostics", () => {
  const root = validProject();
  const config = getConfig(root, { VMETHOD_BASE: "revamp", VMETHOD_BOARD: "off" });
  expect(config.baseBranch).toBe("revamp");
  expect(config.board?.enabled).toBe(false);
  expectTypeOf(config.board.number).toEqualTypeOf<number>();
  expectTypeOf(config.repo).toEqualTypeOf<string>();
  expectTypeOf(config.learningsPrivacy).toEqualTypeOf<"public" | "private" | undefined>();
  expectTypeOf(loadYaml(root, "people")).toEqualTypeOf<Person[]>();
  expectTypeOf(loadYaml(root, "models")).toEqualTypeOf<ModelEntry[]>();
  expect(() => getConfig(root, { VMETHOD_BOARD_NUMBER: "wrong" })).toThrow(
    `${join(root, "vmethod.yaml")}:28: /board/number must be integer`
  );
});

test("model snapshots load lazily once and remain scoped to their gateway", () => {
  const root = validProject();
  const file = join(root, "models.yaml");
  const original = readFileSync(file, "utf8");
  const registry = new ModelRegistry(root);
  writeFileSync(file, "invalid: models\n");
  expect(() => registry.entries()).toThrow(`${file}:1: / must be array`);
  writeFileSync(file, original);
  const models = registry.entries();
  expect(models.some((model) => model.family === DEFAULT_MODEL_FAMILY)).toBe(true);
  writeFileSync(file, "invalid: models\n");
  expect(registry.entries()).toBe(models);
  expect(() => new ModelRegistry(root).entries()).toThrow(`${file}:1: / must be array`);
  expect(new ModelRegistry(validProject()).entries()).toEqual(models);
});

test("gateway task opening, worker limits and models share the same validated snapshot", async () => {
  const root = validProject();
  const deps: Dependencies = {
    now: () => 0,
    sleep: async () => {
      throw new Error("Unexpected sleep");
    },
    report: vi.fn(),
    exec: async () => {
      throw new Error("Unexpected exec");
    },
    fetch: async () => {
      throw new Error("Unexpected fetch");
    },
  };
  writeFileSync(
    join(root, "models.yaml"),
    `- family: ${DEFAULT_MODEL_FAMILY}
  kind: opencode
  model: fake/model
  gate: owner
  tier: expensive
`
  );
  const server = new GatewayServices(
    root,
    {
      GH_CONFIG_DIR: ghConfig("fake-config-snapshot"),
      XDG_STATE_HOME: join(root, "state"),
    },
    deps
  );
  server.config.limits = { enabled: false };
  const models = server.models.entries();
  writeFileSync(join(root, "models.yaml"), "invalid: models\n");
  expect(await server.workers.limits()).toContain(
    `${DEFAULT_MODEL_FAMILY}: fake unknown; owner-gated`
  );
  await expect(server.flow.open({ direct: "feat: snapshot" })).rejects.toThrow(
    "Model requires --owner-approved"
  );
  expect(server.models.entries()).toBe(models);
});
