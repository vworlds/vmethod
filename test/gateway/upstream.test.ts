import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import packageMetadata from "../../package.json" with { type: "json" };
import { gatewayVerb } from "../../src/cli/gateway.js";
import { fixtureServer, type Request } from "./helpers.js";
import recorded from "../fixtures/github/learnings-recorded.json" with { type: "json" };

const central = "vworlds/vmethod";
const footer = `Filed from example/project (vmethod ${packageMetadata.version})`;
const bindAsk =
  "ask the vmethod owner to bind peer to example/project in vworlds/vmethod people.yaml";

/** The central registry read: vworlds/vmethod people.yaml from dev. */
function centralRegistry(entries: unknown[]): Request {
  return {
    path: `/repos/${central}/contents/people.yaml?ref=dev`,
    method: "GET",
    json: {
      ...recorded.people,
      content: Buffer.from(stringify(entries)).toString("base64"),
    },
  };
}

const viewer = (): Request => ({
  path: "/user",
  method: "GET",
  json: { login: "peer", id: 103, type: "User" },
});

/** The GraphQL issue lookup: an issue id, or null for a missing number or a PR. */
function centralIssueQuery(number: number, issue: unknown): Request {
  return {
    path: "/graphql",
    json: { data: { repository: { issue } } },
    checkQuery(query, variables) {
      expect(query).toContain("issue(number: $number)");
      expect(query).toContain("id");
      expect(query).not.toContain("body");
      expect(variables).toEqual({ owner: "vworlds", name: "vmethod", number });
    },
  };
}

const centralPin = [
  { login: "peer", id: 103, type: "User", role: "orchestrator", repos: ["example/project"] },
];

