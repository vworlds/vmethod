import { expect, test, vi } from "vitest";
import { watchClient } from "../src/cli/watch.js";
import { gatewayVerb } from "../src/cli/gateway.js";
import type { Transport } from "../src/gateway/transport.js";
import { fixtureServer } from "./gateway/helpers.js";

test("--once writes the settled batch completely before a zero-timeout ack", async () => {
  const call = vi.fn<Transport["call"]>();
  const events = [
    { id: "c-1", kind: "question", line: "QUESTION #1", quiet: ["NOTE #1"] },
    { id: "c-2", kind: "comment", line: "COMMENT #2" },
  ];
  call.mockResolvedValueOnce({ events }).mockResolvedValueOnce({ events: [] });
  const writes: string[] = [];
  await watchClient(
    { call },
    ["--once", "--only", "1,2"],
    { VMETHOD_ROLE: "orchestrator" },
    async (text) => {
      expect(call).toHaveBeenCalledTimes(1);
      writes.push(text);
    }
  );
  expect(writes).toEqual([
    "quiet since the last wake-up:\n  NOTE #1\nQUESTION #1\n",
    "COMMENT #2\n",
  ]);
  expect(call.mock.calls[1]).toEqual([
    "nextEvents",
    { only: [1, 2], timeoutSeconds: 0, ack: ["c-1", "c-2"] },
    { role: "orchestrator" },
  ]);
});

test("stdout failure never acknowledges a batch; timeouts re-arm instead of exiting", async () => {
  const call = vi.fn<Transport["call"]>();
  call
    .mockResolvedValueOnce({ events: [] })
    .mockResolvedValueOnce({ events: [{ id: "1", kind: "comment", line: "COMMENT" }] });
  await expect(
    watchClient({ call }, ["--once"], {}, async () => {
      throw new Error("closed stdout");
    })
  ).rejects.toThrow("closed stdout");
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.every(([, input]) => !("ack" in input) || !input.ack?.length)).toBe(true);
});

test("watch and mute operations are orchestrator-only, local mute commands need no network", async () => {
  const f = fixtureServer([]);
  for (const operation of ["nextEvents", "watchMute", "watchUnmute", "watchMutes"] as const) {
    await expect(
      f.gateway.call(operation, { ref: "6", timeoutSeconds: 0 } as never, { role: "worker" })
    ).rejects.toThrow("denied");
  }
  expect(
    await gatewayVerb(f.transport, "mute", ["vworlds/vmethod#6"], { VMETHOD_ROLE: "orchestrator" })
  ).toContain("muted");
  expect(await gatewayVerb(f.transport, "mutes", [], { VMETHOD_ROLE: "orchestrator" })).toContain(
    "vworlds/vmethod#6"
  );
  expect(
    await gatewayVerb(f.transport, "unmute", ["vworlds/vmethod#6"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).toContain("unmuted");
  f.done();
});
