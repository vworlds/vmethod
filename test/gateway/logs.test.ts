import { expect, test } from "vitest";
import { GitHubClient, type Dependencies } from "../../src/gateway/client.js";

test("job logs follow one signed HTTPS redirect without sending API authorization to blob storage", async () => {
  let count = 0;
  const deps: Dependencies = {
    fetch: async (url, init) => {
      count++;
      if (count === 1) {
        expect(String(url)).toBe(
          "https://api.github.com/repos/example/project/actions/jobs/30/logs"
        );
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-token");
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://logs.example/signed?key=abc" },
        });
      }
      expect(count).toBe(2);
      expect(String(url)).toBe("https://logs.example/signed?key=abc");
      expect(init?.headers).toBeUndefined();
      expect(init?.redirect).toBe("error");
      return new Response("Error: private-token was mentioned in the log");
    },
    exec: async () => {
      throw new Error("Unexpected exec");
    },
    now: () => 0,
    sleep: async () => {
      throw new Error("Unexpected sleep");
    },
    report: () => {
      throw new Error("Unexpected report");
    },
  };
  const client = new GitHubClient(
    { credentials: { githubToken: "TOKEN" } },
    { TOKEN: "private-token" },
    deps
  );
  expect(await client.jobLog("/repos/example/project/actions/jobs/30/logs")).toBe(
    "Error: [redacted] was mentioned in the log"
  );
  expect(count).toBe(2);
});

test.each(["http://logs.example/log", "https://user:password@logs.example/log"])(
  "job log redirects reject unsafe destinations: %s",
  async (location) => {
    let calls = 0;
    const client = new GitHubClient(
      { credentials: { githubToken: "TOKEN" } },
      { TOKEN: "private-token" },
      {
        fetch: async () => {
          expect(++calls).toBe(1);
          return new Response(null, { status: 302, headers: { location } });
        },
        exec: async () => {
          throw new Error("Unexpected exec");
        },
        now: () => 0,
        sleep: async () => {
          throw new Error("Unexpected sleep");
        },
        report: () => {
          throw new Error("Unexpected report");
        },
      }
    );
    await expect(client.jobLog("/repos/example/project/actions/jobs/30/logs")).rejects.toThrow(
      "Invalid job log redirect"
    );
    expect(calls).toBe(1);
  }
);
