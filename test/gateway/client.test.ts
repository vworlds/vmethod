import { expect, test } from "vitest";
import { getConfig } from "../../src/config.js";
import { GitHubClient, OpencodeClient } from "../../src/gateway/client.js";
import { fakeServer, fixtureServer } from "./helpers.js";

test("REST/GraphQL use only the configured token name, no exec, and reject cross-origin requests", async () => {
  const fixture = fixtureServer([
    { path: "/repos/example/project", method: "GET", json: { id: 3 } },
  ]);
  const client = new GitHubClient(
    getConfig(fixture.root, {}),
    { ...fixture.env, GH_TOKEN: "wrong-token" },
    {
      ...fixture.deps,
      fetch: async (url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-token");
        return fixture.deps.fetch(url, init);
      },
    }
  );
  expect(await client.rest("/repos/example/project")).toEqual({ id: 3 });
  await expect(client.rest("//evil.invalid")).rejects.toThrow("endpoint");
  expect(
    () => new GitHubClient(getConfig(fixture.root, {}), { GH_TOKEN: "wrong" }, fixture.deps)
  ).toThrow("Missing configured");
  fixture.done();
}, 15000);

test("network errors and 5xx retry with reported exponential backoff; failures propagate", async () => {
  const fixture = fixtureServer([
    { path: "/test", method: "GET", error: true },
    { path: "/test", method: "GET", status: 503 },
    { path: "/test", method: "GET", json: { ok: true } },
    { path: "/bad", method: "GET", status: 401 },
  ]);
  const client = new GitHubClient(getConfig(fixture.root, {}), fixture.env, fixture.deps);
  expect(await client.rest("/test")).toEqual({ ok: true });
  expect(fixture.sleeps).toEqual([1000, 2000]);
  expect(fixture.reports).toHaveLength(2);
  await expect(client.rest("/bad")).rejects.toThrow("401");
  fixture.done();
}, 15000);

test.each([{}, { data: { accepted: true } }])(
  "GraphQL errors reject HTTP 200, including partial data: %j",
  async (payload) => {
    const fixture = fixtureServer([
      {
        path: "/graphql",
        json: {
          ...payload,
          errors: [{ message: "do not use fake-token partial data" }],
        },
      },
    ]);
    const client = new GitHubClient(getConfig(fixture.root, {}), fixture.env, fixture.deps);
    await expect(client.graphql("query { viewer { login } }")).rejects.toThrow(
      "do not use [redacted] partial data"
    );
    fixture.done();
  },
  15000
);

test("rate headers pace above the configured reserve, never the GraphQL rateLimit field", async () => {
  const fixture = fixtureServer([
    {
      path: "/graphql",
      json: { data: { rateLimit: { remaining: 999999 } } },
      headers: {
        "x-ratelimit-remaining": "8",
        "x-ratelimit-reset": String((Date.UTC(2026, 0, 1) + 4000) / 1000),
      },
    },
    { path: "/test", method: "GET", json: {} },
  ]);
  const client = new GitHubClient(
    { ...getConfig(fixture.root, {}), gateway: { reserve: 7 } },
    fixture.env,
    fixture.deps
  );
  await client.graphql("query { rateLimit { remaining } }");
  expect(fixture.sleeps).toEqual([]);
  await client.rest("/test");
  expect(fixture.sleeps).toEqual([4000]);
  expect(fixture.reports).toEqual(["BUDGET: paused before reserve"]);
  fixture.done();
}, 15000);

test.each([403, 429])(
  "secondary limits honor retry-after before backoff despite healthy remaining budget: %i",
  async (status) => {
    const fixture = fixtureServer([
      {
        path: "/test",
        method: "GET",
        status,
        headers: { "retry-after": "3", "x-ratelimit-remaining": "4000" },
      },
      { path: "/test", method: "GET", json: {} },
    ]);
    const client = new GitHubClient(getConfig(fixture.root, {}), fixture.env, fixture.deps);
    await client.rest("/test");
    expect(fixture.sleeps).toEqual([3000]);
    expect(fixture.reports).toEqual(["BUDGET (secondary): honoring retry-after"]);
    fixture.done();
  },
  15000
);

