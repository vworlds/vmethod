import { describe, expect, it } from "vitest";
import { batchPages, pages, pageCursor, restPages } from "../../src/github/pages.js";

const errors = { connectionError: "Missing connection", cursorError: "Invalid cursor" };
const connection = (cursor: unknown, more: unknown = true) => ({
  nodes: [{ id: cursor }],
  pageInfo: { hasNextPage: more, endCursor: cursor },
});
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of input) {
    output.push(value);
  }
  return output;
}

describe("GitHub pages", () => {
  it("keeps forward cursor variables and node order, including a final empty page", async () => {
    const requests: (string | null)[] = [];
    const result = await collect(
      pages(async (cursor) => {
        requests.push(cursor);
        return cursor === null ? connection("a") : { nodes: [], pageInfo: { hasNextPage: false } };
      }, errors)
    );
    expect(requests).toEqual([null, "a"]);
    expect(result.map((page) => page.nodes)).toEqual([[{ id: "a" }], []]);
  });

  it("keeps backward before variables and page order", async () => {
    const requests: (string | null)[] = [];
    const result = await collect(
      pages(
        async (before) => {
          requests.push(before);
          return {
            nodes: [{ id: before ?? "newest" }],
            pageInfo: { hasPreviousPage: before === null, startCursor: "older" },
          };
        },
        { ...errors, direction: "backward", nonempty: true }
      )
    );
    expect(requests).toEqual([null, "older"]);
    expect(result.flatMap((page) => page.nodes)).toEqual([{ id: "newest" }, { id: "older" }]);
  });

  it.each([undefined, null, 1, "text", [], {}, { nodes: null }, { nodes: {} }])(
    "rejects a missing or malformed connection: %j",
    async (payload) => {
      await expect(collect(pages(async () => payload, errors))).rejects.toThrow(
        "Missing connection"
      );
    }
  );

  it.each([
    {},
    null,
    [],
    { hasNextPage: "false", endCursor: "a" },
    { hasNextPage: true },
    { hasNextPage: true, endCursor: null },
    { hasNextPage: true, endCursor: 1 },
  ])("rejects invalid forward pageInfo: %j", async (pageInfo) => {
    await expect(collect(pages(async () => ({ nodes: [], pageInfo }), errors))).rejects.toThrow(
      "Invalid cursor"
    );
  });

  it.each([
    {},
    { hasPreviousPage: "false" },
    { hasPreviousPage: true },
    { hasPreviousPage: true, startCursor: null },
    { hasPreviousPage: true, startCursor: "" },
    { hasPreviousPage: true, startCursor: 1 },
  ])("rejects invalid backward pageInfo: %j", async (pageInfo) => {
    await expect(
      collect(
        pages(async () => ({ nodes: [], pageInfo }), {
          ...errors,
          direction: "backward",
          nonempty: true,
        })
      )
    ).rejects.toThrow("Invalid cursor");
  });

  it.each(["forward", "backward"] as const)("rejects repeated %s cursors", async (direction) => {
    let calls = 0;
    await expect(
      collect(
        pages(
          async () => {
            calls++;
            return {
              nodes: [],
              pageInfo: {
                hasNextPage: true,
                hasPreviousPage: true,
                endCursor: "a",
                startCursor: "a",
              },
            };
          },
          { ...errors, direction }
        )
      )
    ).rejects.toThrow("Invalid cursor");
    expect(calls).toBe(2);
  });

  it("preserves each reader's empty-cursor policy", async () => {
    let calls = 0;
    await expect(
      collect(pages(async () => (++calls === 1 ? connection("") : connection(null, false)), errors))
    ).resolves.toHaveLength(2);
    await expect(
      collect(pages(async () => connection(""), { ...errors, nonempty: true }))
    ).rejects.toThrow("Invalid cursor");
  });

  it("preserves previous-only cycle detection for bounded review reads", async () => {
    let calls = 0;
    await expect(
      collect(
        pages(async () => connection(["a", "b", "a"][calls++]), {
          ...errors,
          repeats: "previous",
          limit: 3,
          limitError: "Limit reached",
        })
      )
    ).rejects.toThrow("Limit reached");
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      collect(pages(async () => connection(["a", "b", "a"][calls++]), errors))
    ).rejects.toThrow("Invalid cursor");
  });

  it("checks metadata before decoding a connection or fetching another page", async () => {
    let calls = 0;
    let decoded = 0;
    const output = await collect(
      pages(
        async () => {
          calls++;
          return { author: "unknown" };
        },
        {
          ...errors,
          stop: (payload) => payload.author === "unknown",
          connection: () => {
            decoded++;
            throw new Error("Body must not be read");
          },
        }
      )
    );
    expect(output).toEqual([]);
    expect([calls, decoded]).toEqual([1, 0]);
  });

  it("preserves early call-site stops before cursor validation", async () => {
    let calls = 0;
    for await (const page of pages(async () => {
      calls++;
      return connection(null);
    }, errors)) {
      expect(page.nodes).toEqual([{ id: null }]);
      break;
    }
    expect(calls).toBe(1);
    await expect(
      collect(
        pages(async () => ({ nodes: [], pageInfo: {} }), {
          ...errors,
          validateFirst: true,
          pageInfoError: "Invalid review connection",
        })
      )
    ).rejects.toThrow("Invalid review connection");
    const iterator = pages(async () => connection(null), { ...errors, validateFirst: true });
    await expect(iterator.next()).rejects.toThrow("Invalid cursor");
  });

  it("propagates transport failures unchanged", async () => {
    const failure = new Error("transport failed");
    await expect(
      collect(
        pages(async () => {
          throw failure;
        }, errors)
      )
    ).rejects.toBe(failure);
  });
});

