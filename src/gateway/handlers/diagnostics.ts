import { readFileSync } from "node:fs";
import { object, untrusted, type ObjectData } from "../people.js";
import {
  filterData,
  filterDiagnostic,
  readQuery,
  repoOf,
  restActor,
} from "../../github/diagnostic.js";
import { releaseNext as runReleaseNext } from "../release.js";
import type { GatewayServices } from "../server.js";
import type { Handler } from "./types.js";

export const resolveConflicts: Handler<"resolveConflicts"> = async function ({ ref, retry }) {
  return this.conflicts.resolve(this.localNumber(ref), retry);
};

export const waitChecks: Handler<"waitChecks"> = async function (input) {
  return this.ci.wait(input);
};

export const checkTaskCi: Handler<"checkTaskCi"> = async function ({ ref }) {
  return this.ci.check(ref);
};

export const refreshChecks: Handler<"refreshChecks"> = async function ({ ref }) {
  return this.verification.refresh(ref);
};

export const verify: Handler<"verify"> = async function (input) {
  return this.verification.verify(input);
};

export const releaseNext: Handler<"releaseNext"> = async function () {
  return runReleaseNext(this.root, this.config, this.env, this.deps, () => this.github);
};

export const ghRead: Handler<"ghRead"> = async function ({ source }) {
  const counts = { dropped: 0, redacted: 0, textRedacted: 0 };
  if (source.endsWith(".graphql")) {
    const query = readQuery(readFileSync(source, "utf8"));
    const data = await this.github.graphql(query);
    const repo = this.config.repo ?? "undefined";
    const output = untrusted(
      JSON.stringify(
        filterData(data, this.filter, repo, `https://github.com/${repo}`, counts, query),
        null,
        2
      ) ?? "null"
    );
    return `${output}\n${counts.dropped} items dropped by the people filter${counts.redacted ? `\n${counts.redacted} nested values redacted` : ""}${counts.textRedacted ? `\n${counts.textRedacted} text fields redacted from unattributable items` : ""}`;
  }
  // Only scoped repository endpoints. No URLs, alternate methods, redirects or encoded paths.
  const match =
    /^\/?repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[A-Za-z0-9_./-]+)?(?:\?([A-Za-z0-9_=&,.-]+))?$/.exec(
      source
    );
  // Permit exactly the compare delimiter, not traversal or arbitrary double dots.
  const safePath = (match?.[3] ?? "").replace(
    /^\/compare\/([A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*)\.\.\.([A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*)$/,
    "/compare/$1/$2"
  );
  if (
    !match ||
    safePath.includes("..") ||
    match[1].includes("..") ||
    match[2].includes("..") ||
    (match[4] ?? "").includes("..") ||
    match[1].toLowerCase() !== (this.config.org ?? "undefined").toLowerCase()
  ) {
    throw new Error(
      "gh-read permits scoped repository GET endpoints or a query .graphql file only"
    );
  }
  const repo = `${match[1]}/${match[2]}`;
  let data = await this.github.rest(source.startsWith("/") ? source : `/${source}`);
  if (/^\/(?:issues|pulls)\/[1-9]\d*$/.test(match[3] ?? "")) {
    data = await this.diagnosticThread(object(data), repo, match[3]!.startsWith("/pulls/"));
  } else if (/^\/(?:issues|pulls)$/.test(match[3] ?? "") && Array.isArray(data)) {
    const entries: unknown[] = [];
    for (const entry of data) {
      entries.push(await this.diagnosticThread(object(entry), repo, match[3] === "/pulls"));
    }
    data = entries;
  }
  const output = untrusted(
    JSON.stringify(
      filterDiagnostic(data, this.filter, repo, `https://github.com/${repo}`, counts),
      null,
      2
    ) ?? "null"
  );
  return `${output}\n${counts.dropped} items dropped by the people filter${counts.redacted ? `\n${counts.redacted} nested values redacted` : ""}${counts.textRedacted ? `\n${counts.textRedacted} text fields redacted from unattributable items` : ""}`;
};

export const dropped: Handler<"dropped"> = async function ({ since }) {
  return this.digest.read(since);
};

export const ownerApproved: Handler<"ownerApproved"> = async function ({ ref }) {
  return this.evidence.approvalFor(ref);
};

export async function diagnosticThread(
  this: GatewayServices,
  rest: ObjectData,
  repo: string,
  pullRequest: boolean
): Promise<unknown> {
  const link = `https://github.com/${repo}/issues/${String(rest.number)}`;
  // REST updated_at includes labels/state changes and cannot identify a text editor.
  // Gate the original author, then obtain editor-aware metadata before requesting text.
  if (!this.filter.accept({ author: restActor(rest.user) }, repo.split("/")[0], link)) {
    return undefined;
  }
  if (typeof rest.node_id !== "string") {
    throw new Error("Missing diagnostic thread node ID");
  }
  const kind = pullRequest || rest.pull_request ? "PullRequest" : "Issue";
  const metadata = await this.node(rest.node_id, "", kind);
  if (!this.filter.accept(metadata, repoOf(metadata).owner, link)) {
    return undefined;
  }
  if (repoOf(metadata).repo !== repo) {
    throw new Error("Diagnostic thread repository changed");
  }
  const current = await this.node(rest.node_id, "title body", kind);
  if (!this.filter.accept(current, repoOf(current).owner, link)) {
    return undefined;
  }
  if (repoOf(current).repo !== repo || current.id !== rest.node_id) {
    throw new Error("Diagnostic thread identity changed");
  }
  if (typeof current.title !== "string" || typeof current.body !== "string") {
    throw new Error("Missing current diagnostic thread text");
  }
  const result = { ...rest };
  delete result.body_html;
  delete result.body_text;
  return {
    ...result,
    title: current.title,
    body: current.body,
    __vm_author: current.author,
    __vm_editor: current.editor,
    __vm_edited: current.lastEditedAt,
    __vm_repository: current.repository,
  };
}