test("a centrally bound orchestrator files an upstream issue with the footer", async () => {
  const f = fixtureServer([
    centralRegistry(centralPin),
    viewer(),
    {
      path: `/repos/${central}/issues`,
      body: { title: "Need", body: `Context.\n\n${footer}` },
      json: { number: 42, node_id: "central-42" },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Context.\n\n\n");
  await expect(f.transport.call("upstreamIssue", { title: "Need", file })).resolves.toBe(
    `https://github.com/${central}/issues/42`
  );
  f.done();
});

test("a body without a trailing newline still gets the footer as its own line", async () => {
  const f = fixtureServer([
    centralRegistry(centralPin),
    viewer(),
    {
      path: `/repos/${central}/issues`,
      body: { title: "Need", body: `Context.\n\n${footer}` },
      json: { number: 43, node_id: "central-43" },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Context.");
  await expect(f.transport.call("upstreamIssue", { title: "Need", file })).resolves.toBe(
    `https://github.com/${central}/issues/43`
  );
  f.done();
});

test("an unbound caller is refused before any write, even when pinned locally", async () => {
  // fixtureServer pins peer locally, pinning example/project; the central registry does not.
  const f = fixtureServer([
    centralRegistry([{ login: "owner", id: 101, type: "User", role: "owner" }]),
    viewer(),
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Context.\n");
  await expect(f.transport.call("upstreamIssue", { title: "Need", file })).rejects.toThrow(bindAsk);
  f.done();
});

test.each([
  { ...centralPin[0], repos: ["example/other"] },
  { ...centralPin[0], id: 999 },
  { ...centralPin[0], login: "impostor" },
  { ...centralPin[0], type: "Bot" },
  { login: "peer", id: 103, type: "User", role: "collaborator" },
])("a mismatched central pin is refused before any write: %j", async (pin) => {
  const f = fixtureServer([centralRegistry([pin]), viewer()]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Context.\n");
  await expect(f.transport.call("upstreamIssue", { title: "Need", file })).rejects.toThrow(bindAsk);
  f.done();
});

test("an unbound caller cannot comment either", async () => {
  const f = fixtureServer([
    centralRegistry([{ login: "owner", id: 101, type: "User", role: "owner" }]),
    viewer(),
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Another occurrence.");
  await expect(f.transport.call("upstreamComment", { ref: "47", file })).rejects.toThrow(bindAsk);
  f.done();
});

test("an unclosed fence is refused before any networking", async () => {
  const f = fixtureServer([]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Context.\n```text\nraw\n");
  await expect(f.transport.call("upstreamIssue", { title: "Need", file })).rejects.toThrow(
    "Markdown has an unclosed code fence"
  );
  writeFileSync(file, "Raw.\n```text\nraw\n");
  await expect(f.transport.call("upstreamComment", { ref: "47", file })).rejects.toThrow(
    "Markdown has an unclosed code fence"
  );
  f.done();
});

test("a closing keyword is refused before any write", async () => {
  const f = fixtureServer([]);
  const file = join(f.root, "body.md");
  writeFileSync(file, " Fixes #1\n");
  await expect(f.transport.call("upstreamIssue", { title: "Need", file })).rejects.toThrow(
    "Post contains a forbidden closing or association keyword before an issue reference"
  );
  await expect(f.transport.call("upstreamComment", { ref: "47", file })).rejects.toThrow(
    "Post contains a forbidden closing or association keyword before an issue reference"
  );
  f.done();
});

test("an empty body is refused before any networking", async () => {
  const f = fixtureServer([]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "\n");
  await expect(f.transport.call("upstreamIssue", { title: "Need", file })).rejects.toThrow(
    "Post must contain nonempty Markdown"
  );
  await expect(f.transport.call("upstreamComment", { ref: "47", file })).rejects.toThrow(
    "Post must contain nonempty Markdown"
  );
  f.done();
});

test("closing syntax in an issue title is refused before any write", async () => {
  const f = fixtureServer([]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Context.");
  await expect(f.transport.call("upstreamIssue", { title: "Fixes #1", file })).rejects.toThrow(
    "forbidden closing"
  );
  f.done();
});

test.each([
  { path: "/repos/vworlds/vmethod/contents/people.yaml?ref=dev", method: "GET", status: 404 },
  { path: "/repos/vworlds/vmethod/contents/people.yaml?ref=dev", method: "GET", json: {} },
])("an absent or malformed central registry fails closed: %j", async (request) => {
  const f = fixtureServer([request]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Context.");
  await expect(f.transport.call("upstreamIssue", { title: "Need", file })).rejects.toThrow(
    /central.*registry/
  );
  f.done();
});

test("upstream issue refuses an invalid title before networking", async () => {
  const f = fixtureServer([]);
  for (const title of ["   ", "Need\n"]) {
    await expect(f.transport.call("upstreamIssue", { title, file: "missing" })).rejects.toThrow(
      "Invalid upstream issue title"
    );
  }
  f.done();
});

test("a bound caller comments on an existing central issue", async () => {
  const f = fixtureServer([
    centralRegistry(centralPin),
    viewer(),
    centralIssueQuery(47, { id: "central-node" }),
    {
      path: `/repos/${central}/issues/47/comments`,
      body: { body: "Another occurrence.\n" },
      json: { id: 981, node_id: "comment-node" },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Another occurrence.\n");
  await expect(
    gatewayVerb(f.gateway, "upstream", ["comment", "47", file], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).resolves.toBe(`Commented on https://github.com/${central}/issues/47`);
  f.done();
});

test("a comment body passes through verbatim, without an added footer", async () => {
  const f = fixtureServer([
    centralRegistry(centralPin),
    viewer(),
    centralIssueQuery(47, { id: "central-node" }),
    {
      path: `/repos/${central}/issues/47/comments`,
      body: { body: `Context.\n\n${footer}\n` },
      json: { id: 982, node_id: "comment-node-2" },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, `Context.\n\n${footer}\n`);
  await expect(f.transport.call("upstreamComment", { ref: "47", file })).resolves.toBe(
    `Commented on https://github.com/${central}/issues/47`
  );
  f.done();
});

test("upstream comment refuses a missing issue (including PR numbers) before any write", async () => {
  const f = fixtureServer([centralRegistry(centralPin), viewer(), centralIssueQuery(47, null)]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Another occurrence.\n");
  await expect(f.transport.call("upstreamComment", { ref: "47", file })).rejects.toThrow(
    `Upstream issue not found: ${central}#47`
  );
  f.done();
});

test.each(["0", "-3", "47.5", "vworlds/vmethod#47", "", "9007199254740992"])(
  "upstream comment refuses a non-numeric reference before networking: %s",
  async (ref) => {
    const f = fixtureServer([]);
    await expect(f.transport.call("upstreamComment", { ref, file: "missing" })).rejects.toThrow(
      "Invalid upstream issue reference"
    );
    f.done();
  }
);

test("upstream operations deny workers before any network", async () => {
  const f = fixtureServer([]);
  await expect(
    f.transport.call("upstreamIssue", { title: "Need", file: "missing" }, { role: "worker" })
  ).rejects.toThrow("denied for client role");
  await expect(
    f.transport.call("upstreamComment", { ref: "47", file: "missing" }, { role: "worker" })
  ).rejects.toThrow("denied for client role");
  f.done();
});

test("the CLI routes upstream to its operations and rejects other shapes", async () => {
  const f = fixtureServer([]);
  const usage = "Usage: upstream issue <title> <body-file> | upstream comment <n> <body-file>";
  for (const args of [
    [],
    ["issue"],
    ["issue", "Title"],
    ["issue", "Title", "file", "extra"],
    ["comment", "47"],
    ["comment", "47", "file", "extra"],
    ["pr", "47", "file"],
  ] as const) {
    await expect(
      gatewayVerb(f.gateway, "upstream", [...args], { VMETHOD_ROLE: "orchestrator" })
    ).rejects.toThrow(usage);
  }
  f.done();
});

test("the CLI files an upstream issue end to end", async () => {
  const f = fixtureServer([
    centralRegistry(centralPin),
    viewer(),
    {
      path: `/repos/${central}/issues`,
      body: { title: "Need", body: `Context.\n\n${footer}` },
      json: { number: 44, node_id: "central-44" },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Context.");
  await expect(
    gatewayVerb(f.gateway, "upstream", ["issue", "Need", file], { VMETHOD_ROLE: "orchestrator" })
  ).resolves.toBe(`https://github.com/${central}/issues/44`);
  f.done();
});
