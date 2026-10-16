import { describe, expect, it } from "vitest";
import { isValidSubject } from "../.husky/commit-msg.mjs";
import { needsTypecheck } from "../.husky/needs-typecheck.mjs";

describe("commit message subject validation", () => {
  it.each(['Merge remote-tracking branch "origin/dev"', 'Revert "feat: add feature"'])(
    "accepts %s subjects",
    (subject) => {
      expect(isValidSubject(subject)).toBe(true);
    }
  );

  it("rejects scoped conventional subjects", () => {
    expect(isValidSubject("fix(x): y")).toBe(false);
  });
});

describe("staged typecheck detection", () => {
  it.each([
    "src/widget.js",
    "scripts/task.mjs",
    "test/fixture.cjs",
    "test/unit/example.json",
    "bench/measure.json",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "deps.lock",
    "tsconfig.json",
    "eslint.config.mjs",
    "vitest.config.ts",
  ])("runs typecheck for %s", (path) => {
    expect(needsTypecheck([path])).toBe(true);
  });

  it.each(["docs/guide.md", "notes.md", "README.txt", "CHANGELOG.rst"])(
    "skips documentation file %s",
    (path) => {
      expect(needsTypecheck([path])).toBe(false);
    }
  );
});
