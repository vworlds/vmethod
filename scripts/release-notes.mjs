import { fragmentKind } from "./changelog.mjs";

/** Render numbered fragments as the shared GitHub and offline release notes. */
export function releaseNotes(version, fragments) {
  const groups = new Map([
    ["breaking", "Breaking"],
    ["feature", "Features"],
    ["fix", "Fixes"],
  ]);
  const entries = fragments
    .map(({ number, text }) => ({
      number,
      kind: fragmentKind(text),
      body: text.replace(/^kind: (breaking|feature|fix)\r?\n/m, "").trim(),
    }))
    .sort((left, right) => Number(left.number) - Number(right.number));
  const sections = [...groups].flatMap(([kind, heading]) => {
    const matching = entries.filter((entry) => entry.kind === kind);
    return matching.length
      ? [
          `## ${heading}\n\n${matching.map(({ number, body }) => `### [#${number}](https://github.com/vworlds/vmethod/pull/${number})\n\n${body}`).join("\n\n")}`,
        ]
      : [];
  });
  return `# v${version}\n\n${sections.join("\n\n")}\n`;
}
