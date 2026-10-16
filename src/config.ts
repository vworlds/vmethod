import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { LineCounter, parseDocument } from "yaml";
import configSchema from "../schema/vmethod.schema.json" with { type: "json" };
import peopleSchema from "../schema/people.schema.json" with { type: "json" };
import modelsSchema from "../schema/models.schema.json" with { type: "json" };
import baseline from "../board/migrations/0001-baseline.json" with { type: "json" };

type Schema = Record<string, unknown>;
export type Config = Record<string, unknown>;
const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
const validators = {
  vmethod: ajv.compile(configSchema),
  people: ajv.compile(peopleSchema),
  models: ajv.compile({
    ...modelsSchema,
    items: {
      ...modelsSchema.items,
      properties: {
        ...modelsSchema.items.properties,
        family: { enum: baseline.expect.fields.Model.options },
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

function overrides(value: Config, schema: Schema, env: NodeJS.ProcessEnv, path = ""): void {
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
      const object = (child ?? {}) as Config;
      overrides(object, field, env, full);
      if (Object.keys(object).length) {
        value[key] = object;
      }
    }
  }
}

export function loadYaml(
  root: string,
  kind: keyof typeof validators,
  env: NodeJS.ProcessEnv = {}
): unknown {
  const file = join(root, `${kind}.yaml`);
  return validateYaml(readFileSync(file, "utf8"), kind, file, env);
}

export function validateYaml(
  text: string,
  kind: keyof typeof validators,
  file: string,
  env: NodeJS.ProcessEnv = {}
): unknown {
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
    const config = value as Config;
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
  return value;
}

export function getConfig(root: string, env: NodeJS.ProcessEnv): Config {
  return loadYaml(root, "vmethod", env) as Config;
}

export function configValue(config: Config, key: string): unknown {
  let value: unknown = config;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) {
      throw new Error(`Unknown config key: ${key}`);
    }
    value = (value as Config)[part];
  }
  return value;
}
