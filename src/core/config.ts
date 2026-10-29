import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { LineCounter, parseDocument } from "yaml";
import configSchema from "../../schema/vmethod.schema.json" with { type: "json" };
import peopleSchema from "../../schema/people.schema.json" with { type: "json" };
import modelsSchema from "../../schema/models.schema.json" with { type: "json" };
import baselineModels from "../../board/migrations/0001-baseline.json" with { type: "json" };
import { loadMigrations } from "../board/migrations.js";
import type { Price, PriceTier } from "../cost.js";

type Schema = Record<string, unknown>;
/** Schema-validated project settings; optional settings retain their existing use-site defaults. */
export type Config = {
  repo: string;
  org: string;
  baseBranch: string;
  board: {
    owner: string;
    number: number;
    repos: string[];
    enabled?: boolean;
    announce?: string;
  };
  releaseBranch?: string;
  track?: string;
  workerCheckout?: string;
  stateName?: string;
  legacyState?: string[];
  legacyWorkers?: string[];
  vmethod?: { repo?: string };
  watch?: { preview?: boolean };
  limits?: { enabled?: boolean; atRisk?: number; pollSeconds?: number };
  learningsPrivacy?: "public" | "private";
  learningsModel?: string;
  learningsTimeoutSeconds?: number;
  scope?: { fastPath?: string[] };
  branches?: {
    taskPattern?: string;
    worktreeRoot?: string;
    worktreePrefix?: string;
    mainCheckout?: string;
    packPrefix?: string;
    trackPrefix?: string;
  };
  checks?: { verify?: string[]; release?: string[]; docsGlob?: string; ci?: string[] };
  merge?: { requireCurrentBase?: boolean };
  conflicts?: { escalatePaths?: string[] };
  postMerge?: { install?: string; trigger?: string };
  changelog?: { directory?: string; kinds?: string[] };
  credentials?: { sshKey?: string };
  push?: { denyPatterns?: string[] };
  gateway?: { reserve?: number; maxRetries?: number };
};

/** Legacy service inputs allow partial, mutable settings and dynamic key reads.
 * File loads still enforce Config's required fields and privacy enum before exposing this view.
 */
export type ConfigInput = Omit<Partial<Config>, "board" | "learningsPrivacy"> & {
  board?: Partial<Config["board"]>;
  learningsPrivacy?: string;
  [key: string]: unknown;
};

/** One schema-validated model registry entry; historical session backends are not file entries. */
export interface ModelEntry {
  family: string;
  model: string;
  kind: "opencode";
  gate: "none" | "owner";
  tier: "expensive" | "standard" | "cheap";
  fallback?: string[];
  provider?: string;
  price?: Price;
  tiers?: PriceTier[];
}

/** Owner-pinned identity from people.schema.json. Runtime duplicate-pin checks remain in PeopleFilter. */
export interface Person {
  login: string;
  id: number;
  type: "User" | "Bot";
  role: "owner" | "orchestrator" | "worker" | "collaborator" | "system";
  events?: ("check_run" | "status" | "workflow_run")[];
  appIds?: number[];
  /** Central, owner-approved project bindings for learning submissions. */
  repos?: string[];
}

interface ProjectFiles {
  vmethod: Config;
  models: ModelEntry[];
  people: Person[];
}

/** Default task family, shared by task opening and model advice. */
export const DEFAULT_MODEL_FAMILY = "sol";

/** Gateway-scoped, lazy model snapshot shared by worker, task, quota and learning operations. */
export class ModelRegistry {
  private models?: ModelEntry[];
  constructor(private root: string) {}

  /** Validate the model file on first use only; a failed load is never cached. */
  entries(): ModelEntry[] {
    return (this.models ??= loadYaml(this.root, "models"));
  }
}
const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
/**
 * Ordered board Model options: the migration-added state (fable in 0005), so the
 * newest family validates without reopening migration history. A built CLI embeds
 * its migrations; a harness bundle without them falls back to the baseline options.
 */
function modelFamilyOptions(): string[] {
  try {
    const last = loadMigrations().at(-1);
    return (last?.expect.fields.Model.options ?? baselineModels.expect.fields.Model.options).map(
      (option) => (typeof option === "string" ? option : option.name)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return baselineModels.expect.fields.Model.options;
    }
    throw error;
  }
}
const modelFamilies = modelFamilyOptions();
const validators = {
  vmethod: ajv.compile(configSchema),
  people: ajv.compile(peopleSchema),
  models: ajv.compile({
    ...modelsSchema,
    items: {
      ...modelsSchema.items,
      properties: {
        ...modelsSchema.items.properties,
        family: { enum: modelFamilies },
      },
    },
  }),
};

function envName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\./g, "_")
    .toUpperCase();
}

