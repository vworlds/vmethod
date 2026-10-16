import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function isDigestLink(link: unknown): link is string {
  return (
    typeof link === "string" &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:issues|pull)\/\d+(?:#(?:issuecomment-|pullrequestreview-|discussion_r)\d+)?)?$/.test(
      link
    )
  );
}

export class Digest {
  readonly path: string;
  constructor(
    env: NodeJS.ProcessEnv,
    stateName: string,
    private now: () => number
  ) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(stateName) || stateName === "..")
      throw new Error("Invalid stateName");
    this.path = join(
      env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local/state"),
      "vmethod",
      stateName,
      "dropped.jsonl"
    );
  }

  drop(link: string): void {
    if (!isDigestLink(link)) throw new Error("Invalid dropped-item link");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(
      this.path,
      JSON.stringify({ at: new Date(this.now()).toISOString(), link }) + "\n",
      { mode: 0o600 }
    );
  }

  read(since?: string): string {
    const after = since === undefined ? -Infinity : Date.parse(since);
    if (Number.isNaN(after)) throw new Error("Invalid --since date");
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "Dropped: 0";
      throw error;
    }
    const counts = new Map<string, number>();
    for (const line of text.split("\n").filter(Boolean)) {
      const item = JSON.parse(line) as { at: string; link: string };
      if (!Number.isFinite(Date.parse(item.at)) || !isDigestLink(item.link))
        throw new Error("Invalid dropped digest record");
      if (Date.parse(item.at) >= after) counts.set(item.link, (counts.get(item.link) ?? 0) + 1);
    }
    return [
      `Dropped: ${[...counts.values()].reduce((a, b) => a + b, 0)}`,
      ...[...counts].map(([link, count]) => `${count} ${link}`),
    ].join("\n");
  }
}
