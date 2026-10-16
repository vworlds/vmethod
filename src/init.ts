import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { validateYaml } from "./config.js";
import { stub, verbs } from "./registry.js";

export function init(root: string, templateRoot: string, dryRun = false): string[] {
  const plans: { path: string; text: string; executable?: boolean }[] = [];
  // Never follow a consumer's symlink while deciding what init may replace.
  for (const path of [
    "vmethod.yaml",
    "people.yaml",
    "models.yaml",
    ...verbs.map((verb) => verb.stub),
  ]) {
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const target = join(root, ...parts.slice(0, index));
      try {
        if (lstatSync(target).isSymbolicLink()) {
          throw new Error(`Refusing to initialize symlink: ${target}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  for (const name of ["vmethod", "people", "models"]) {
    const path = `${name}.yaml`;
    if (existsSync(join(root, path))) {
      continue;
    }
    let text = readFileSync(join(templateRoot, path), "utf8");
    if (name === "models" && existsSync(join(root, "models.tsv"))) {
      const lines = readFileSync(join(root, "models.tsv"), "utf8").split(/\r?\n/);
      const headerIndex = lines.findIndex((line) =>
        line
          .replace(/^\s*#\s*/, "")
          .split("\t")
          .map((cell) => cell.trim())
          .includes("family")
      );
      const header =
        headerIndex < 0
          ? undefined
          : lines[headerIndex]
              .replace(/^\s*#\s*/, "")
              .split("\t")
              .map((cell) => (cell.trim() === "provider/id" ? "model" : cell.trim()));
      if (
        !header ||
        ["family", "model", "kind", "gate"].some((column) => !header.includes(column))
      ) {
        throw new Error(
          "models.tsv: expected header with family, model (or provider/id), kind, gate"
        );
      }
      text = stringify(
        lines.flatMap((line, index) => {
          if (index === headerIndex || !line.trim() || /^\s*#/.test(line)) {
            return [];
          }
          if (index < headerIndex) {
            throw new Error(`models.tsv:${index + 1}: data before header`);
          }
          const cells = line.split("\t");
          if (cells.length !== header.length) {
            throw new Error(`models.tsv:${index + 1}: wrong column count`);
          }
          return [
            Object.fromEntries(
              header.map((column, cell) => [
                column,
                column === "gate" && cells[cell] === "-" ? "none" : cells[cell],
              ])
            ),
          ];
        })
      );
    }
    plans.push({ path, text });
  }
  for (const verb of verbs) {
    const path = join(root, verb.stub);
    if (existsSync(path) && !readFileSync(path, "utf8").split(/\r?\n/).includes("# vmethod stub")) {
      continue;
    }
    const text = stub(verb.name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      plans.push({ path: verb.stub, text, executable: true });
    }
  }
  // Validate converted data before writing any files, including in dry-run mode.
  const converted = plans.find((plan) => plan.path === "models.yaml");
  if (converted && existsSync(join(root, "models.tsv"))) {
    // Validation uses the same schema in memory; no temporary project files.
    validateYaml(converted.text, "models", "models.tsv conversion");
  }
  for (const plan of plans) {
    if (dryRun) {
      continue;
    }
    const path = join(root, plan.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plan.text);
    if (plan.executable) {
      chmodSync(path, 0o755);
    }
  }
  return plans.map((plan) => `${dryRun ? "Would write" : "Wrote"} ${plan.path}`);
}
