import { createRequire } from "node:module";
import { join } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };

export async function checkMarkdown(root: string, text: string): Promise<void> {
  if (!text.trim() || text.includes("\0")) {
    throw new Error("Post must contain nonempty Markdown");
  }
  let fence: { character: string; length: number; mermaid: boolean; lines: string[] } | undefined;
  const diagrams: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) {
      fence = {
        character: marker[1][0],
        length: marker[1].length,
        mermaid: marker[2].trim() === "mermaid",
        lines: [],
      };
    } else if (
      fence &&
      marker &&
      marker[1][0] === fence.character &&
      marker[1].length >= fence.length &&
      !marker[2].trim()
    ) {
      if (fence.mermaid) {
        diagrams.push(fence.lines.join("\n"));
      }
      fence = undefined;
    } else if (fence) {
      fence.lines.push(line);
    }
  }
  if (fence) {
    throw new Error("Markdown has an unclosed code fence");
  }
  if (diagrams.length) {
    const require = createRequire(join(root, "package.json"));
    let version: string;
    try {
      version = (require("mermaid/package.json") as { version: string }).version;
    } catch {
      throw new Error(
        `Dependency missing: install mermaid@${packageMetadata.peerDependencies.mermaid} and jsdom`
      );
    }
    if (version !== packageMetadata.peerDependencies.mermaid) {
      throw new Error(`mermaid must equal ${packageMetadata.peerDependencies.mermaid}`);
    }
    // Resolve only owner-installed peers; no downloading or subprocess rendering.
    const { JSDOM } = require("jsdom") as {
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
        };
      };
      mermaidModule.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
      });
      for (const diagram of diagrams) {
        await mermaidModule.default.parse(diagram);
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
