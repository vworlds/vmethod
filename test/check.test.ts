import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { check } from "../src/check.js";
import { fixture, peer, validProject as unpricedProject } from "./helpers.js";
import { parse, stringify } from "yaml";

function validProject() {
  const root = unpricedProject();
  const models = parse(readFileSync(join(root, "models.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  writeFileSync(
    join(root, "models.yaml"),
    stringify(models.map((model) => ({ ...model, price: { input: 1, output: 2, cached: 0.1 } })))
  );
  return root;
}

test("missing family price warns without failing or pretending usage is free", () => {
  const result = check(unpricedProject());
  expect(result.code).toBe(0);
  expect(result.messages.length).toBeGreaterThan(0);
  expect(
    result.messages.every((message) => message.includes("has no price; delivery usd is null"))
  ).toBe(true);
});

test("check validates role and root overrides from the checkout environment", () => {
  const root = validProject();
  expect(check(root, { VMETHOD_ROLE: "worker", VMETHOD_ROOT: root }).code).toBe(0);
  const invalid = check(root, { VMETHOD_ROLE: "typo", VMETHOD_ROOT: join(root, "missing") });
  expect(invalid.code).toBe(1);
  expect(invalid.messages).toEqual([
    "VMETHOD_ROLE is typo, not orchestrator or worker; fix it in this checkout's .claude/settings.local.json",
    `VMETHOD_ROOT is ${join(root, "missing")}, which is not a usable directory; commands resolve the checkout from it`,
  ]);
  expect(check(root, { VMETHOD_ROOT: join(root, "vmethod.yaml") }).code).toBe(1);
});

test("only explicit prerelease deferral softens absent settings, on every run", () => {
  const root = validProject();
  rmSync(join(root, ".claude/settings.json"));
  for (const version of ["0.0.0-dev", "1.0.0-rc.2", "1.1.0-beta.1+build.3"]) {
    for (let run = 0; run < 2; run++) {
      expect(check(root, {}, { deferPermissions: true, version })).toEqual({
        code: 0,
        messages: [
          `WARN permissions deferred (prerelease ${version}): .claude/settings.json not installed`,
        ],
      });
    }
  }
  expect(check(root).code).toBe(1);
  for (const version of ["1.0.0", "1.0.0+rc.2"]) {
    expect(check(root, {}, { deferPermissions: true, version })).toEqual({
      code: 1,
      messages: ["--defer-permissions is only valid on a prerelease"],
    });
  }
  writeFileSync(join(root, "people.yaml"), "invalid: config");
  expect(check(root, {}, { deferPermissions: true }).code).toBe(1);
  rmSync(join(root, "node_modules/mermaid"), { recursive: true });
  expect(check(root, {}, { deferPermissions: true }).code).toBe(2);
});

test("deferral never softens installed invalid settings or unreadable settings paths", () => {
  const root = validProject();
  for (const deferPermissions of [false, true]) {
    expect(check(root, {}, { deferPermissions }).code).toBe(0);
  }
  for (const content of ["{}", "invalid JSON"]) {
    writeFileSync(join(root, ".claude/settings.json"), content);
    for (const deferPermissions of [false, true]) {
      expect(check(root, {}, { deferPermissions }).code).toBe(1);
    }
  }
  rmSync(join(root, ".claude/settings.json"));
  mkdirSync(join(root, ".claude/settings.json"));
  expect(check(root, {}, { deferPermissions: true }).code).toBe(1);
});

test("CODEOWNERS missing coverage warns without failing", () => {
  const root = validProject();
  rmSync(join(root, "CODEOWNERS"));
  expect(check(root)).toEqual({
    code: 0,
    messages: ["vmethod.yaml", "people.yaml", ".claude/"].map(
      (path) => `WARN CODEOWNERS: ${path} has no owner entry`
    ),
  });
  writeFileSync(
    join(root, "CODEOWNERS"),
    "/vmethod.yaml @owner\n/people.yaml @owner\n/.claude/ @owner\n"
  );
  expect(check(root)).toEqual({ code: 0, messages: [] });
  writeFileSync(join(root, "CODEOWNERS"), "*.yaml @owner\n.claude/** @owner\n");
  expect(check(root).messages).toEqual([]);
  writeFileSync(join(root, "CODEOWNERS"), "* @owner\npeople.yaml\n");
  expect(check(root).messages).toEqual(["WARN CODEOWNERS: people.yaml has no owner entry"]);
  writeFileSync(join(root, "CODEOWNERS"), "* @owner\npeople.yaml # deliberately unowned\n");
  expect(check(root).messages).toEqual(["WARN CODEOWNERS: people.yaml has no owner entry"]);
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github/CODEOWNERS"), "/vmethod.yaml @owner\n");
  expect(check(root).messages).toEqual([
    "WARN CODEOWNERS: people.yaml has no owner entry",
    "WARN CODEOWNERS: .claude/ has no owner entry",
  ]);
  rmSync(join(root, ".github/CODEOWNERS"));
  rmSync(join(root, "CODEOWNERS"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/CODEOWNERS"), "**/*.yaml @owner\n.claud?/ @owner\n");
  expect(check(root).messages).toEqual([]);
  rmSync(join(root, "docs/CODEOWNERS"));
  mkdirSync(join(root, "docs/CODEOWNERS"));
  expect(check(root)).toMatchObject({
    code: 0,
    messages: [expect.stringContaining("cannot read")],
  });
});

test("check fails loudly for an unbound orchestrator pin or a repository no orchestrator binds", () => {
  const root = validProject();
  expect(check(root)).toEqual({ code: 0, messages: [] });
  const people = parse(readFileSync(join(root, "people.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  // The template's orchestrator pin without its repository binding.
  const unbound = people.map((person) => {
    if (person.role !== "orchestrator") {
      return person;
    }
    const { login, id, type, role } = person;
    return {
      login,
      id,
      type,
      role,
      ...(person.appIds ? { appIds: person.appIds } : {}),
      ...(person.events ? { events: person.events } : {}),
    };
  });
  writeFileSync(join(root, "people.yaml"), stringify(unbound));
  expect(check(root).code).toBe(1);
  expect(check(root).messages).toEqual([
    "people.yaml: orchestrator example-orchestrator has no repos binding; add repos: [<owner>/<repo>]",
    "people.yaml: no orchestrator binding lists example/project; add repos: [<owner>/<repo>]",
  ]);
  // A binding that misses the configured repository leaves only the repo error.
  writeFileSync(
    join(root, "people.yaml"),
    stringify(
      people.map((person) =>
        person.role === "orchestrator" ? { ...person, repos: ["example/other"] } : person
      )
    )
  );
  expect(check(root).messages).toEqual([
    "people.yaml: no orchestrator binding lists example/project; add repos: [<owner>/<repo>]",
  ]);
  // The owner-approved binding restores the check to green.
  writeFileSync(join(root, "people.yaml"), stringify(people));
  expect(check(root)).toEqual({ code: 0, messages: [] });
});

test("orchestrator check reports each missing git identity up front, workers do not need it", () => {
  const root = validProject();
  const missing = check(root, { VMETHOD_ROLE: "orchestrator" });
  expect(missing.code).toBe(1);
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    expect(missing.messages.join("\n")).toContain(key);
  }
  expect(check(root, { VMETHOD_ROLE: "worker" }).code).toBe(0);
  const identity = {
    VMETHOD_ROLE: "orchestrator",
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "a@b",
    GIT_COMMITTER_NAME: "C",
    GIT_COMMITTER_EMAIL: "c@b",
  };
  // The orchestrator also needs the workers' own clone to launch them in.
  const worker = fixture();
  expect(check(root, { ...identity, VMETHOD_WORKER_CHECKOUT: worker })).toEqual({
    code: 1,
    messages: [
      `workerCheckout ${worker} is not a git clone; clone the repository there for workers`,
    ],
  });
  mkdirSync(join(worker, ".git"));
  expect(check(root, { ...identity, VMETHOD_WORKER_CHECKOUT: worker }).code).toBe(0);
});

/** Point the fixture's workerCheckout at the fixture itself, like a worker clone's
 * copy of the repository config does (`../vecs-worker` resolves to itself there). */
function selfWorkerCheckout(root: string): void {
  const vmethod = join(root, "vmethod.yaml");
  const before = readFileSync(vmethod, "utf8");
  writeFileSync(
    vmethod,
    before.replace("workerCheckout: ../example-worker", `workerCheckout: ../${basename(root)}`)
  );
}

test("an orchestrator environment in the worker checkout gets the identity message, not the clone error", () => {
  const root = validProject();
  // The worker checkout's own .claude/settings.local.json declares the worker identity.
  writeFileSync(
    join(root, ".claude/settings.local.json"),
    JSON.stringify({ env: { VMETHOD_ROLE: "worker" } })
  );
  selfWorkerCheckout(root);
  const orchestrator = {
    VMETHOD_ROLE: "orchestrator",
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "a@b",
    GIT_COMMITTER_NAME: "C",
    GIT_COMMITTER_EMAIL: "c@b",
  };
  const result = check(root, orchestrator);
  expect(result.code).toBe(1);
  expect(result.messages).toEqual([
    "this is the worker checkout, but the environment is the orchestrator's (VMETHOD_ROLE=orchestrator); run check with this checkout's own .claude/settings.local.json env",
  ]);
  // With this checkout's own identity the same checkout checks green.
  expect(check(root, { ...orchestrator, VMETHOD_ROLE: "worker" })).toEqual({
    code: 0,
    messages: [],
  });
});

test("workerCheckout pointing at the orchestrator checkout still gets the clone error", () => {
  const root = validProject();
  // The orchestrator checkout's own .claude/settings.local.json declares the orchestrator identity.
  writeFileSync(
    join(root, ".claude/settings.local.json"),
    JSON.stringify({ env: { VMETHOD_ROLE: "orchestrator" } })
  );
  selfWorkerCheckout(root);
  const env = {
    VMETHOD_ROLE: "orchestrator",
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "a@b",
    GIT_COMMITTER_NAME: "C",
    GIT_COMMITTER_EMAIL: "c@b",
  };
  expect(check(root, env)).toEqual({
    code: 1,
    messages: ["workerCheckout must be a separate clone, not the orchestrator's checkout"],
  });
  // Without a declared role in this checkout's settings the refusal also stays.
  rmSync(join(root, ".claude/settings.local.json"));
  expect(check(root, env).messages).toEqual([
    "workerCheckout must be a separate clone, not the orchestrator's checkout",
  ]);
});

test("check requires .claude/ to be gitignored, since it holds each checkout's identity", () => {
  const root = validProject();
  expect(check(root).code).toBe(0);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  expect(check(root).messages).toContain(
    "Ignore .claude/ in .gitignore: each checkout keeps its own identity in .claude/settings.local.json"
  );
  writeFileSync(join(root, ".gitignore"), "/.claude\n!.claude/settings.json\n");
  expect(check(root).code).toBe(1);
  writeFileSync(join(root, ".gitignore"), "/.claude/\n");
  expect(check(root).code).toBe(0);
});

test("check returns 0 for a valid project, 1 for findings, 2 for a missing dependency", () => {
  const root = validProject();
  expect(check(root)).toEqual({ code: 0, messages: [] });
  peer(root, "11.0.0");
  expect(check(root)).toMatchObject({
    code: 1,
    messages: ["mermaid must equal 12.1.0; installed 11.0.0"],
  });
  rmSync(join(root, "node_modules/mermaid"), { recursive: true });
  expect(check(root)).toMatchObject({
    code: 2,
    messages: ["Dependency missing: install mermaid@12.1.0"],
  });
}, 15000);

test("permissions, numeric ids, model families and secret-looking values are checked without leaking secrets", () => {
  const root = validProject();
  writeFileSync(join(root, ".claude/settings.json"), "{}");
  writeFileSync(join(root, "people.yaml"), "- login: owner\n  id: wrong\n  role: owner\n");
  writeFileSync(
    join(root, "models.yaml"),
    "- family: wrong\n  model: a/b\n  kind: opencode\n  gate: none\n"
  );
  const path = join(root, "vmethod.yaml");
  const token = "ghp_" + "a".repeat(36);
  writeFileSync(path, readFileSync(path, "utf8") + `\ntrack: ${token}\n`);
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.messages.join("\n")).toContain("Secret-looking config value at track");
  expect(result.messages.join("\n")).not.toContain(token);
  expect(result.messages.join("\n")).toContain("people.yaml:");
  expect(result.messages.join("\n")).toContain("models.yaml:");
  expect(result.messages.join("\n")).toContain("Permission deny rule missing");
  expect(check(root, { VMETHOD_TRACK: "safe-override" }).messages.join("\n")).toContain(
    "environment overrides do not hide stored secrets"
  );
}, 15000);
