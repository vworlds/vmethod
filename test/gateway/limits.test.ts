import { expect, test, vi } from "vitest";
import { OpencodeClient } from "../../src/gateway/client.js";
import {
  decodeLimits,
  limitSummary,
  modelProvider,
  QuotaCrossings,
} from "../../src/gateway/limits.js";
import recording from "../fixtures/limits/2026-10-28.json" with { type: "json" };

const now = Date.parse(recording.checkedAt);
const env = {
  OPENCODE_BASE_URL: "https://opencode.invalid",
  OPENCODE_SERVER_USERNAME: "user",
  OPENCODE_SERVER_PASSWORD: "password",
};
test("optional limits RPC uses existing authentication, output envelope and a 60s cache", async () => {
  let clock = now;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://opencode.invalid/api/rpc/oc-limits/limits");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("user:password").toString("base64")}`,
    });
    expect(JSON.parse(String(init?.body))).toEqual({ input: {} });
    return Response.json({ output: recording });
  });
  const client = new OpencodeClient(env, fetcher, () => clock);
  expect(await client.limits()).toEqual(recording);
  clock += 59999;
  expect(await client.limits()).toEqual(recording);
  expect(fetcher).toHaveBeenCalledTimes(1);
  clock++;
  await client.limits();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test.each([404, 500, "RpcError", "network"])(
  "unavailable RPC %s leaves all providers unknown and caches failure",
  async (failure) => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (failure === "network") {
        throw new Error("offline");
      }
      return Response.json(
        { error: { name: "RpcError", message: "not installed" } },
        { status: typeof failure === "number" ? failure : 200 }
      );
    });
    const client = new OpencodeClient(env, fetcher, () => now);
    expect(decodeLimits(await client.limits(), now)).toEqual([]);
    expect(decodeLimits(await client.limits(), now)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
);
test("recorded readings compute any-window risk and elapsed-share slack, preserving missing timing", () => {
  const readings = decodeLimits(recording, now);
  expect(readings.map((r) => [r.provider, r.atRisk])).toEqual([
    ["ollama-cloud", true],
    ["claude-code", false],
    ["codexbal", false],
  ]);
  expect(readings[0].windows[0].slack).toBeUndefined();
  const claude = readings[1];
  expect(claude.windows).toHaveLength(3);
  expect(claude.windows[0].slack).toBeCloseTo(64.3756, 3);
  expect(claude.windows[1].slack).toBeCloseTo(8.2691, 3);
  expect(claude.windows[2]).toMatchObject({ model: "Fable" });
  expect(claude.windows[2].slack).toBeCloseTo(16.269, 3);
  expect(readings[2].windows[0].slack).toBeUndefined();
  expect(modelProvider({ model: "custom/model", provider: "codexbal" })).toBe("codexbal");
  expect(
    limitSummary({ family: "fable", model: "claude-code/fable", gate: "owner" }, readings)
  ).toContain("slack +16.3 (expiring unused); owner-gated");
});
test.each(["unsupported", "stale", "rate_limited", "error"])(
  "%s is unknown, never at risk or preferred",
  (status) => {
    expect(decodeLimits({ providers: [{ ...recording.providers[1], status }] }, now)).toEqual([]);
  }
);
test("risk threshold is strict and unknown/expired/invalid windows do not create readings", () => {
  const report = (remainingPercent: unknown) => ({
    providers: [
      { providerID: "test", status: "ok", windows: [{ id: "session", remainingPercent }] },
    ],
  });
  expect(decodeLimits(report(15), now)[0].atRisk).toBe(false);
  expect(decodeLimits(report(14.99), now)[0].atRisk).toBe(true);
  expect(decodeLimits(report(14.99), now, 10)[0].atRisk).toBe(false);
  for (const value of [-1, 101, null, "0", NaN]) {
    expect(decodeLimits(report(value), now)).toEqual([]);
  }
  expect(decodeLimits(recording, Date.parse("2026-11-03")).map((r) => r.provider)).toEqual([
    "codexbal",
  ]);
});
test("any exhausted window flags risk and the binding window names QUOTA and recovery", () => {
  const report = (session: number, weekly: number) => ({
    providers: [
      {
        providerID: "ollama-cloud",
        status: "ok",
        windows: [
          { id: "session", remainingPercent: session },
          { id: "weekly", remainingPercent: weekly, resetsAt: "2026-11-02T00:00:00.000Z" },
        ],
      },
    ],
  });
  const workers = [{ pr: 452, family: "glm", provider: "ollama-cloud" }];
  const exhaustedWeekly = decodeLimits(report(99.13, 0), now);
  expect(exhaustedWeekly[0].atRisk).toBe(true);
  const crossings = new QuotaCrossings();
  expect(crossings.update(exhaustedWeekly, workers)).toEqual([
    "QUOTA ollama-cloud weekly 0% left (resets 2026-11-02T00:00:00.000Z); at risk: #452 (glm)",
  ]);
  const shortWindowStillLow = decodeLimits(report(10, 40), now);
  expect(shortWindowStillLow[0].atRisk).toBe(true);
  expect(crossings.update(shortWindowStillLow, workers)).toEqual([]);
  const recovered = decodeLimits(report(20, 30), now);
  expect(recovered[0].atRisk).toBe(false);
  expect(crossings.update(recovered, workers)).toEqual([
    "QUOTA ollama-cloud recovered (session 20%)",
  ]);
  const tied = new QuotaCrossings();
  expect(tied.update(decodeLimits(report(0, 0), now), workers)).toEqual([
    "QUOTA ollama-cloud session 0% left (resets unknown); at risk: #452 (glm)",
  ]);
});
test("one QUOTA per crossing and one recovery; unknown does not invent recovery", () => {
  const crossings = new QuotaCrossings();
  const workers = [{ pr: 378, family: "glm", provider: "ollama-cloud" }];
  const readings = decodeLimits(recording, now);
  expect(crossings.update(readings, [])).toEqual([]);
  expect(crossings.update(readings, workers)).toEqual([
    "QUOTA ollama-cloud session 0% left (resets 2026-10-29T00:00:00.000Z); at risk: #378 (glm)",
  ]);
  expect(crossings.update(readings, workers)).toEqual([]);
  expect(new QuotaCrossings(crossings.snapshot()).update(readings, workers)).toEqual([]);
  expect(crossings.update([], workers)).toEqual([]);
  const recovered = structuredClone(readings);
  recovered[0].atRisk = false;
  recovered[0].windows[0].remainingPercent = 80;
  recovered[0].windows[1].remainingPercent = 80;
  expect(crossings.update(recovered, workers)).toEqual([
    "QUOTA ollama-cloud recovered (session 80%)",
  ]);
  expect(crossings.update(recovered, workers)).toEqual([]);
  expect(crossings.update(readings, workers)).toHaveLength(1);
});
