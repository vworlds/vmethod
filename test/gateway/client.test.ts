import { expect, test } from "vitest";
import { getConfig } from "../../src/config.js";
import { GitHubClient, OpencodeClient } from "../../src/gateway/client.js";
import { setTurn } from "../../src/gateway/turn.js";
import { fakeServer, fixtureServer } from "./helpers.js";
import recordedOpencode from "../fixtures/opencode/watch-status.json" with { type: "json" };
import recordedCostSession from "../fixtures/usage/opencode-session.json" with { type: "json" };
import recordedCostMessage from "../fixtures/usage/opencode-message.json" with { type: "json" };

test("cost lookup unwraps the recorded session and assistant-message envelopes", async () => {
  const requests: string[] = [];
  const client = new OpencodeClient(
    {
      OPENCODE_BASE_URL: "http://opencode.invalid",
      OPENCODE_SERVER_USERNAME: "user",
      OPENCODE_SERVER_PASSWORD: "pass",
    },
    async (input) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      requests.push(path);
      if (path === "/api/session/active") {
        return Response.json(recordedOpencode.active);
      }
      if (path === "/api/session/ses_recorded") {
        return Response.json(recordedCostSession);
      }
      if (path === "/api/session/ses_recorded/message?limit=200") {
        return Response.json(recordedCostMessage);
      }
      return Response.json({}, { status: 500 });
    }
  );
  const result = await client.costSession("ses_recorded");
  expect(requests).toEqual([
    "/api/session/ses_recorded",
    "/api/session/active",
    "/api/session/ses_recorded/message?limit=200",
  ]);
  expect(result).toMatchObject({
    session: { tokens: { input: 118893 } },
    messages: expect.any(Array),
    running: true,
  });
});

test("cost lookup follows message cursor pages", async () => {
  const requests: string[] = [];
  const client = new OpencodeClient(
    {
      OPENCODE_BASE_URL: "http://opencode.invalid",
      OPENCODE_SERVER_USERNAME: "user",
      OPENCODE_SERVER_PASSWORD: "pass",
    },
    async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname + url.search);
      if (url.pathname === "/api/session/active") {
        return Response.json(recordedOpencode.active);
      }
      if (url.pathname === "/api/session/ses_recorded") {
        return Response.json(recordedCostSession);
      }
      if (url.searchParams.get("cursor") === "older") {
        return Response.json({ data: [{ type: "assistant", id: "older" }], cursor: {} });
      }
      return Response.json({
        data: [{ type: "assistant", id: "newer" }],
        cursor: { previous: "older" },
      });
    }
  );
  const result = await client.costSession("ses_recorded");
  expect(requests).toContain("/api/session/ses_recorded/message?limit=200&cursor=older");
  expect(result).toMatchObject({ messages: [{ id: "newer" }, { id: "older" }] });
});

test.each(["running", "permission", "failed"])(
  "recorded data envelopes find the worker directory and %s state",
  async (state) => {
    const requests: string[] = [],
      unexpected: string[] = [],
      reports: string[] = [];
    const session = structuredClone(recordedOpencode.session);
    if (state === "failed") {
      session.data.outcome = "failed";
    }
    const client = new OpencodeClient(
      {
        OPENCODE_BASE_URL: "http://opencode.invalid",
        OPENCODE_SERVER_USERNAME: "user",
        OPENCODE_SERVER_PASSWORD: "pass",
      },
      async (input) => {
        const path = new URL(String(input)).pathname + new URL(String(input)).search;
        requests.push(path);
        if (path === "/api/session/active") {
          return Response.json(recordedOpencode.active);
        }
        if (path === "/api/session/ses_recorded") {
          return Response.json(session);
        }
        if (path === "/api/session/ses_recorded/permission") {
          return Response.json(
            state === "permission"
              ? { data: [{ id: "perm_test", type: "permission" }] }
              : recordedOpencode.permission
          );
        }
        if (path === "/api/session/ses_recorded/message?limit=20") {
          return Response.json(recordedOpencode.message);
        }
        unexpected.push(path);
        return Response.json(recordedOpencode.invalidRequest, { status: 400 });
      },
      Date.now,
      (message) => reports.push(message)
    );
    const status = await client.status("/work/recorded");
    expect(status.state).toBe(state === "running" ? "other" : state);
    const single = await client.status("/work/recorded", "ses_recorded");
    expect(single.reason).toBe(state === "permission" ? "permission-wait" : "running");
    expect(single.inputTokens).toBe(118893);
    expect("finalText" in single).toBe(false);
    expect(single.usage).toEqual({
      tokens: { input: 118893, output: 17446, cached: 3907968 },
      reportedUsd: 0,
    });
    expect(requests).toContain("/api/session/ses_recorded/permission");
    expect(unexpected).toEqual([]);
    expect(reports).toEqual([]);
  }
);

