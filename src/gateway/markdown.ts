import { createRequire } from "node:module";
import { join } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };

export class MarkdownDependencyError extends Error {}

export async function checkMarkdown(
  root: string,
  text: string,
  requirePeers = false
): Promise<void> {
  const require = createRequire(join(root, "package.json"));
  if (requirePeers) {
    try {
      require.resolve("jsdom");
      require.resolve("mermaid");
    } catch {
      throw new MarkdownDependencyError(
        `check-markdown: dependencies missing in ${root}; run HUSKY=0 npm ci there`
      );
    }
    if (
      (require("mermaid/package.json") as { version: string }).version !==
      packageMetadata.peerDependencies.mermaid
    ) {
      throw new MarkdownDependencyError(
        `mermaid must equal ${packageMetadata.peerDependencies.mermaid}`
      );
    }
  }
  if ((!requirePeers && !text.trim()) || text.includes("\0")) {
    throw new Error("Post must contain nonempty Markdown");
  }
  let fence:
    | {
        character: string;
        length: number;
        mermaid: boolean;
        lines: string[];
        line: number;
      }
    | undefined;
  const diagrams: { source: string; line: number }[] = [];
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNumber++;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) {
      fence = {
        character: marker[1][0],
        length: marker[1].length,
        mermaid: /^mermaid(?:\s|$)/i.test(marker[2].trim()),
        lines: [],
        line: lineNumber,
      };
    } else if (
      fence &&
      marker &&
      marker[1][0] === fence.character &&
      marker[1].length >= fence.length &&
      !marker[2].trim()
    ) {
      if (fence.mermaid) {
        diagrams.push({ source: fence.lines.join("\n"), line: fence.line });
      }
      fence = undefined;
    } else if (fence) {
      fence.lines.push(line);
    }
  }
  if (fence) {
    throw new Error(
      requirePeers
        ? `Unclosed code fence opened at line ${fence.line}`
        : "Markdown has an unclosed code fence"
    );
  }
  if (diagrams.length) {
    let version: string;
    try {
      version = (require("mermaid/package.json") as { version: string }).version;
    } catch {
      throw new MarkdownDependencyError(
        `Dependency missing: install mermaid@${packageMetadata.peerDependencies.mermaid} and jsdom`
      );
    }
    if (version !== packageMetadata.peerDependencies.mermaid) {
      throw new MarkdownDependencyError(
        `mermaid must equal ${packageMetadata.peerDependencies.mermaid}`
      );
    }
    // Resolve only owner-installed peers; no downloading or subprocess rendering.
    let jsdom: unknown;
    try {
      jsdom = require("jsdom");
    } catch {
      throw new MarkdownDependencyError(
        `Dependency missing: install mermaid@${packageMetadata.peerDependencies.mermaid} and jsdom`
      );
    }
    const { JSDOM } = jsdom as {
      JSDOM: new (html: string) => { window: Window };
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const dom = new JSDOM("");
    Object.defineProperty(globalThis, "window", {
      value: dom.window,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    try {
      const mermaidModule = (await import(require.resolve("mermaid"))) as {
        default: {
          initialize: (options: unknown) => void;
          parse: (text: string) => Promise<unknown>;
          mermaidAPI: {
            getDiagramFromText: (text: string) => Promise<unknown>;
          };
        };
      };
      mermaidModule.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
      });
      for (const [index, diagram] of diagrams.entries()) {
        try {
          const parsed = (await mermaidModule.default.parse(diagram.source)) as
            { diagramType?: unknown } | undefined;
          if (
            !parsed ||
            !["flowchart", "flowchart-v2", "graph"].includes(String(parsed.diagramType))
          ) {
            continue;
          }
          const diagramModel = await mermaidModule.default.mermaidAPI.getDiagramFromText(
            diagram.source
          );
          const diagramInfo = diagramModel as {
            type?: unknown;
            db?: {
              getEdges?: () => unknown;
              edges?: unknown;
            };
          };
          if (["flowchart", "flowchart-v2", "graph"].includes(String(diagramInfo.type))) {
            const database = diagramInfo.db;
            const edges =
              typeof database?.getEdges === "function" ? database.getEdges() : database?.edges;
            if (!Array.isArray(edges)) {
              throw new Error("flowchart database compatibility error: edges are unavailable");
            }
            for (const edge of edges) {
              const item = edge as {
                start?: unknown;
                end?: unknown;
                text?: unknown;
                type?: unknown;
                stroke?: unknown;
              } | null;
              if (!item || typeof item.type !== "string" || typeof item.stroke !== "string") {
                throw new Error(
                  "flowchart database compatibility error: edge type or stroke is unavailable"
                );
              }
              if (item.type === "INVALID" || item.stroke === "INVALID") {
                throw new Error(
                  `invalid Mermaid edge ${String(item.start)} -> ${String(item.end)} (label ${JSON.stringify(item.text ?? "")}); use the reversed .-> form`
                );
              }
            }
          }
        } catch (error) {
          const detail = error as {
            message?: string;
            hash?: { loc?: { first_line?: number } };
            line?: number;
          };
          throw new Error(
            `Mermaid block ${index + 1} (fence line ${diagram.line}, diagram line ${detail.hash?.loc?.first_line ?? detail.line ?? 1}): ${detail.message ?? String(error)}`,
            { cause: error }
          );
        }
      }
    } finally {
      if (previous) {
        Object.defineProperty(globalThis, "window", previous);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (previousDocument) {
        Object.defineProperty(globalThis, "document", previousDocument);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
      dom.window.close();
    }
  }
}

export function guardClosingKeywords(text: string): void {
  const plain = text.replace(/<!--[^]*?-->/g, " ").replace(/[*_`~[\]<>]/g, "");
  if (
    /\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|part\s+of)\b[\s:;,()!.-]*(?:(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/)|(?:[\w.-]+\/[\w.-]+)?#)\d+/i.test(
      plain
    )
  ) {
    throw new Error(
      "Post contains a forbidden closing or association keyword before an issue reference"
    );
  }
}

/**
 * The orchestrator file-posting verbs write the protocol header themselves:
 * `review … answer|changes|owner|ask|approve`, `ask` and `scope-review` prepend
 * `[orchestrator] <HEADING>`. A body whose first non-blank line is already a
 * protocol header (`[orchestrator] …` or `[worker] …`, matched on the trimmed
 * line with whitespace or end-of-line after the tag) would post the heading
 * twice, and a parser could read the repeat as a protocol line. The error names
 * the line and the verb adding the header. A header mentioned later in the text
 * passes. (Worker `pr-comment` keeps a leading `[worker]` line instead and has
 * its own contract in worker-verbs.)
 */
export function guardProtocolHeader(text: string, verb: string): void {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== "");
  if (first === undefined) {
    return;
  }
  const line = first.trim();
  if (/^\[(?:orchestrator|worker)\](?:\s|$)/.test(line)) {
    throw new Error(
      `First non-blank line is the protocol header ${JSON.stringify(line)}; ${verb} adds the header itself`
    );
  }
}

/**
 * Dependency references live only in the blocked-by relation, never in issue text:
 * open-task copies the body into the task brief, where a copied blocker line
 * wrongly signals a live blocker. A line consisting only of a dependency
 * reference (`Blocked by #n`, `Depends on #n`, `Blocked by org/repo#n`; optionally
 * bulleted and/or bold, case-insensitive) is refused; a sentence that only
 * mentions an issue passes.
 */
export function guardDependencyText(text: string): void {
  const dependencyOnlyLine =
    /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?[ \t]*(?:Blocked by|Depends on)[ \t]+(?:[\w.-]+\/[\w.-]+)?#\d+(?:\*\*)?[ \t\r]*$/i;
  if (text.split("\n").some((line) => dependencyOnlyLine.test(line))) {
    throw new Error(
      "dependencies go in the blocked-by relation: vmethod issue block <n> <blocker>"
    );
  }
}
