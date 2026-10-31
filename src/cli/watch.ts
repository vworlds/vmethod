import type { CallContext, Operations, Transport } from "../gateway/transport.js";
import type { SessionInput } from "../gateway/events.js";
import { context } from "../gateway/transport.js";

/** A normal run polls and acknowledges printed batches, so a failed/closed stdout
 * leaves the batch pending and never acknowledges it. `--stop` prints one verdict
 * line and returns the exit code. Continuous output is tab-bundled after silence
 * (bounded by the maximum window); the optional stop signal flushes before return.
 * An interrupted in-flight poll may leave printed events pending for redelivery. */
export async function watchClient(
  transport: Transport,
  args: string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => Promise<void> = (text) =>
    new Promise((resolve, reject) => {
      process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
    }),
  signal?: AbortSignal
): Promise<number | undefined> {
  const session: SessionInput = {};
  let once = env.ONESHOT === "1";
  let explicitOnce = false;
  let stop = false;
  let force = false;
  let replay: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--once") {
      once = true;
      explicitOnce = true;
    } else if (flag === "--stop") {
      stop = true;
    } else if (flag === "--force") {
      force = true;
    } else if (["--track", "--only", "--skip", "--replay"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (flag === "--replay") {
        replay = value;
      } else if (flag === "--track") {
        session.track = value;
      } else {
        if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(value)) {
          throw new Error(`Expected comma-separated numbers for ${flag}`);
        }
        session[flag === "--only" ? "only" : "skip"] = value.split(",").map(Number);
      }
    } else {
      throw new Error(
        "Usage: vmethod watch [--stop [--force]] [--once] [--replay <previous|seq|time>] [--track <name>|--only <numbers>|--skip <numbers>]"
      );
    }
  }
  if (stop) {
    // ONESHOT is a run-pacing default, not a user combination of flags.
    once = false;
  }
  if (stop && (explicitOnce || replay !== undefined)) {
    throw new Error("--stop cannot be combined with --once or --replay");
  }
  if (force && !stop) {
    throw new Error("Usage: vmethod watch --stop --force ...; --force needs --stop");
  }
  for (const [name, flag] of [
    ["WATCH_ONLY", "only"],
    ["WATCH_SKIP", "skip"],
  ] as const) {
    if (env[name] && session[flag] === undefined) {
      const value = env[name]
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (value.some((n) => !Number.isSafeInteger(n) || n < 1)) {
        throw new Error(`Invalid ${name}`);
      }
      session[flag] = value;
    }
  }
  const ctx = context(env);
  if (stop) {
    const verdict = await transport.call("watchStop", { ...session, force }, ctx);
    await write(`${verdict.text}\n`);
    return verdict.code === 0 ? undefined : verdict.code;
  }
  if (!once && replay === undefined) {
    return watchContinuous(transport, session, ctx, write, signal);
  }
  let ack: string[] = [];
  let first = true;
  let guideSeen = false;
  for (;;) {
    const { events, notice, reminder } = await transport.call(
      "nextEvents",
      {
        ...session,
        timeoutSeconds: once || replay !== undefined ? 0 : 300,
        ...(replay !== undefined
          ? { replay }
          : {
              ack,
              ...(guideSeen ? { guideSeen: true } : {}),
              ...(first ? { watchStart: true } : {}),
              ...(once ? { pollOnce: true } : {}),
            }),
      },
      ctx
    );
    first = false;
    if (notice) {
      await write(`${notice}\n`);
      guideSeen = true;
    }
    for (const event of events) {
      const quiet = event.quiet?.length
        ? `quiet since the last wake-up:\n${event.quiet.map((line) => `  ${line}\n`).join("")}`
        : "";
      await write(`${quiet}${event.line}\n`);
    }
    if (reminder) {
      await write(`${reminder}\n`);
    }
    ack = events.map((event) => event.id);
    if (replay !== undefined) {
      return;
    }
    if (once) {
      if (events.length || guideSeen) {
        await transport.call(
          "nextEvents",
          { ...session, timeoutSeconds: 0, ack, ...(guideSeen ? { guideSeen: true } : {}) },
          ctx
        );
      }
      return;
    }
  }
}