test("opencode fake server receives Basic auth only in a header and errors are surfaced", async () => {
  let count = 0;
  const client = new OpencodeClient(
    {
      OPENCODE_BASE_URL: "https://fake-opencode.invalid",
      OPENCODE_SERVER_USERNAME: "worker",
      OPENCODE_SERVER_PASSWORD: "secret-only-in-header",
    },
    async (url, init) => {
      expect(String(url)).toBe("https://fake-opencode.invalid/api/info");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("worker:secret-only-in-header").toString("base64")}`
      );
      if (count++ === 0) return Response.json({ version: "fake" });
      return new Response("", { status: 500 });
    }
  );
  expect(await client.request("GET", "/api/info")).toEqual({ version: "fake" });
  await expect(client.request("GET", "/api/info")).rejects.toThrow("500");
  await expect(client.request("GET", "//evil.invalid")).rejects.toThrow("Invalid");
  expect(count).toBe(2);
  expect(() => new OpencodeClient({}, fakeServer([]).fetch)).toThrow("Missing OPENCODE");
}, 15000);

test.each([true, false])(
  "exhausted retries are failures, not empty successful results (network=%s)",
  async (network) => {
    const fixture = fixtureServer(
      Array.from({ length: 2 }, () => ({
        path: "/test",
        method: "GET",
        ...(network ? { error: true } : { status: 503 }),
      }))
    );
    const client = new GitHubClient(
      { ...getConfig(fixture.root, {}), gateway: { maxRetries: 1 } },
      fixture.env,
      fixture.deps
    );
    await expect(client.rest("/test")).rejects.toThrow(network ? "network request failed" : "503");
    expect(fixture.sleeps).toEqual([1000]);
    fixture.done();
  },
  15000
);

test("secondary HTTP-date limits, malformed headers and terminal limits are explicit", async () => {
  const fixture = fixtureServer([
    {
      path: "/date",
      method: "GET",
      status: 429,
      headers: {
        "retry-after": new Date(Date.UTC(2026, 0, 1) + 5000).toUTCString(),
        "x-ratelimit-remaining": "4000",
      },
    },
    { path: "/date", method: "GET" },
    {
      path: "/bad",
      method: "GET",
      status: 429,
      headers: { "retry-after": "nonsense" },
    },
    {
      path: "/reset",
      method: "GET",
      headers: { "x-ratelimit-remaining": "0" },
    },
    {
      path: "/stop",
      method: "GET",
      status: 403,
      headers: { "retry-after": "1" },
    },
  ]);
  const config = getConfig(fixture.root, {});
  const client = new GitHubClient(config, fixture.env, fixture.deps);
  await client.rest("/date");
  expect(fixture.sleeps).toEqual([5000]);
  await expect(client.rest("/bad")).rejects.toThrow("invalid retry-after");
  await expect(client.rest("/reset")).rejects.toThrow("reset header");
  const noRetries = new GitHubClient(
    { ...config, gateway: { maxRetries: 0 } },
    fixture.env,
    fixture.deps
  );
  await expect(noRetries.rest("/stop")).rejects.toThrow("BUDGET (secondary): retry limit");
  fixture.done();
}, 15000);

test("missing GraphQL data and malformed JSON fail without exposing response snippets", async () => {
  const fixture = fixtureServer([
    { path: "/graphql", json: { errors: [] } },
    { path: "/test", method: "GET", text: "secret fake-token not json" },
  ]);
  const client = new GitHubClient(getConfig(fixture.root, {}), fixture.env, fixture.deps);
  await expect(client.graphql("{ viewer { login } }")).rejects.toThrow("missing data");
  await expect(client.rest("/test")).rejects.toThrow("GitHub returned invalid JSON");
  fixture.done();
}, 15000);