function overrides(
  value: Record<string, unknown>,
  schema: Schema,
  env: NodeJS.ProcessEnv,
  path = ""
): void {
  const properties = { ...(schema.properties ?? {}) } as Record<string, Schema>;
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    for (const key of Object.keys(value)) {
      properties[key] ??= schema.additionalProperties as Schema;
    }
  }
  for (const [key, field] of Object.entries(properties)) {
    const full = path ? `${path}.${key}` : key;
    const switches: Record<string, string> = {
      baseBranch: "BASE",
      "board.enabled": "BOARD",
    };
    const names = [envName(full), ...(switches[full] ? [switches[full]] : [])];
    // VMETHOD_BOARD is a boolean switch, not a replacement for the board object.
    const raw =
      field.type === "object"
        ? undefined
        : names.map((name) => env[`VMETHOD_${name}`]).find((entry) => entry !== undefined);
    if (raw !== undefined) {
      // Strings remain strings (including YAML 1.2's "no" and version-like values).
      value[key] =
        full === "board.enabled" && ["off", "on"].includes(raw)
          ? raw === "on"
          : field.type === "string" || field.enum
            ? raw
            : parseDocument(raw, { version: "1.2" }).toJS();
    } else if (field.type === "object") {
      const child = value[key];
      if (
        child !== undefined &&
        (typeof child !== "object" || child === null || Array.isArray(child))
      ) {
        continue;
      }
      const object = (child ?? {}) as Record<string, unknown>;
      overrides(object, field, env, full);
      if (Object.keys(object).length) {
        value[key] = object;
      }
    }
  }
}

/** Load and validate one project file, applying environment overrides only to vmethod.yaml. */
export function loadYaml<K extends keyof ProjectFiles>(
  root: string,
  kind: K,
  env: NodeJS.ProcessEnv = {}
): ProjectFiles[K] {
  const file = join(root, `${kind}.yaml`);
  return validateYaml(readFileSync(file, "utf8"), kind, file, env);
}

/** Validate YAML with unchanged file/line diagnostics and schema defaults. */
export function validateYaml<K extends keyof ProjectFiles>(
  text: string,
  kind: K,
  file: string,
  env: NodeJS.ProcessEnv = {}
): ProjectFiles[K] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    version: "1.2",
    lineCounter,
    uniqueKeys: true,
  });
  if (doc.errors.length) {
    throw new Error(
      doc.errors
        .map((error) => `${file}:${lineCounter.linePos(error.pos[0]).line}: YAML ${error.code}`)
        .join("\n")
    );
  }
  const value: unknown = doc.toJS();
  if (kind === "vmethod" && value && typeof value === "object" && !Array.isArray(value)) {
    const config = value as Record<string, unknown>;
    overrides(config, configSchema, env);
  }
  if (!validators[kind](value)) {
    const errors = validators[kind].errors ?? [];
    throw new Error(
      errors
        .map((error: ErrorObject) => {
          const parts = error.instancePath
            .split("/")
            .slice(1)
            .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
          if (error.keyword === "additionalProperties") {
            parts.push(String(error.params.additionalProperty));
          }
          const node = doc.getIn(parts, true);
          const offset =
            node && typeof node === "object" && "range" in node
              ? (node.range as number[] | null)?.[0]
              : 0;
          const line = lineCounter.linePos(offset ?? 0).line;
          return `${file}:${line}: ${error.instancePath || "/"} ${error.message}`;
        })
        .join("\n")
    );
  }
  if (kind === "models") {
    const models = value as ModelEntry[];
    const families = new Set<string>();
    const identifiers = new Set<string>();
    for (const [index, model] of models.entries()) {
      const node = doc.getIn([index], true);
      const line = lineCounter.linePos(
        node && typeof node === "object" && "range" in node ? (node.range as number[])[0] : 0
      ).line;
      if (families.has(model.family) || identifiers.has(`${model.kind}/${model.model}`)) {
        throw new Error(`${file}:${line}: duplicate model family or identifier`);
      }
      families.add(model.family);
      identifiers.add(`${model.kind}/${model.model}`);
      const thresholds = new Set<number>();
      for (const tier of model.tiers ?? []) {
        if (thresholds.has(tier.minPrompt)) {
          throw new Error(`${file}:${line}: duplicate minPrompt threshold`);
        }
        thresholds.add(tier.minPrompt);
        if ((["input", "output", "cached"] as const).some((key) => tier[key] < model.price![key])) {
          throw new Error(`${file}:${line}: tier rates must not be below base prices`);
        }
      }
      for (const fallback of model.fallback ?? []) {
        if (!models.some((entry) => entry.family === fallback)) {
          throw new Error(`${file}:${line}: unknown fallback family ${fallback}`);
        }
      }
    }
  }
  return value as ProjectFiles[K];
}

export function getConfig(root: string, env: NodeJS.ProcessEnv): Config {
  return loadYaml(root, "vmethod", env);
}

export function configValue(config: ConfigInput, key: string): unknown {
  let value: unknown = config;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) {
      throw new Error(`Unknown config key: ${key}`);
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