describe("batched aliases", () => {
  it.each(["rounds", "drain"] as const)(
    "preserves %s scheduling, independent cursors and batch boundaries",
    async (strategy) => {
      const entries = ["a", "b", "c"].map((id) => ({
        id,
        cursor: null as string | null,
        seen: new Set<string>(),
      }));
      const requests: string[][] = [];
      await batchPages(
        entries,
        async (batch) => {
          requests.push(batch.map(({ id, cursor }) => `${id}:${cursor}`));
          for (const entry of batch) {
            entry.cursor = pageCursor(
              connection("same", entry.cursor === null),
              entry.seen,
              errors
            );
          }
        },
        { size: 2, strategy }
      );
      expect(requests).toEqual(
        strategy === "rounds"
          ? [["a:null", "b:null"], ["c:null"], ["a:same", "b:same"], ["c:same"]]
          : [["a:null", "b:null"], ["a:same", "b:same"], ["c:null"], ["c:same"]]
      );
    }
  );

  it("starts only overflowing preloaded connections and fails closed on repeated alias cursors", async () => {
    const entries = [
      { id: "done", cursor: null },
      { id: "overflow", cursor: "a" },
    ];
    const seen = new Set(["a"]);
    const requests: string[][] = [];
    await expect(
      batchPages(
        entries,
        async (batch) => {
          requests.push(batch.map(({ id }) => id));
          batch[0].cursor = pageCursor(connection("a"), seen, errors);
        },
        { size: 25, strategy: "drain", initial: "pending" }
      )
    ).rejects.toThrow("Invalid cursor");
    expect(requests).toEqual([["overflow"]]);
  });

  it("makes no request for an empty alias list", async () => {
    await batchPages(
      [],
      async () => {
        throw new Error("Unexpected request");
      },
      { size: 50, strategy: "rounds" }
    );
  });
});

describe("numbered REST pages", () => {
  it("keeps numbering and stops at the first short page", async () => {
    const requests: number[] = [];
    const result = await collect(
      restPages(
        async (page) => {
          requests.push(page);
          return page === 1 ? [1, 2] : [];
        },
        { error: "Invalid list", size: 2 }
      )
    );
    expect(requests).toEqual([1, 2]);
    expect(result).toEqual([[1, 2], []]);
  });

  it.each([null, {}, "text", 1])("rejects a non-array REST list: %j", async (payload) => {
    await expect(
      collect(restPages(async () => payload, { error: "Invalid list", size: 100 }))
    ).rejects.toThrow("Invalid list");
  });

  it("retains bounded truncation versus throwing, without an extra request", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return [1];
    };
    await expect(
      collect(restPages(read, { error: "Invalid list", size: 1, limit: 2 }))
    ).resolves.toEqual([[1], [1]]);
    expect(calls).toBe(2);
    calls = 0;
    await expect(
      collect(
        restPages(read, { error: "Invalid list", size: 1, limit: 2, limitError: "Limit reached" })
      )
    ).rejects.toThrow("Limit reached");
    expect(calls).toBe(2);
    await expect(
      collect(
        restPages(async () => [], {
          error: "Invalid list",
          size: 1,
          limit: 1,
          limitError: "Limit reached",
        })
      )
    ).resolves.toEqual([[]]);
  });
});
