import { context, type Transport } from "../gateway/transport.js";

/** Parse the release CLI without local, filesystem or network operations. */
export async function releaseVerb(
  transport: Transport,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const [action] = args;
  if (action !== "next" || args.length !== 1) {
    throw new Error("Usage: vmethod release next");
  }
  return transport.call("releaseNext", {}, context(env));
}
