import type { Config } from "../src/core/config.js";

/** Fresh valid service settings; individual tests supply only their relevant overrides. */
export function testConfig(
  overrides: Omit<Partial<Config>, "board"> & { board?: Partial<Config["board"]> } = {}
): Config {
  const repo = overrides.repo ?? "example/project";
  return {
    repo,
    org: repo.split("/")[0],
    baseBranch: "dev",
    ...overrides,
    board: { owner: repo.split("/")[0], number: 1, repos: [repo], ...overrides.board },
  };
}
