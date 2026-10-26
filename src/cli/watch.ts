import type { Transport } from "../gateway/transport.js";
import type { SessionInput } from "../gateway/events.js";
import { context } from "../gateway/transport.js";

/** Only printed batches are acknowledged. A failed/closed stdout leaves the batch pending. */
export async function watchClient(
  transport: Transport,
  args: string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => Promise<void> = (text) =>
    new Promise((resolve, reject) => {
      process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
    })
): Promise<void> {
  const session: SessionInput = {};
  let once = env.ONESHOT === "1";
  let replay: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--once") {
      once = true;
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
        "Usage: vmethod watch [--once] [--replay <previous|seq|time>] [--track <name>|--only <numbers>|--skip <numbers>]"
      );
    }
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
