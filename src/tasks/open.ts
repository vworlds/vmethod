import { heading as protocolHeading } from "../core/protocol.js";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { assertEstimate } from "../board/estimate.js";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadYaml } from "../config.js";
import { object } from "../gateway/people.js";
import { checkMarkdown, guardClosingKeywords } from "../gateway/markdown.js";
import { GitTransport, taskBranch, validateBranch } from "../gateway/git.js";
import type { OpenTaskInput } from "../gateway/task-flow-types.js";
import { holdBanner, taskIssueNumbers } from "./markers.js";
import { modelGateError } from "../evidence/model-gate.js";
import { assertLockfileInSync, npmCiEnvironment } from "../gateway/lockfile.js";
import packageInfo from "../../package.json" with { type: "json" };
import { TaskCommon, sha, conformingTitle } from "./common.js";

/** #339: model tier ordering for the cheaper-tier note; unknown tiers never count as more expensive. */
const tierRank: Record<string, number> = { cheap: 0, standard: 1, expensive: 2 };

/** #339: "<family> averages $<usd>/point over <k> ..." — the advisory evidence, undefined without data. */
const averages = (
  family: string,
  evidence: { usdPerPoint: number; deliveries: number; totalDeliveries: number } | undefined,
  unit: string
): string | undefined =>
  evidence
    ? `${family} averages $${evidence.usdPerPoint.toFixed(2)}/point over ${evidence.deliveries} of ${evidence.totalDeliveries} ${unit}`
    : undefined;

/** Open task and non-task deliveries, including branch ancestry and model advice. */
export class TaskOpen extends TaskCommon {
  /** Open an already-pushed non-task PR; never creates task relations or a worker. */
  async openPr(input: {
    branch: string;
    title: string;
    file: string;
    draft?: boolean;
  }): Promise<string> {
    this.nonTaskBranch(input.branch);
    if (!conformingTitle(input.title)) {
      throw new Error("Squash subject must be <type>: <subject> without scope");
    }
    if (input.draft !== undefined && typeof input.draft !== "boolean") {
      throw new Error("Invalid draft flag");
    }
    const body = readFileSync(input.file, "utf8");
    await checkMarkdown(this.root, body);
    guardClosingKeywords(body);
    if (taskIssueNumbers(body) !== undefined) {
      throw new Error("Task PRs use open-task");
    }
    const refs = await this.host.github.rest(
      `/repos/${this.repo}/git/matching-refs/heads/${encodeURIComponent(input.branch)}`
    );
    if (
      !Array.isArray(refs) ||
      !refs.some((ref) => object(ref).ref === `refs/heads/${input.branch}`)
    ) {
      throw new Error("Branch must already be pushed to the configured repository");
    }
    const created = object(
      await this.host.github.rest(
        `/repos/${this.repo}/pulls`,
        "POST",
        {
          head: input.branch,
          base: String(this.config.baseBranch),
          title: input.title,
          body,
          draft: input.draft ?? false,
        },
        false
      )
    );
    return `https://github.com/${this.repo}/pull/${this.number(String(created.number))}`;
  }

