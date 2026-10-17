import {
  execFile,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { expect } from "vitest";

// Opt-in cold-process measurements, including children of otherwise synchronous tests.
export function runChild(
  file: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding & { timeout: number }
) {
  const start = performance.now();
  const result = spawnSync(file, args, options);
  const duration = performance.now() - start;
  if (process.env.VMETHOD_TEST_TIMINGS) {
    appendFileSync(
      process.env.VMETHOD_TEST_TIMINGS,
      JSON.stringify({ test: expect.getState().currentTestName, file, args, duration }) + "\n"
    );
  }
  if (result.error) {
    throw new Error(
      `Child process ${file} ${args.join(" ")} failed after ${Math.round(duration)} ms ` +
        `(budget ${options.timeout} ms): ${result.error.message}\n${result.stderr ?? ""}`,
      { cause: result.error }
    );
  }
  return result;
}

export async function runChildAsync(
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding & { timeout: number }
) {
  const start = performance.now();
  try {
    return await promisify(execFile)(file, args, options);
  } catch (error) {
    throw new Error(
      `Child process ${file} ${args.join(" ")} failed after ${Math.round(performance.now() - start)} ms ` +
        `(budget ${options.timeout} ms): ${String(error)}`,
      { cause: error }
    );
  } finally {
    if (process.env.VMETHOD_TEST_TIMINGS) {
      appendFileSync(
        process.env.VMETHOD_TEST_TIMINGS,
        JSON.stringify({
          test: expect.getState().currentTestName,
          file,
          args,
          duration: performance.now() - start,
        }) + "\n"
      );
    }
  }
}
