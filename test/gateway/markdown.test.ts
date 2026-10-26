import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  checkMarkdown,
  guardClosingKeywords,
  guardDependencyText,
  guardProtocolHeader,
} from "../../src/gateway/markdown.js";
import { fixture } from "../helpers.js";

test("Markdown fence checking accepts balanced mixed fences", async () => {
  await expect(
    checkMarkdown(fixture(), "Text\n````text\n```\n````\n~~~\nbody\n~~~")
  ).resolves.toBeUndefined();
});

test.each([
  ["   ", "nonempty"],
  ["~~~\nbody\n~~", "unclosed"],
])("Markdown fence checking rejects %j", async (source, message) => {
  await expect(checkMarkdown(fixture(), source)).rejects.toThrow(message);
});

function mermaidFixture() {
  const root = fixture();
  const mermaid = join(root, "node_modules/mermaid");
  const jsdom = join(root, "node_modules/jsdom");
  mkdirSync(mermaid, { recursive: true });
  mkdirSync(jsdom, { recursive: true });
  writeFileSync(
    join(mermaid, "package.json"),
    JSON.stringify({
      name: "mermaid",
      version: "12.1.0",
      type: "module",
      main: "index.mjs",
    })
  );
  writeFileSync(
    join(mermaid, "index.mjs"),
    `
    if (!globalThis.window || !globalThis.document) throw new Error('DOM missing during import');
    export default {
      initialize(options) { if (options.securityLevel !== 'strict') throw new Error('Unsafe initialization'); },
      async parse(text) { if (text !== 'graph TD; A-->B') throw new Error('Invalid Mermaid fixture diagram'); }
    };
  `
  );
  writeFileSync(join(jsdom, "package.json"), JSON.stringify({ name: "jsdom", main: "index.cjs" }));
  writeFileSync(
    join(jsdom, "index.cjs"),
    "exports.JSDOM = class { window = { document: {}, close() {} }; };"
  );
  return root;
}

test("Mermaid uses exact-version installed peers for a valid diagram", async () => {
  await expect(
    checkMarkdown(mermaidFixture(), "```mermaid\ngraph TD; A-->B\n```")
  ).resolves.toBeUndefined();
}, 10000);

test("Mermaid parses every diagram and restores the DOM on failure", async () => {
  const root = mermaidFixture();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  await expect(
    checkMarkdown(root, "```mermaid\ngraph TD; A-->B\n```\n```mermaid\ninvalid\n```")
  ).rejects.toThrow("Invalid Mermaid fixture");
  expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(previousWindow);
  expect(Object.getOwnPropertyDescriptor(globalThis, "document")).toEqual(previousDocument);
}, 10000);

test("Mermaid refuses version drift", async () => {
  // A different root avoids Node's package metadata cache.
  const other = fixture();
  mkdirSync(join(other, "node_modules/mermaid"), { recursive: true });
  writeFileSync(join(other, "node_modules/mermaid/package.json"), '{"version":"0.0.0"}');
  await expect(checkMarkdown(other, "```mermaid\nx\n```")).rejects.toThrow("mermaid must equal");
});

test("closing guard rejects fenced or formatted closing phrases but permits ordinary nonclosing references", () => {
  for (const text of [
    "Close #4",
    "Fix #4",
    "Resolves org/repo#4",
    "part\nof #4",
    "```\nfixes #4\n```",
  ]) {
    expect(() => guardClosingKeywords(text)).toThrow("forbidden");
  }
  expect(() => guardClosingKeywords("Related to #4; this fixes the parser.")).not.toThrow();
}, 15000);

test("dependency guard refuses dependency-only lines in every tolerated form", () => {
  for (const line of [
    "Blocked by #379",
    "**Blocked by #379**",
    "- Depends on #12",
    "* blocked by vworlds/vecs#7",
    "+ Depends on vworlds/vmethod#12",
    "  - **Depends on #12** ",
    "Blocked by #379\r",
  ]) {
    expect(() => guardDependencyText(line)).toThrow(
      "dependencies go in the blocked-by relation: vmethod issue block <n> <blocker>"
    );
  }
});

test("dependency guard permits prose that only mentions an issue", () => {
  for (const line of [
    "Uses the API from #379",
    "Uses the API from #379 (blocked by it earlier).",
    "Depends on the parser: see #12.",
    "**Blocked by #379** needs the new API",
    "Depends on 5",
    "`Depends on #12`",
    "Fixes Blocked by: see #4",
  ]) {
    expect(() => guardDependencyText(line)).not.toThrow();
  }
});

test.each([
  { body: "[worker] ACK\n\nplan.", header: "[worker] ACK" },
  { body: "[orchestrator] ANSWER (round 1)", header: "[orchestrator] ANSWER (round 1)" },
  {
    body: "[worker] READY FOR REVIEW (round 2)\n\nevidence",
    header: "[worker] READY FOR REVIEW (round 2)",
  },
  { body: "[orchestrator]", header: "[orchestrator]" },
  {
    body: "\n\n[orchestrator] REVIEW round 2\n\nbody",
    header: "[orchestrator] REVIEW round 2",
  },
  { body: "  [worker] BLOCKED\n", header: "[worker] BLOCKED" },
  { body: "[worker] ACK\r\nbody", header: "[worker] ACK" },
])("protocol header guard refuses a body opening with $header", ({ body, header }) => {
  expect(() => guardProtocolHeader(body, "review")).toThrow(
    `First non-blank line is the protocol header ${JSON.stringify(header)}; review adds the header itself`
  );
});

test("protocol header guard accepts bodies that only mention a header later", () => {
  for (const body of [
    "Mentions the [orchestrator] ANSWER from the earlier round.\n",
    "The card showed [worker] READY FOR REVIEW (round 1) first.\n",
    "[vmethod] ACK\n",
    "[workerless] x\n",
    "[workers] x\n",
    "[worker]ACK\n",
    "",
  ]) {
    expect(() => guardProtocolHeader(body, "review")).not.toThrow();
  }
});
