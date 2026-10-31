import { afterEach, expect, test, vi } from "vitest";
import { watchClient } from "../src/cli/watch.js";
import type { Operations, Transport } from "../src/gateway/transport.js";

type Batch = Operations["nextEvents"]["output"];

afterEach(() => vi.useRealTimers());

function watcher(settings: Partial<Batch> = {}) {
  vi.useFakeTimers();
  const stopping = new AbortController();
  let deliver: (batch: Batch) => void = () => {
    throw new Error("no collecting call");
  };
  const call = vi.fn<Transport["call"]>().mockImplementation(
    () =>
      new Promise<Batch>((resolve) => {
        deliver = resolve;
      }) as never
  );
  const writes: string[] = [];
  const write = vi.fn(async (text: string) => {
    writes.push(text);
  });
  const run = watchClient({ call }, [], {}, write, stopping.signal);
  return {
    call,
    writes,
    write,
    run,
    async send(lines: string[], extra: Partial<Batch> = {}) {
      deliver({
        events: lines.map((line) => ({ id: line, kind: "comment", line })),
        ...settings,
        ...extra,
      });
      await vi.advanceTimersByTimeAsync(0);
    },
    async stop() {
      stopping.abort();
      await run;
    },
  };
}

test("three arrivals inside silence become one ordered tab bundle; ack follows the write", async () => {
  const f = watcher();
  await f.send(["one"]);
  await vi.advanceTimersByTimeAsync(400);
  await f.send(["two"]);
  await vi.advanceTimersByTimeAsync(400);
  await f.send(["three"]);
  expect(f.writes).toEqual([]);
  expect(f.call.mock.calls.slice(1).map(([, input]) => input)).toEqual([
    { timeoutSeconds: 300, ack: [], exclude: ["one"] },
    { timeoutSeconds: 300, ack: [], exclude: ["one", "two"] },
    { timeoutSeconds: 300, ack: [], exclude: ["one", "two", "three"] },
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.writes).toEqual(["one\ttwo\tthree\n"]);
  await f.send([]);
  expect(f.call.mock.lastCall?.[1]).toMatchObject({ ack: ["one", "two", "three"] });
  await f.stop();
});

test("a gap beyond silence produces two lines", async () => {
  const f = watcher();
  await f.send(["one"]);
  await vi.advanceTimersByTimeAsync(1100);
  await f.send(["two"]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.writes).toEqual(["one\n", "two\n"]);
  await f.stop();
});

test("notice, quiet notes, event and reminder retain order and sanitize embedded tabs", async () => {
  const f = watcher();
  await f.send([], {
    notice: "guide",
    reminder: "REMINDER",
    events: [{ id: "e", kind: "comment", line: "EVENT", quiet: ["NOTE\ttext", "NOTE2"] }],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.writes).toEqual([
    "guide\tquiet since the last wake-up:\tNOTE text\tNOTE2\tEVENT\tREMINDER\n",
  ]);
  await f.send([]);
  expect(f.call.mock.lastCall?.[1]).toMatchObject({ ack: ["e"], guideSeen: true });
  await f.stop();
});

test("the cap flushes a continuous stream even with a collecting call still in flight", async () => {
  const f = watcher({ debounceSeconds: 1, debounceMaxSeconds: 2 });
  await f.send(["one"]);
  await vi.advanceTimersByTimeAsync(800);
  await f.send(["two"]);
  await vi.advanceTimersByTimeAsync(800);
  await f.send(["three"]);
  await vi.advanceTimersByTimeAsync(400);
  expect(f.writes).toEqual(["one\ttwo\tthree\n"]);
  await f.stop();
});

test("zero debounce prints immediately one line per event", async () => {
  const f = watcher({ debounceSeconds: 0 });
  await f.send(["one", "two", "three"]);
  expect(f.writes).toEqual(["one\n", "two\n", "three\n"]);
  expect(f.call.mock.lastCall?.[1]).toMatchObject({ ack: ["one", "two", "three"] });
  await f.stop();
});

test("SIGTERM stop signal flushes without waiting for the outstanding poll", async () => {
  const f = watcher();
  await f.send(["one", "two"]);
  expect(f.writes).toEqual([]);
  await f.stop();
  expect(f.writes).toEqual(["one\ttwo\n"]);
});

test("failed bundle output never sends an acknowledgement", async () => {
  const f = watcher();
  f.write.mockRejectedValueOnce(new Error("closed stdout"));
  const rejected = expect(f.run).rejects.toThrow("closed stdout");
  await f.send(["one"]);
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(f.call.mock.calls.every(([, input]) => !("ack" in input) || !input.ack?.length)).toBe(
    true
  );
});

test("an unfinished stdout write cannot be acknowledged by collection", async () => {
  const f = watcher();
  let finish: () => void = () => {
    throw new Error("write not started");
  };
  f.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await f.send([], {
    events: [{ id: "budget", kind: "budget", line: "BUDGET: paused before reserve" }],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.write).toHaveBeenCalledWith("BUDGET: paused before reserve\n");
  expect(f.call.mock.calls.every(([, input]) => !("ack" in input) || !input.ack?.length)).toBe(
    true
  );
  finish();
  await vi.advanceTimersByTimeAsync(0);
  await f.send([]);
  expect(f.call.mock.lastCall?.[1]).toMatchObject({ ack: ["budget"] });
  await f.stop();
});