/** Keep exactly one collecting call in flight. The output deadline is independent
 * of gateway polling/backoff, so even a slow poll cannot hold a bundle past its cap. */
async function watchContinuous(
  transport: Transport,
  session: SessionInput,
  ctx: CallContext,
  write: (text: string) => Promise<void>,
  signal?: AbortSignal
): Promise<undefined> {
  type Batch = Operations["nextEvents"]["output"];
  let pending: Promise<Batch> | undefined;
  let first = true;
  let guideSeen = false;
  let ack: string[] = [];
  let ids: string[] = [];
  let items: string[] = [];
  let bufferedNotice = false;
  let began = 0;
  let changed = 0;
  let debounce = 1000;
  let maximum = 10_000;
  const stopped = Symbol("stopped");
  let onStop: () => void = () => {};
  const stopping = new Promise<typeof stopped>((resolve) => {
    onStop = () => resolve(stopped);
    if (signal?.aborted) {
      onStop();
    } else {
      signal?.addEventListener("abort", onStop, { once: true });
    }
  });
  const flush = async () => {
    if (!items.length) {
      return;
    }
    await write(`${items.map((item) => item.replaceAll("\t", " ")).join("\t")}\n`);
    ack.push(...ids);
    guideSeen ||= bufferedNotice;
    ids = [];
    items = [];
    bufferedNotice = false;
  };
  try {
    for (;;) {
      if (!pending) {
        pending = transport.call(
          "nextEvents",
          {
            ...session,
            timeoutSeconds: 300,
            ack,
            ...(ids.length ? { exclude: [...ids] } : {}),
            ...(guideSeen ? { guideSeen: true } : {}),
            ...(first ? { watchStart: true } : {}),
          },
          ctx
        );
        ack = [];
        first = false;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = Symbol("expired");
      const deadline = new Promise<typeof expired>((resolve) => {
        if (items.length) {
          timer = setTimeout(
            () => resolve(expired),
            Math.max(0, Math.min(changed + debounce, began + maximum) - Date.now())
          );
        }
      });
      let result: Batch | typeof expired | typeof stopped;
      try {
        result = await Promise.race([pending, deadline, stopping]);
      } finally {
        clearTimeout(timer);
      }
      if (result === stopped) {
        await flush();
        return;
      }
      if (result === expired) {
        await flush();
        continue;
      }
      pending = undefined;
      debounce = (result.debounceSeconds ?? 1) * 1000;
      maximum = (result.debounceMaxSeconds ?? 10) * 1000;
      if (debounce === 0) {
        // Disabled debouncing keeps the exact foreground presentation.
        await flush();
        if (result.notice) {
          await write(`${result.notice}\n`);
          guideSeen = true;
        }
        for (const event of result.events) {
          const quiet = event.quiet?.length
            ? `quiet since the last wake-up:\n${event.quiet.map((line) => `  ${line}\n`).join("")}`
            : "";
          await write(`${quiet}${event.line}\n`);
          ack.push(event.id);
        }
        if (result.reminder) {
          await write(`${result.reminder}\n`);
        }
        continue;
      }
      const added: string[] = [];
      if (result.notice) {
        added.push(result.notice);
        bufferedNotice = true;
      }
      for (const event of result.events) {
        if (event.quiet?.length) {
          added.push("quiet since the last wake-up:", ...event.quiet);
        }
        added.push(event.line);
        ids.push(event.id);
      }
      if (result.reminder) {
        added.push(result.reminder);
      }
      if (added.length) {
        if (!items.length) {
          began = Date.now();
        }
        changed = Date.now();
        items.push(...added);
      }
      if (items.length && Date.now() >= Math.min(changed + debounce, began + maximum)) {
        await flush();
      }
    }
  } finally {
    signal?.removeEventListener("abort", onStop);
  }
}
