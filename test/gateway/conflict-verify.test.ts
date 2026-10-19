import { expect, test, vi } from "vitest";
import { fixture } from "../helpers.js";
import { verifyConflictHead } from "../../src/gateway/verify-hook.js";
import type { Dependencies } from "../../src/gateway/client.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("conflict verification skips an absent hook but still pins the clean head", async () => {
  const root = fixture();
  const head = "a".repeat(40);
  const calls: string[][] = [];
  const deps: Dependencies = {
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file === "git" && args.join(" ") === "status --porcelain") {
        return "";
      }
      if (file === "git" && args.join(" ") === "rev-parse HEAD") {
        return head;
      }
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    },
    fetch: async () => {
      throw new Error("Unexpected network request");
    },
    now: () => 0,
    sleep: async () => {
      throw new Error("Unexpected sleep");
    },
    report: vi.fn(),
  };
  expect(
    await verifyConflictHead(
      root,
      head,
      { repo: "example/project" },
      { XDG_STATE_HOME: root },
      deps
    )
  ).toBe(true);
  expect(calls).toEqual([
    ["git", "status", "--porcelain"],
    ["git", "status", "--porcelain"],
    ["git", "rev-parse", "HEAD"],
  ]);
  expect(deps.report).toHaveBeenCalledWith(
    "conflict resolution: no verify hook; local verify skipped, green CI still required"
  );
});

test.each([true, false])(
  "installed conflict hook is run with merge scope; success=%s",
  async (success) => {
    const root = fixture();
    mkdirSync(join(root, "scripts/vmethod-hooks"), { recursive: true });
    writeFileSync(join(root, "scripts/vmethod-hooks/verify"), "#!/bin/sh\n", { mode: 0o755 });
    const head = "a".repeat(40);
    const deps: Dependencies = {
      exec: async (file, args, options) => {
        if (file === "git" && args.join(" ") === "status --porcelain") {
          return "";
        }
        if (file === "git" && args.join(" ") === "rev-parse HEAD") {
          return head;
        }
        if (file === "/bin/sh") {
          expect(args.slice(-2)).toEqual(["--scope", "merge"]);
          expect(options?.env).not.toHaveProperty("TOKEN");
          writeFileSync(args[3], "hook result\n");
          if (!success) {
            throw new Error("hook failed");
          }
          return "";
        }
        throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
      },
      fetch: async () => {
        throw new Error("Unexpected network request");
      },
      now: () => 0,
      sleep: async () => {
        throw new Error("Unexpected sleep");
      },
      report: vi.fn(),
    };
    expect(
      await verifyConflictHead(
        root,
        head,
        { repo: "example/project" },
        { XDG_STATE_HOME: root, TOKEN: "secret" },
        deps
      )
    ).toBe(success);
    expect(deps.report).not.toHaveBeenCalled();
  }
);