test("opencode poll isolates a session's 400, reports it once per status, and continues polling", async () => {
  const requests: string[] = [],
    reports: string[] = [];
  const unexpected: string[] = [];
  let status = 400;
  const client = new OpencodeClient(
    {
      OPENCODE_BASE_URL: "http://opencode.invalid",
      OPENCODE_SERVER_USERNAME: "secret-user",
      OPENCODE_SERVER_PASSWORD: "secret-password",
    },
    async (input) => {
      const url = new URL(String(input));
      const path = url.pathname + url.search;
      requests.push(path);
      if (path === "/api/session/active") {
        return Response.json({
          data: { ses_bad: { type: "running" }, ses_good: { type: "running" } },
        });
      }
      if (/^\/api\/session\/ses_(bad|good)$/.test(path)) {
        return Response.json({
          data: { ...recordedOpencode.session.data, location: { directory: "/work" } },
        });
      }
      if (path.endsWith("/permission")) {
        return Response.json(recordedOpencode.permission);
      }
      if (path === "/api/session/ses_bad/message?limit=20" && status !== 200) {
        return Response.json(
          { error: { message: `secret-user secret-password ${"x".repeat(250)}` } },
          { status }
        );
      }
      if (/^\/api\/session\/ses_(bad|good)\/message\?limit=20$/.test(path)) {
        return Response.json({
          data: [{ type: "idle", outcome: "failed", error: { message: "provider stopped" } }],
        });
      }
      unexpected.push(path);
      throw new Error(`Unexpected request ${path}`);
    },
    Date.now,
    (message) => reports.push(message)
  );
  expect(await client.status("/work")).toEqual({ state: "failed", detail: "provider stopped" });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain(
    "opencode HTTP 400 on GET /api/session/ses_bad/message?limit=20: [redacted] [redacted]"
  );
  expect(reports[0]).not.toContain("secret");
  expect(reports[0].split(": ").at(-1)!.length).toBeLessThanOrEqual(200);
  expect(await client.status("/other-worktree")).toEqual({ state: "other" });
  await client.status("/work");
  expect(reports).toHaveLength(1);
  status = 403;
  await client.status("/work");
  expect(reports).toHaveLength(2);
  status = 200;
  await client.status("/work");
  status = 400;
  await client.status("/work");
  expect(reports).toHaveLength(3);
  expect(requests.filter((path) => path === "/api/session/ses_good/message?limit=20")).toHaveLength(
    5
  );
  expect(unexpected).toEqual([]);
});

test("invalid active session ids are diagnosed without requesting them or losing valid sessions", async () => {
  const reports: string[] = [],
    unexpected: string[] = [];
  const client = new OpencodeClient(
    {
      OPENCODE_BASE_URL: "http://opencode.invalid",
      OPENCODE_SERVER_USERNAME: "user",
      OPENCODE_SERVER_PASSWORD: "pass",
    },
    async (input) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      if (path === "/api/session/active") {
        return Response.json({
          data: { data: { type: "running" }, ...recordedOpencode.active.data },
        });
      }
      if (path === "/api/session/ses_recorded") {
        return Response.json(recordedOpencode.session);
      }
      if (path === "/api/session/ses_recorded/permission") {
        return Response.json({ data: [{ id: "perm_test", type: "permission" }] });
      }
      unexpected.push(path);
      return Response.json(recordedOpencode.invalidRequest, { status: 400 });
    },
    Date.now,
    (message) => reports.push(message)
  );
  expect((await client.status("/work/recorded")).state).toBe("permission");
  await client.status("/work/recorded");
  expect(reports).toEqual([
    expect.stringContaining("Invalid opencode session id on GET /api/session/active"),
  ]);
  expect(unexpected).toEqual([]);
});

test("recorded opencode validation errors name method/path and flatten the JSON message", async () => {
  const client = new OpencodeClient(
    {
      OPENCODE_BASE_URL: "http://opencode.invalid",
      OPENCODE_SERVER_USERNAME: "user",
      OPENCODE_SERVER_PASSWORD: "pass",
    },
    async (input) => {
      expect(new URL(String(input)).pathname).toBe("/api/session/data");
      return Response.json(recordedOpencode.invalidRequest, { status: 400 });
    }
  );
  await expect(client.request("GET", "/api/session/data")).rejects.toThrow(
    'opencode HTTP 400 on GET /api/session/data: Expected a string starting with "ses"   at ["sessionID"]'
  );
});

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

test("REST errors include bounded, redacted GitHub validation details", async () => {
  const fixture = fixtureServer([
    {
      path: "/bad",
      method: "GET",
      status: 422,
      json: {
        message: "Validation Failed",
        errors: [{ message: "invalid", code: "invalid" }],
      },
    },
  ]);
  const client = new GitHubClient(getConfig(fixture.root, {}), fixture.env, fixture.deps);
  await expect(client.rest("/bad")).rejects.toThrow(
    'GitHub HTTP 422 on GET /bad: "Validation Failed"; "invalid (invalid)"'
  );
  fixture.done();
}, 15000);

test("setTurn treats a concurrent update to its target as success after 422", async () => {
  const fixture = fixtureServer([
    {
      path: "/repos/example/project/issues/6/assignees",
      method: "POST",
      status: 422,
      json: { message: "Validation Failed" },
    },
    {
      path: "/repos/example/project/issues/6",
      method: "GET",
      json: { assignees: [{ login: "OWNER" }] },
    },
  ]);
  const client = new GitHubClient(getConfig(fixture.root, {}), fixture.env, fixture.deps);
  await expect(setTurn(client, "example/project", 6, [], ["owner"])).resolves.toBeUndefined();
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
      if (count++ === 0) {
        return Response.json({ version: "fake" });
      }
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
