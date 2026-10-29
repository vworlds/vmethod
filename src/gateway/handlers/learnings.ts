import { parseFirstLine } from "../../core/protocol.js";
import { type Person } from "../people.js";
import { repoOf } from "../../github/diagnostic.js";
import { turnAssignees } from "../turn.js";
import { LearningsService } from "../learnings.js";
import { LearningAnnotations, type LearningBundle } from "../learning-annotations.js";
import { checkLearningPr } from "../learning-check.js";
import { mergeLearningPr } from "../learning-merge.js";
import type { GatewayServices } from "../server.js";
import type { Handler } from "./types.js";

export const learnings: Handler<"learnings"> = async function (input) {
  if (input.action === "annotate" || input.action === "aggregate") {
    return new LearningAnnotations(
      this.root,
      this.config,
      this.env,
      this.deps,
      () => this.learningService().records(),
      (pr) => this.learningBundle(pr),
      this.models
    ).command(input);
  }
  // Orchestrator-only central merge of an authorized learning submission (#308).
  if (input.action === "merge") {
    if (this.config.repo.toLowerCase() !== "vworlds/vmethod") {
      throw new Error("Learning PR merges run only in the central repository");
    }
    if (!Number.isSafeInteger(input.pr) || input.pr < 1) {
      throw new Error("Invalid learning PR number");
    }
    return mergeLearningPr(this.github, this.filter, input.pr);
  }
  return this.learningService().command(input);
};

export const learningCheck: Handler<"learningCheck"> = async function ({ ref, label }) {
  if (this.config.repo.toLowerCase() !== "vworlds/vmethod") {
    throw new Error("Learning PR checks run only in the central repository");
  }
  return checkLearningPr(this.github, this.localNumber(ref), label);
};

export async function learningBundle(this: GatewayServices, pr: number): Promise<LearningBundle> {
  const meta = await this.workerMetadata(pr);
  if (!meta.issue || meta.state === "OPEN" || !meta.closedAt) {
    throw new Error("Annotation requires a closed task PR with one linked issue");
  }
  const issue = await this.richThread(meta.issue, "issue");
  const comments = [...meta.comments];
  // Grade lives on the issue; include owner and orchestrator evidence there as well.
  for (const entry of await this.collection(String(issue.id), "Issue", "comments")) {
    if (
      !this.filter.accept(
        entry,
        repoOf(entry).owner,
        `https://github.com/${this.config.repo}/issues/${meta.issue}`
      )
    ) {
      continue;
    }
    const c = await this.node(String(entry.id), "body createdAt url", "IssueComment");
    const author = this.filter.accept(
      c,
      repoOf(c).owner,
      `https://github.com/${this.config.repo}/issues/${meta.issue}`
    );
    if (!author || this.filter.identity(c.author)?.role !== author.role) {
      continue;
    }
    if (
      typeof c.body !== "string" ||
      typeof c.url !== "string" ||
      !Number.isFinite(Date.parse(String(c.createdAt)))
    ) {
      throw new Error("Incomplete annotation comment");
    }
    if (
      parseFirstLine(c.body, { role: "orchestrator", tags: ["GRADE"] }) &&
      !c.body.includes(`Graded PR #${pr}:`)
    ) {
      continue;
    }
    comments.push({
      body: c.body,
      role: this.learningRole(author),
      date: String(c.createdAt),
      url: c.url,
    });
  }
  return {
    repo: this.config.repo,
    pr,
    closedAt: meta.closedAt,
    issue: {
      body: String(issue.body),
      url: `https://github.com/${this.config.repo}/issues/${meta.issue}`,
    },
    comments,
    diff: meta.diff ?? null,
  };
}

export function learningService(this: GatewayServices): LearningsService {
  return new LearningsService(this.root, this.config, this.env, this.deps, () => this.github);
}

export function learningRole(this: GatewayServices, person: Person): string {
  if (person.role !== "orchestrator") {
    return person.role;
  }
  const [login] = turnAssignees(this.filter.people, this.config.repo, [], "orchestrator");
  return person.login.toLowerCase() === login.toLowerCase() ? "orchestrator" : "peer-orchestrator";
}
