import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, delimiter } from "node:path";
import { getConfig, loadYaml } from "./config.js";
import type { Config } from "./config.js";
import permissionTemplate from "../templates/claude-settings.json" with { type: "json" };
import packageMetadata from "../package.json" with { type: "json" };
import { gitIdentityVariables } from "./gateway/git.js";
import { launcherMark } from "./registry.js";
import type { Person } from "./gateway/people.js";
import { workerCheckout, workerCheckoutIsSelf } from "./gateway/worker-path.js";

const mermaidPin = packageMetadata.peerDependencies.mermaid;
const secretPattern =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|:\/\/[^/\s:]+:[^/\s@]+@)/;

/** Offline validation. Deferral only softens absent settings on the running prerelease;
 * installed settings are always validated. CODEOWNERS gaps are advisory warnings.
 * `version` is supplied by the bundled CLI, defaulting to source package metadata.
 */
export function check(
  root: string,
  env: NodeJS.ProcessEnv = {},
  options: { deferPermissions?: boolean; version?: string } = {}
): { code: number; messages: string[] } {
  const messages: string[] = [];
  const warnings: string[] = [];
  const version = options.version ?? packageMetadata.version;
  if (env.VMETHOD_ROLE === undefined && existsSync(join(root, ".claude/settings.local.json"))) {
    warnings.push("WARN the session predates the settings; restart it");
  }
  if (
    options.deferPermissions &&
    !/^\d+\.\d+\.\d+-[\da-z-]+(?:\.[\da-z-]+)*(?:\+[\da-z.-]+)?$/i.test(version)
  ) {
    return { code: 1, messages: ["--defer-permissions is only valid on a prerelease"] };
  }
  if (env.VMETHOD_ROLE === "orchestrator") {
    for (const key of gitIdentityVariables) {
      if (!env[key]?.trim()) {
        messages.push(
          `Missing ${key}: set in the orchestrator environment; git config identity is not used`
        );
      }
    }
  }
  // Commands no longer spell the environment inline: the checkout's
  // .claude/settings.local.json carries the role and checkout overrides must resolve.
  const role = env.VMETHOD_ROLE;
  if (role !== undefined && role !== "orchestrator" && role !== "worker") {
    messages.push(
      `VMETHOD_ROLE is ${role}, not orchestrator or worker; fix it in this checkout's .claude/settings.local.json`
    );
  }
  const rootOverride = env.VMETHOD_ROOT;
  if (rootOverride !== undefined) {
    let usable: boolean;
    try {
      usable = statSync(rootOverride, { throwIfNoEntry: false })?.isDirectory() ?? false;
    } catch {
      usable = false;
    }
    if (!usable) {
      messages.push(
        `VMETHOD_ROOT is ${rootOverride}, which is not a usable directory; commands resolve the checkout from it`
      );
    }
  }
  let missing = false;
  let vmethodValue: Config | undefined;
  for (const kind of ["vmethod", "people", "models"] as const) {
    try {
      const value = kind === "vmethod" ? getConfig(root, env) : loadYaml(root, kind);
      if (kind === "vmethod") {
        vmethodValue = value as Config;
        if (env.VMETHOD_ROLE === "orchestrator") {
          messages.push(...workerCheckoutFindings(root, vmethodValue, env));
        }
        const secrets = secretPaths(value);
        for (const path of secrets) {
          messages.push(`Secret-looking config value at ${path} (redacted)`);
        }
        if (
          !secrets.length &&
          secretPattern.test(readFileSync(join(root, "vmethod.yaml"), "utf8"))
        ) {
          messages.push(
            "Secret-looking value in vmethod.yaml (redacted; environment overrides do not hide stored secrets)"
          );
        }
      }
      if (kind === "people") {
        const people = value as Person[];
        if (
          new Set(people.map((person) => person.id)).size !== people.length ||
          new Set(people.map((person) => person.login.toLowerCase())).size !== people.length
        ) {
          messages.push("people.yaml: duplicate id or login");
        }
        // The orchestrator role is per repository (#186): without an explicit
        // binding the account is a collaborator everywhere, so an upgrade that
        // silently loses its authority must fail here.
        for (const person of people) {
          if (person.role === "orchestrator" && !person.repos?.length) {
            messages.push(
              `people.yaml: orchestrator ${person.login} has no repos binding; add repos: [<owner>/<repo>]`
            );
          }
        }
        const repo = vmethodValue?.repo;
        const bound =
          repo !== undefined &&
          people.some((person) =>
            person.repos?.some((listed) => listed.toLowerCase() === String(repo).toLowerCase())
          );
        if (repo !== undefined && !bound) {
          messages.push(
            `people.yaml: no orchestrator binding lists ${String(repo)}; add repos: [<owner>/<repo>]`
          );
        }
      }
      if (kind === "models") {
        for (const model of value as { family: string; price?: unknown }[]) {
          if (!model.price) {
            warnings.push(`WARN models.yaml: ${model.family} has no price; delivery usd is null`);
          }
        }
      }
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  let peerPath: string | undefined;
  try {
    peerPath = createRequire(join(root, "package.json")).resolve("mermaid/package.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
      messages.push(`Cannot resolve mermaid: ${(error as Error).message}`);
    } else {
      missing = true;
      messages.push(`Dependency missing: install mermaid@${mermaidPin}`);
    }
  }
  if (peerPath) {
    try {
      const peer = JSON.parse(readFileSync(peerPath, "utf8")) as {
        version: string;
      };
      if (peer.version !== mermaidPin) {
        messages.push(`mermaid must equal ${mermaidPin}; installed ${peer.version}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing = true;
        messages.push(`Dependency missing: install mermaid@${mermaidPin}`);
      } else {
        messages.push(`Invalid mermaid metadata: ${(error as Error).message}`);
      }
    }
  }
  try {
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as {
      permissions?: { deny?: string[] };
    };
    for (const rule of permissionTemplate.permissions.deny) {
      if (!settings.permissions?.deny?.includes(rule)) {
        messages.push(`Permission deny rule missing: ${rule}`);
      }
    }
  } catch (error) {
    if (options.deferPermissions && (error as NodeJS.ErrnoException).code === "ENOENT") {
      warnings.push(
        `WARN permissions deferred (prerelease ${version}): .claude/settings.json not installed`
      );
    } else {
      messages.push(
        "Install owner-approved .claude/settings.json from templates/claude-settings.json"
      );
    }
  }
  const claudeIgnore = claudeIgnoreStatus(root);
  if (claudeIgnore === "missing") {
    messages.push(`no .gitignore found at ${root} (in CI, copy it into the build context)`);
  } else if (claudeIgnore === "not-ignored") {
    messages.push(
      "Ignore .claude/ in .gitignore: each checkout keeps its own identity in .claude/settings.local.json"
    );
  }
  warnings.push(...leftoverTokenWarnings(root));
  warnings.push(...codeownersWarnings(root));
  return { code: missing ? 2 : messages.length ? 1 : 0, messages: [...messages, ...warnings] };
}

/** Keys vmethod stopped reading when each identity became its GH_CONFIG_DIR login (#285):
 * a leftover here is a live credential on disk exported into every session, unused. */
const unusedTokenKeys = ["GH_TOKEN", "GITHUB_TOKEN"];

/** Name each leftover token key, never its value, and leave removal to the owner. */
function leftoverTokenWarnings(root: string): string[] {
  const env = localSettingsEnv(root);
  return unusedTokenKeys
    .filter((key) => env !== undefined && Object.hasOwn(env, key))
    .map(
      (key) =>
        `WARN ${key} in .claude/settings.local.json is unused since GH_CONFIG_DIR logins (#285); remove it`
    );
}

/** The orchestrator launches workers in their own clone; it must exist apart from this one. */
function workerCheckoutFindings(root: string, config: Config, env: NodeJS.ProcessEnv): string[] {
  try {
    const checkout = workerCheckout(root, config);
    return existsSync(join(checkout, ".git"))
      ? []
      : [`workerCheckout ${checkout} is not a git clone; clone the repository there for workers`];
  } catch (error) {
    // A worker checkout's own repository config resolves into this checkout, so
    // an orchestrator environment run there is only wearing the wrong identity;
    // the same-clone refusal stays for a checkout that is not the worker checkout.
    if (
      workerCheckoutIsSelf(root, config) &&
      env.VMETHOD_ROLE === "orchestrator" &&
      localSettingsRole(root) === "worker"
    ) {
      return [
        "this is the worker checkout, but the environment is the orchestrator's (VMETHOD_ROLE=orchestrator); run check with this checkout's own .claude/settings.local.json env",
      ];
    }
    return [(error as Error).message];
  }
}

/** The `env` block this checkout's own .claude/settings.local.json declares, if it does.
 * A malformed or absent file is simply no declaration, not a finding.
 */
function localSettingsEnv(root: string): Record<string, unknown> | undefined {
  try {
    const settings = JSON.parse(
      readFileSync(join(root, ".claude/settings.local.json"), "utf8")
    ) as { env?: unknown };
    const env = settings?.env;
    return env && typeof env === "object" ? (env as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The role this checkout's own .claude/settings.local.json declares, if it does. */
function localSettingsRole(root: string): string | undefined {
  const role = localSettingsEnv(root)?.VMETHOD_ROLE;
  return typeof role === "string" ? role : undefined;
}

/** Whether the root .gitignore is absent, ignores the whole .claude directory, or does not. */
function claudeIgnoreStatus(root: string): "missing" | "ignored" | "not-ignored" {
  let lines: string[];
  try {
    lines = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "not-ignored";
  }
  const ignored = lines.findLastIndex((line) => /^\/?\.claude\/?$/.test(line.trim()));
  const negated = lines.slice(ignored + 1).some((line) => /^!\/?\.claude\//.test(line.trim()));
  return ignored >= 0 && !negated ? "ignored" : "not-ignored";
}

function secretPaths(value: unknown, path = ""): string[] {
  if (typeof value === "string") {
    return secretPattern.test(value) ? [path] : [];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    secretPaths(child, path ? `${path}.${key}` : key)
  );
}

function codeownersWarnings(root: string): string[] {
  let contents = "";
  // GitHub uses the first existing file in this order, not their union.
  for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    try {
      contents = readFileSync(join(root, path), "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return [`WARN CODEOWNERS: cannot read ${path}: ${(error as Error).message}`];
      }
    }
  }
  const entries = contents.split(/\r?\n/).flatMap((line) => {
    const [pattern, ...owners] = line.split("#", 1)[0].trim().split(/\s+/);
    // Negation and character ranges are unsupported by GitHub CODEOWNERS.
    if (!pattern || /^[#!]/.test(pattern) || /[[\]\\]/.test(pattern)) {
      return [];
    }
    return [
      {
        pattern: codeownersPattern(pattern),
        owned: owners.some((owner) => /^@\S+$/.test(owner) || /^[^\s@]+@[^\s@]+$/.test(owner)),
      },
    ];
  });
  return ["vmethod.yaml", "people.yaml", ".claude/"].flatMap((path) => {
    let owned = false;
    for (const entry of entries) {
      if (entry.pattern.test(path)) {
        owned = entry.owned;
      }
    }
    return owned ? [] : [`WARN CODEOWNERS: ${path} has no owner entry`];
  });
}

function codeownersPattern(pattern: string): RegExp {
  const anchored = pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
  const glob = pattern.replace(/^\//, "").replace(/\/$/, "");
  let expression = anchored ? "^" : "(?:^|/)";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        expression += "(?:.*/)?";
        i += 2;
      } else {
        expression += ".*";
        i++;
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(expression + "(?:/|$)");
}

/** Report whether the first executable `vmethod` on env.PATH is a marked launcher.
 * Missing and foreign commands are advisory warnings, not blocking findings.
 */
export function launcherReport(env: NodeJS.ProcessEnv = {}): string {
  const target = pathVmethod(env);
  if (!target) {
    return "WARN vmethod is not on PATH; write it with npm exec --no -- vmethod init --launcher";
  }
  let marked: boolean;
  try {
    marked = readFileSync(target, "utf8").split(/\r?\n/).includes(launcherMark);
  } catch {
    marked = false;
  }
  return marked
    ? `vmethod on PATH is the vmethod launcher: ${target}`
    : `WARN vmethod on PATH is ${target}, not a vmethod launcher; remove or rename it, then run vmethod init --launcher ${dirname(target)}`;
}

/** The PATH command a shell would execute: the first executable file named `vmethod`.
 * Non-executable and broken entries are skipped like exec would.
 */
function pathVmethod(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of env.PATH === undefined ? [] : env.PATH.split(delimiter)) {
    const target = join(dir || ".", "vmethod");
    try {
      // A symlink to the launcher is still the launcher; a directory never runs.
      if (!statSync(target).isFile()) {
        continue;
      }
      accessSync(target, constants.X_OK);
      return target;
    } catch {
      continue;
    }
  }
  return undefined;
}