  /** Open an isolated draft delivery, freezing only an on-scale opening issue Estimate. */
  async open(input: OpenTaskInput): Promise<string> {
    for (const value of [input.hold, input.part, input.ownerApproved]) {
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error("Invalid task flags");
      }
    }
    for (const value of [
      input.issue,
      input.direct,
      input.model,
      input.unapproved,
      input.modelOverride,
      input.from,
    ]) {
      if (value !== undefined && (typeof value !== "string" || !value.trim())) {
        throw new Error("Invalid task text argument");
      }
    }
    if (
      (!input.issue && !input.direct) ||
      (input.unapproved !== undefined && !input.unapproved.trim())
    ) {
      throw new Error("Issue/direct title and nonempty exception reason required");
    }
    if (input.modelOverride !== undefined && (!input.model || /[\r\n]/.test(input.modelOverride))) {
      throw new Error("--model-override requires --model and a single-line reason");
    }
    if (input.from !== undefined) {
      try {
        validateBranch(input.from);
      } catch (error) {
        throw new Error("open-task --from: invalid branch name", { cause: error });
      }
      if (
        [
          "dev",
          "master",
          "main",
          "HEAD",
          String(this.config.baseBranch),
          String(this.config.releaseBranch),
        ].includes(input.from)
      ) {
        throw new Error("open-task --from refuses the base, release or default branch");
      }
    }
    const issue = input.issue
      ? await this.host.thread(String(this.number(input.issue)), "issue")
      : undefined;
    if (input.part && !issue) {
      throw new Error("--part requires an issue");
    }
    if (issue) {
      this.track(issue);
      if (issue.state !== "OPEN") {
        throw new Error("Issue is not open");
      }
      if (input.unapproved === undefined && (await this.host.issueApproved(issue)) !== true) {
        throw new Error(await this.host.scopeRefusal(issue));
      }
    }
    let hint: string | undefined;
    let pointsOpen: number | undefined;
    if (issue && object(this.config.board).enabled !== false) {
      const board = this.host.board();
      const snapshot = await board.snapshot();
      const card = (await board.cards(snapshot.id)).find((card) => card.contentId === issue.id);
      hint = typeof card?.values.Model === "string" ? card.values.Model : undefined;
      const estimate = card?.values.Estimate;
      if (estimate === undefined || estimate === null) {
        throw new Error("Issue must have an Estimate at opening");
      }
      assertEstimate(estimate);
      pointsOpen = estimate;
      if (input.unapproved === undefined && card?.values.Status !== "Executing") {
        throw new Error("open-task requires an Executing issue with approved scope");
      }
    }
    const models = loadYaml(this.root, "models") as {
      family: string;
      model: string;
      gate: string;
      tier: string;
    }[];
    const model = models.find((model) => model.family === (input.model ?? hint ?? "sol"));
    if (!model) {
      throw new Error("Unknown model family");
    }
    if (model.gate === "owner") {
      if (input.ownerApproved !== true) {
        throw new Error("Model requires --owner-approved");
      }
      // The flag alone is not owner authority (#218): the owner must have posted the
      // approval line after the issue body's last edit; a direct task has no issue to
      // verify here, and its launch still re-checks the task PR through worker hooks.
      if (input.issue && !(await this.host.modelApproval(this.number(input.issue), model.family))) {
        throw modelGateError(model.family);
      }
    }
    // The card's Model is the owner's hint; launching on a different family needs a reason.
    const overriding = Boolean(input.model && hint && input.model !== hint);
    if (overriding && !input.modelOverride) {
      throw new Error(
        `issue #${input.issue} has Model ${hint} on its card; use it (omit --model) or override with --model-override "<reason>"`
      );
    }
    // #339: launching without a card Model first shows suggest-model's advice, inform only.
    const advisory =
      issue && !hint
        ? await this.modelAdvisory(this.number(input.issue!), {
            family: model.family,
            tier: model.tier,
          })
        : [];
    const quotaWarning = await this.host.modelQuotaWarning?.(model.family);
    if (quotaWarning) {
      advisory.push(quotaWarning);
    }
    let title = String(input.direct ?? issue?.title ?? "");
    if (!input.direct && issue) {
      title = title.replace(/^bug:\s*/, "fix: ");
    }
    if (!conformingTitle(title)) {
      // Issue titles are prose; generate a conventional feature title, never retain a scope.
      title = `feat: ${title.replace(/^[a-z]+\([^)]*\):\s*/, "").trim()}`;
    }
    if (!conformingTitle(title)) {
      throw new Error("Title must be <type>: <subject> without scope");
    }
    const spec = String(issue?.body ?? input.direct ?? "");
    const handoff = /^## Handoff breakpoints\s*$/m.test(spec);
    if (handoff && model.tier !== "expensive") {
      throw new Error("Handoff breakpoints require tier: expensive");
    }
    const base = String(this.config.baseBranch);
    validateBranch(base);
    const slug =
      title
        .replace(/^[^:]+:\s*/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 70) || "task";
    const number = input.issue ?? createHash("sha256").update(title).digest("hex").slice(0, 8);
    const branch = String(object(this.config.branches).taskPattern ?? "<number>-<slug>")
      .replaceAll("<number>", number)
      .replaceAll("<slug>", slug);
    taskBranch(branch, this.config);
    const templatePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../templates/task-pr.md"
    );
    // Bundled CLI lives in dist/, whereas TypeScript lives in src/tasks/.
    const template = readFileSync(
      existsSync(templatePath)
        ? templatePath
        : resolve(dirname(fileURLToPath(import.meta.url)), "../templates/task-pr.md"),
      "utf8"
    );
    const values: Record<string, string> = {
      "delivery title": `${title}${input.issue ? ` (${input.part ? "part of " : ""}issue #${input.issue})` : ""}`,
      "issue estimate": String(pointsOpen ?? ""),
      "approval basis": issue
        ? `https://github.com/${this.repo}/issues/${input.issue}; ${input.unapproved ? `unapproved exception: ${input.unapproved}` : "approved specification"}.`
        : `Direct owner go: ${input.direct}`,
      version: packageInfo.version,
      "hold banner": input.hold ? `${holdBanner}\n\n` : "",
      "task specification": spec,
      "started from": input.from ? `Started from ${input.from}.\n` : "",
      "task metadata": JSON.stringify({
        issues: issue ? [Number(input.issue)] : [],
        ...(input.part ? { part: true } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.unapproved ? { scopeException: input.unapproved } : {}),
        ...(overriding
          ? { modelOverride: { from: hint, to: input.model, reason: input.modelOverride } }
          : {}),
      }),
    };
    // Substitute once: issue text containing template tokens must remain verbatim.
    const body = template
      .replace("<!-- points_open: <issue estimate> -->", () =>
        pointsOpen === undefined ? "" : `<!-- points_open: ${pointsOpen} -->`
      )
      .replace(/<([^<>]+)>/g, (token, key: string) => values[key] ?? token);
    guardClosingKeywords(body);
    await checkMarkdown(this.root, body);
    if (input.unapproved && issue) {
      await this.post(
        input.issue!,
        `${protocolHeading("Unapproved exception")}\n\n${input.unapproved}`
      );
    }
    if (overriding) {
      await this.post(
        input.issue!,
        `${protocolHeading("NOTE")}: model override: using ${input.model} instead of the card's ${hint} — ${input.modelOverride}`
      );
    }
    const git = this.git();
    if (!(await git.transferOk("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
      throw new Error("Fetch failed");
    }
    let head = sha(
      (
        await git.run(
          "commit-tree",
          `refs/remotes/origin/${base}^{tree}`,
          "-p",
          `refs/remotes/origin/${base}`,
          "-m",
          `chore: open task ${number}\n\nPrepare draft task delivery.`
        )
      ).trim()
    );
    if (input.from) {
      head = await this.mergeFromBranch(git, head, input.from, branch, base);
    }
    if (!(await git.transferOk("push", [`${head}:refs/heads/${branch}`]))) {
      throw new Error("Task branch push failed");
    }
    const created = object(
      await this.host.github.rest(
        `/repos/${this.repo}/pulls`,
        "POST",
        { title, body, base, head: branch, draft: true },
        false
      )
    );
    const ref = String(created.number);
    this.number(ref);
    const pr = { id: created.node_id };
    if (this.config.track) {
      await this.host.github.rest(`${this.path(ref)}/labels`, "POST", {
        labels: [`track:${String(this.config.track)}`],
      });
    }
    if (issue && !input.part) {
      try {
        await this.closingLinks(
          await this.host.thread(ref, "pr"),
          [this.number(input.issue!)],
          false
        );
      } catch (error) {
        throw new Error(
          `Created draft PR #${ref}, but Development linking failed; retry link-task ${ref}`,
          { cause: error }
        );
      }
    }
    await this.card(pr, "Executing", input.hold ? "⛔" : "🤖🔨", model.family);
    await this.turn(ref, null);
    if (issue) {
      await this.card(issue, "Executing", null);
      await this.turn(input.issue!, null);
      await this.host.copyAutopilot?.(issue, { id: created.node_id, number: created.number, body });
    }
    return [...advisory, `Opened draft PR #${ref} (${branch})`].join("\n");
  }

  /** #339: the advisory lines open-task prints when launching without a card Model: one
   * suggest-model line, plus a cheaper-tier note when the chosen family costs more. Advisory
   * failures only shorten the output and are reported; the launch is never refused. */
  private async modelAdvisory(
    issue: number,
    chosen: { family: string; tier: string }
  ): Promise<string[]> {
    let suggestion: { family: string; tier: string; reason: string } | undefined;
    try {
      suggestion = await this.host.modelSuggestion?.(issue);
    } catch (error) {
      this.deps.report(`Model suggestion unavailable: ${(error as Error).message}`);
    }
    if (!suggestion) {
      return [];
    }
    const suggested = averages(
      suggestion.family,
      await this.familyEvidence(suggestion.family),
      "graded tasks"
    );
    const lines = [
      `suggest-model #${issue}: ${suggestion.family} (${suggestion.reason}${suggested ? `; ${suggested}` : ""})${this.host.modelHeadroom ? `; ${await this.host.modelHeadroom(suggestion.family)}` : ""}`,
    ];
    const chosenRank = tierRank[chosen.tier];
    const suggestedRank = tierRank[suggestion.tier];
    if (chosenRank !== undefined && suggestedRank !== undefined && chosenRank > suggestedRank) {
      const chosenAverages = averages(
        chosen.family,
        await this.familyEvidence(chosen.family),
        "tasks"
      );
      lines.push(
        `note: ${chosen.family} is a more expensive tier than the suggestion${chosenAverages ? ` (${chosenAverages})` : ""}`
      );
    }
    return lines;
  }

  /** #339: per-family learnings evidence for the advisory lines; failure only shortens a line. */
  private async familyEvidence(
    family: string
  ): Promise<{ usdPerPoint: number; deliveries: number; totalDeliveries: number } | undefined> {
    try {
      return this.host.learningEvidence?.(family);
    } catch (error) {
      this.deps.report(`Learnings evidence unavailable: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Start from existing work: merge origin/<from> into the fresh task branch with a true merge
   * commit (never squash/rebase), so the original authors' commits survive in the delivery. */
  private async mergeFromBranch(
    git: GitTransport,
    head: string,
    from: string,
    branch: string,
    base: string
  ): Promise<string> {
    if (!(await git.transferOk("fetch", [`+refs/heads/${from}:refs/remotes/origin/${from}`]))) {
      throw new Error(`open-task --from: no branch ${from} in ${this.repo}`);
    }
    const fromHead = sha((await git.run("rev-parse", `refs/remotes/origin/${from}`)).trim());
    const preview = await git.mergePreview(head, fromHead);
    if (preview.conflicts.length) {
      throw new Error(
        `open-task --from: merging origin/${from} into ${branch} conflicts; ` +
          `conflicting files: ${preview.conflicts.join(", ")}. Nothing was pushed; ` +
          `resolve the conflicts first, for example by merging ${base} into ${from}.`
      );
    }
    this.deps.report("--from: checking merged-tree lockfile sync");
    await this.checkMergedTreeLockfile(git, preview.tree);
    return sha(
      (
        await git.run(
          "commit-tree",
          preview.tree,
          "-p",
          head,
          "-p",
          fromHead,
          "-m",
          `Merge branch '${from}' into ${branch}`
        )
      ).trim()
    );
  }

  /** Lockfile check on the merged task branch content, before the task branch or any worker exists. */
  private async checkMergedTreeLockfile(git: GitTransport, tree: string): Promise<void> {
    const entries = (await git.run("ls-tree", tree, "--", "package.json", "package-lock.json"))
      .trim()
      .split("\n")
      .filter(Boolean);
    const blobs = new Map(
      entries.flatMap((entry) => {
        const [metadata, path] = entry.split("\t");
        const match = /^(?:100644|100755) blob ([a-f\d]{40})$/.exec(metadata);
        if (!match) {
          // A directory named like a manifest is not extractable here; the worker
          // install path still fails visibly on it.
          return [];
        }
        if (!["package.json", "package-lock.json"].includes(path)) {
          throw new Error("Invalid merged-tree lockfile listing");
        }
        return [[path, match[1]] as const];
      })
    );
    const lockfile = blobs.get("package-lock.json");
    if (!blobs.has("package.json") || !lockfile) {
      // No manifest pair on the branch; the worker's own install path still fails visibly there.
      return;
    }
    const scratch = mkdtempSync(join(tmpdir(), "vmethod-lockfile-"));
    try {
      writeFileSync(
        join(scratch, "package.json"),
        await git.run("cat-file", "blob", blobs.get("package.json")!)
      );
      writeFileSync(
        join(scratch, "package-lock.json"),
        await git.run("cat-file", "blob", lockfile)
      );
      await assertLockfileInSync(this.deps, scratch, npmCiEnvironment(this.env));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
