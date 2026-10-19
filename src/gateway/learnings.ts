import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateYaml, type Config } from "../config.js";
import { learningReport, modelRecord, modelRecords, type ModelRecord } from "../learnings.js";
import { GitHubClient, GitHubHttpError, type Dependencies } from "./client.js";
import { stateRoot } from "./digest.js";
import { learningAuthor, learningPaths } from "./learning-policy.js";
import { learningFiles } from "./learning-check.js";
import { object, untrusted, type Person } from "./people.js";
import { checkMarkdown, guardClosingKeywords } from "./markdown.js";
import type { AnnotationInput } from "./learning-annotations.js";
import { annotation, isAnnotationPath } from "./learning-annotations.js";
import { switchReasons } from "../learning-metrics.js";

declare const __LEARNINGS__: Record<string, string>;
const central = "vworlds/vmethod";
const base = "dev";
const families = new Set([
  "sol",
  "luna",
  "astra",
  "sonnet",
  "opus",
  "glm",
  "glm-flash",
  "big-pickle",
  "other",
]);
const tags = new Set(
  "clean weak-tests test-reads-source silent-patch-harness duplication scope-creep cheap-workaround swallowed-failure budget-regression fix-worsened-baseline metrics-pass-feel-fails missed-root-cause doc-misplaced committed-artefacts silent-stall retry-reported-as-blocked ran-full-suite crossed-messages found-root-cause security-catch good-design-question stop-and-ask could-use-cheaper".split(
    " "
  )
);
const reasons = new Set([
  "start",
  "quota",
  "escalation",
  "rebase",
  "owner-request",
  ...switchReasons,
]);
const kinds = new Set([
  "tooling",
  "tooling-security",
  "docs",
  "bug",
  "gameplay",
  "architecture",
  "security",
  "design",
  "other",
]);

export interface LearningReadInput {
  action: "submit" | "show" | "report";
  family?: string;
  kind?: string;
  json?: boolean;
  notes?: string;
  includeText?: number[];
}
export type LearningInput = LearningReadInput | AnnotationInput;

/** Private reduction reconstructs every field; no unconstrained narrative survives by copying. */
export function privateLearning(record: ModelRecord, includeText = false): ModelRecord {
  return modelRecord({
    date: record.date,
    repo: record.repo,
    pr: record.pr,
    task: includeText ? record.task : "",
    notes: includeText ? record.notes : "",
    kind: kinds.has(record.kind) ? record.kind : "other",
    segments: record.segments.map((segment) => ({
      family: families.has(segment.family) ? segment.family : "other",
      model: families.has(segment.family) ? segment.family : "other",
      rounds: segment.rounds,
      why: reasons.has(segment.why) ? segment.why : "redacted",
      ...(segment.tokens === undefined ? {} : { tokens: segment.tokens }),
      ...(segment.usd === undefined ? {} : { usd: segment.usd }),
      ...(segment.reportedUsd === undefined ? {} : { reportedUsd: segment.reportedUsd }),
      ...(segment.metrics === undefined ? {} : { metrics: segment.metrics }),
      ...(segment.switchReason === undefined ? {} : { switchReason: segment.switchReason }),
      ...(segment.points_open === undefined ? {} : { points_open: segment.points_open }),
      ...(segment.points_final === undefined ? {} : { points_final: segment.points_final }),
      ...(segment.outcome === undefined ? {} : { outcome: segment.outcome }),
    })),
    ...(record.usd === undefined ? {} : { usd: record.usd }),
    ...(record.metrics === undefined ? {} : { metrics: record.metrics }),
    ...(record.tokens === undefined ? {} : { tokens: record.tokens }),
    ...(record.costCoverage === undefined ? {} : { costCoverage: record.costCoverage }),
    points_open: record.points_open,
    points_final: record.points_final,
    rounds: record.rounds,
    round_causes: record.round_causes,
    prompt_defects: record.prompt_defects,
    outcome: record.outcome,
    stalls: record.stalls.map((stall) => ({
      minutes: stall.minutes,
      cause: "",
      detected_by: stall.detected_by,
    })),
    findings: record.findings
      .filter((finding) => tags.has(finding.tag))
      .map((finding) => ({
        tag: finding.tag,
        caught_by: finding.caught_by,
        ...(finding.root_cause_by ? { root_cause_by: finding.root_cause_by } : {}),
      })),
  });
}

/**
 * Server-only learning reads and fork writes; credentials never cross the typed operation seam.
 * Submissions append immutable files to one open project PR without workflow scope. Central and open
 * submissions, not local receipts, determine which delivery PRs are already shared or pending.
 * Confirmed ref updates poll for PR head propagation; exhausted stale reads report a successful push.
 */
export class LearningsService {
  constructor(
    private root: string,
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies,
    private github: () => GitHubClient,
    private snapshot: Record<string, string> = typeof __LEARNINGS__ === "undefined"
      ? {}
      : __LEARNINGS__
  ) {}

  async command(input: LearningInput): Promise<string> {
    if (input.action === "annotate" || input.action === "aggregate") {
      throw new Error("Generation requires the server learning adapter");
    }
    if (
      "family" in input &&
      input.family !== undefined &&
      !/^[a-z][a-z0-9-]*$/.test(input.family)
    ) {
      throw new Error("Invalid learning family");
    }
    switch (input.action) {
      case "show":
        return this.show(input.family);
      case "report":
        return this.report(input);
      case "submit":
        return this.submit(input);
      default:
        throw new Error("Unknown learnings action");
    }
  }

  /** Show current advice and legacy/new evidence, fenced as data, with bundled offline fallback. */
  async show(family?: string): Promise<string> {
    if (family !== undefined && !/^[a-z][a-z0-9-]*$/.test(family)) {
      throw new Error("Invalid learning family");
    }
    const paths = [...(family ? [`learnings/models/${family}.md`] : []), "learnings/lessons.md"];
    const output: string[] = [];
    for (const path of paths) {
      let content: string | undefined;
      let origin = `${central}:${base}`;
      let unavailable = false;
      try {
        content = await this.content(central, path, base);
      } catch (error) {
        unavailable = true;
        this.deps.report(
          `Learnings remote unavailable: ${(error as Error).message}; using bundled snapshot`
        );
      }
      if (unavailable) {
        content = this.snapshot[path];
        origin = "bundled snapshot";
      }
      output.push(
        `from ${origin} (${path})\n${untrusted(content ?? (unavailable ? "No page in bundled snapshot; central read failed" : "No page on central dev"))}`
      );
    }
    output.push(...(await this.showData(family)));
    return output.join("\n\n");
  }

  /** Read delivery records only: immutable annotation JSONL is a separate wire format. */
  records(): ModelRecord[] {
    const directory = join(this.root, "learnings/models");
    const texts = existsSync(directory)
      ? readdirSync(directory, { recursive: true })
          .map(String)
          .filter((name) => name.endsWith(".jsonl") && !isAnnotationPath(name))
          .sort()
          .map((name) => readFileSync(join(directory, name), "utf8"))
      : [];
    if (!texts.length) {
      texts.push(
        ...Object.entries(this.snapshot)
          .filter(([path]) => path.endsWith(".jsonl") && !isAnnotationPath(path))
          .map(([, text]) => text)
      );
    }
    const staging = join(this.root, ".vmethod/model-log.jsonl");
    if (existsSync(staging)) {
      texts.push(readFileSync(staging, "utf8"));
    }
    if (!texts.length) {
      throw new Error("No model-log inputs available");
    }
    return unionRecords(texts);
  }

  private report(input: LearningReadInput): string {
    const directory = join(this.root, "learnings/models");
    const texts = existsSync(directory)
      ? readdirSync(directory, { recursive: true })
          .map(String)
          .filter((name) => name.endsWith(".jsonl") && !isAnnotationPath(name))
          .sort()
          .map((name) => readFileSync(join(directory, name), "utf8"))
      : Object.entries(this.snapshot)
          .filter(
            ([path]) =>
              /^learnings\/models\/(?:[^/]+\/)?[^/]+\.jsonl$/.test(path) && !isAnnotationPath(path)
          )
          .map(([, text]) => text);
    if (!texts.length) {
      throw new Error("No model-log inputs available for report");
    }
    const report = learningReport(unionRecords(texts), input.family, input.kind);
    if (input.json) {
      return JSON.stringify(report, null, 2);
    }
    return plainReport(report);
  }

  private async submit(input: LearningReadInput): Promise<string> {
    if (!["public", "private"].includes(String(this.config.learningsPrivacy))) {
      throw new Error("Set learningsPrivacy explicitly before submitting");
    }
    if (this.config.learningsPrivacy === "private" && input.notes !== undefined) {
      throw new Error(
        "Private distilled notes cannot be cleared per record; use record notes with --include-text <pr>"
      );
    }
    const repo = String(this.config.repo).toLowerCase();
    const logFile = join(this.root, ".vmethod/model-log.jsonl");
    const annotationsDirectory = join(this.root, "learnings/models", repo.replace("/", "-"));
    const annotationOnly =
      this.config.learningsPrivacy === "public" &&
      existsSync(annotationsDirectory) &&
      readdirSync(annotationsDirectory).some((name) =>
        /^notes-\d+-v\d+(?:-\d+)?\.jsonl$/.test(name)
      );
    const records =
      !existsSync(logFile) && annotationOnly ? [] : modelRecords(readFileSync(logFile, "utf8"));
    if (records.some((record) => record.repo.toLowerCase() !== repo)) {
      throw new Error("Model log contains a foreign repository");
    }
    const included = input.includeText ?? [];
    if (
      included.some(
        (pr) => !Number.isSafeInteger(pr) || pr < 1 || !records.some((record) => record.pr === pr)
      )
    ) {
      throw new Error("--include-text must name an existing delivery PR");
    }
    const directory = stateRoot(this.env, String(this.config.stateName ?? repo.replace("/", "-")));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, "learnings.lock");
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          "Learning submission locked; confirm no submission is running before removing a stale lock",
          { cause: error }
        );
      }
      throw error;
    }
    try {
      return await this.submitLocked(input, records, repo, directory, included);
    } finally {
      rmdirSync(lock);
    }
  }

  private async submitLocked(
    input: LearningReadInput,
    records: ModelRecord[],
    repo: string,
    directory: string,
    included: number[]
  ): Promise<string> {
    const state = join(directory, "learnings.json");
    const github = this.github();
    const registry = await this.content(central, "people.yaml", base);
    if (registry === undefined) {
      throw new Error("Missing central learning authorization registry");
    }
    const people = validateYaml(registry, "people", `${central}:people.yaml`) as Person[];
    const viewer = object(await github.rest("/user"));
    const person = learningAuthor(people, viewer, repo);
    const rawNotes = input.notes === undefined ? undefined : readFileSync(input.notes, "utf8");
    if (rawNotes !== undefined) {
      await checkMarkdown(this.root, rawNotes);
      guardClosingKeywords(rawNotes);
    }
    const [owner, name] = repo.split("/");
    const logDirectory = `learnings/models/${owner}-${name}`;
    const notesDirectory = `learnings/notes/${name}`;
    const baseRef = object(await github.rest(`/repos/${central}/git/ref/heads/${base}`));
    const parent = sha(object(baseRef.object).sha);
    const paths = await this.dataPaths(parent);
    const shared = await this.readRecords(
      central,
      paths.filter(
        (path) => path === `${logDirectory}.jsonl` || path.startsWith(`${logDirectory}/`)
      ),
      parent,
      repo
    );
    const pending = await this.pending(people, viewer, repo);
    const known = new Set([...shared, ...pending.records].map((record) => record.pr));
    if (included.some((pr) => known.has(pr))) {
      throw new Error("--include-text cannot amend previously submitted records");
    }
    const fresh = records
      .filter((record) => !known.has(record.pr))
      .map((record) =>
        this.config.learningsPrivacy === "private"
          ? privateLearning(record, included.includes(record.pr))
          : record
      )
      .sort((a, b) => a.pr - b.pr);
    const log = fresh.map((record) => JSON.stringify(record)).join("\n") + "\n";
    let notesShared = rawNotes !== undefined && pending.notes.includes(rawNotes);
    if (rawNotes !== undefined && !notesShared) {
      for (const path of paths.filter(
        (path) => path === `${notesDirectory}.md` || path.startsWith(`${notesDirectory}/`)
      )) {
        if ((await this.requiredContent(central, path, parent)) === rawNotes) {
          notesShared = true;
          break;
        }
      }
    }
    const date = new Date(this.deps.now()).toISOString().slice(0, 10);
    const files = [
      ...(fresh.length
        ? [
            {
              path: `${logDirectory}/${fresh[0].pr}-${fresh.at(-1)!.pr}-${digest(log).slice(0, 12)}.jsonl`,
              content: log,
            },
          ]
        : []),
      ...(rawNotes === undefined || notesShared
        ? []
        : [
            {
              path: `${notesDirectory}/${date}-${digest(rawNotes).slice(0, 12)}.md`,
              content: rawNotes,
            },
          ]),
    ];
    // Annotations are independent immutable evidence, not replacement delivery records.
    const localAnnotations = join(this.root, logDirectory);
    if (this.config.learningsPrivacy === "public" && existsSync(localAnnotations)) {
      for (const name of readdirSync(localAnnotations)
        .filter((name) => /^notes-\d+-v\d+(?:-\d+)?\.jsonl$/.test(name))
        .sort()) {
        const path = `${logDirectory}/${name}`;
        const content = readFileSync(join(localAnnotations, name), "utf8");
        const values = content
          .trim()
          .split("\n")
          .map((line) => annotation(JSON.parse(line)));
        if (
          values.length !== 1 ||
          values[0].repo.toLowerCase() !== repo ||
          !new RegExp(`^notes-${values[0].pr}-v${values[0].promptVersion}(?:-\\d+)?\\.jsonl$`).test(
            name
          )
        ) {
          throw new Error("Annotation does not match project/path");
        }
        const prior =
          pending.annotations.get(path) ??
          (paths.includes(path) ? await this.requiredContent(central, path, parent) : undefined);
        if (prior !== undefined) {
          if (prior !== content) {
            throw new Error(`Immutable annotation differs: ${path}`);
          }
        } else {
          files.push({ path, content });
        }
      }
    }
    const receipt = {
      submitted: fresh.map((record) => record.pr),
      sharedAt: parent,
    };
    if (!files.length) {
      this.saveReceipt(state, receipt);
      return `No new learnings to submit${pending.urls.length ? `\nPending: ${pending.urls.join(", ")}` : ""}`;
    }
    if (pending.targets.length > 1) {
      throw new Error("Multiple open project learning PRs; reconcile before submitting");
    }
    const target = pending.targets[0];
    if (target && !target.addOnly) {
      throw new Error("Legacy learning PR is not add-only; reconcile before submitting");
    }
    learningPaths(
      people,
      viewer,
      repo,
      files.map((file) => ({ filename: file.path, status: "added" }))
    );
    const forkName = `${person.login}/vmethod`;
    let fork: Record<string, unknown>;
    try {
      fork = object(await github.rest(`/repos/${forkName}`));
    } catch (error) {
      if (!(error instanceof GitHubHttpError) || error.status !== 404) {
        throw error;
      }
      await github.rest(`/repos/${central}/forks`, "POST", {}, false);
      fork = {};
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fork = object(await github.rest(`/repos/${forkName}`));
          break;
        } catch (error) {
          if (!(error instanceof GitHubHttpError) || error.status !== 404 || attempt === 4) {
            throw error;
          }
          await this.deps.sleep(1000 * (attempt + 1));
        }
      }
    }
    if (
      fork.fork !== true ||
      String(fork.full_name).toLowerCase() !== forkName.toLowerCase() ||
      object(fork.owner).id !== person.id ||
      String(object(fork.parent).full_name).toLowerCase() !== central
    ) {
      throw new Error("Refusing an unrelated or unverified fork");
    }
    if (target) {
      const endpoint = `/repos/${central}/pulls/${target.number}`;
      const branch = target.branch;
      const refPath = `/repos/${forkName}/git/refs/heads/${branch}`;
      for (const file of files) {
        if (
          paths.includes(file.path) ||
          (await this.content(forkName, file.path, target.head)) !== undefined
        ) {
          throw new Error(`Submission path already exists; refusing to modify ${file.path}`);
        }
      }
      const head = await this.submissionCommit(forkName, target.head, files);
      const current = object(await github.rest(endpoint));
      if (
        current.state !== "open" ||
        object(current.head).sha !== target.head ||
        object(current.head).ref !== branch ||
        object(current.user).id !== person.id ||
        String(object(object(current.head).repo).full_name).toLowerCase() !==
          forkName.toLowerCase() ||
        object(current.base).ref !== base ||
        object(object(current.base).repo).full_name !== central
      ) {
        throw new Error("Pending learning PR moved; retry");
      }
      const updated = object(
        await github.rest(
          refPath,
          "PATCH",
          {
            sha: head,
            force: false,
          },
          false
        )
      );
      if (sha(object(updated.object).sha) !== head) {
        throw new Error("Learning branch update moved; retry");
      }
      let caughtUp = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const after = object(await github.rest(endpoint));
        const afterHead = object(after.head).sha;
        if (after.state !== "open" || (afterHead !== target.head && afterHead !== head)) {
          throw new Error("Pending learning PR moved; retry");
        }
        if (afterHead === head) {
          caughtUp = true;
          break;
        }
        if (attempt < 9) {
          await this.deps.sleep(1000);
        }
      }
      const url = `https://github.com/${central}/pull/${target.number}`;
      this.saveReceipt(state, { ...receipt, url });
      return `Submitted ${fresh.length} records: ${url}\n${caughtUp ? "" : "Learning branch pushed; PR head not yet updated\n"}Learning label pending central validation`;
    }
    const forkRef = object(await github.rest(`/repos/${forkName}/git/ref/heads/${base}`));
    const forkParent = sha(object(forkRef.object).sha);
    for (const file of files) {
      if (
        paths.includes(file.path) ||
        (await this.content(forkName, file.path, forkParent)) !== undefined
      ) {
        throw new Error(`Submission path already exists; refusing to modify ${file.path}`);
      }
    }
    const branch = `learnings/${owner}-${name}-${digest(files).slice(0, 24)}`;
    const refPath = `/repos/${forkName}/git/ref/heads/${branch}`;
    let head: string | undefined;
    try {
      head = sha(object(object(await github.rest(refPath)).object).sha);
    } catch (error) {
      if (!(error instanceof GitHubHttpError) || error.status !== 404) {
        throw error;
      }
    }
    if (head) {
      for (const file of files) {
        if ((await this.content(forkName, file.path, head)) !== file.content) {
          throw new Error("Existing submission branch differs; refusing to overwrite");
        }
      }
      const comparison = object(
        await github.rest(`/repos/${forkName}/compare/${forkParent}...${head}`)
      );
      if (!Array.isArray(comparison.files) || comparison.files.length !== files.length) {
        throw new Error("Existing submission branch has unexpected changes");
      }
      learningPaths(
        people,
        viewer,
        repo,
        comparison.files.map((value) => {
          const file = object(value);
          return {
            filename: String(file.filename),
            status: String(file.status),
            ...(file.previous_filename === undefined
              ? {}
              : { previous_filename: String(file.previous_filename) }),
          };
        })
      );
    } else {
      head = await this.submissionCommit(forkName, forkParent, files);
      await github.rest(
        `/repos/${forkName}/git/refs`,
        "POST",
        { ref: `refs/heads/${branch}`, sha: head },
        false
      );
    }
    const existing = await github.rest(
      `/repos/${central}/pulls?state=all&head=${encodeURIComponent(`${person.login}:${branch}`)}&base=${base}&per_page=100`
    );
    if (!Array.isArray(existing) || existing.length >= 100) {
      throw new Error("Ambiguous submission PR state");
    }
    const active = existing.map(object).filter((pr) => pr.state === "open" || pr.merged_at != null);
    if (active.length > 1) {
      throw new Error("Ambiguous submission PR state");
    }
    let pr = object(active[0]);
    if (!active.length) {
      pr = object(
        await github.rest(
          `/repos/${central}/pulls`,
          "POST",
          {
            title: "docs: share project learnings",
            head: `${person.login}:${branch}`,
            base,
            body: `Learning submission for ${repo}. Central automation validates project authorization and applies the learning label.`,
          },
          false
        )
      );
    }
    const url = String(pr.html_url);
    learningAuthor(people, pr.user, repo);
    if (
      !/^https:\/\/github\.com\/vworlds\/vmethod\/pull\/[1-9]\d*$/.test(url) ||
      object(pr.head).sha !== head ||
      object(pr.head).ref !== branch ||
      String(object(object(pr.head).repo).full_name).toLowerCase() !== forkName.toLowerCase() ||
      object(pr.base).ref !== base ||
      object(object(pr.base).repo).full_name !== central ||
      (pr.state !== "open" && pr.merged_at == null)
    ) {
      throw new Error(
        "Submission PR is mismatched or closed unmerged; retry before recording a receipt"
      );
    }
    this.saveReceipt(state, { ...receipt, url });
    return `Submitted ${fresh.length} records: ${url}\nLearning label pending central validation`;
  }

  private async submissionCommit(
    fork: string,
    parent: string,
    files: { path: string; content: string }[]
  ): Promise<string> {
    const github = this.github();
    const commit = object(await github.rest(`/repos/${fork}/git/commits/${parent}`));
    const tree = object(
      await github.rest(
        `/repos/${fork}/git/trees`,
        "POST",
        {
          base_tree: sha(object(commit.tree).sha),
          tree: files.map((file) => ({ ...file, mode: "100644", type: "blob" })),
        },
        false
      )
    );
    const created = object(
      await github.rest(
        `/repos/${fork}/git/commits`,
        "POST",
        {
          message: "docs: share project learnings",
          tree: sha(tree.sha),
          parents: [parent],
        },
        false
      )
    );
    return sha(created.sha);
  }

  private async dataPaths(ref: string): Promise<string[]> {
    const github = this.github();
    const commit = object(await github.rest(`/repos/${central}/git/commits/${ref}`));
    const tree = object(
      await github.rest(`/repos/${central}/git/trees/${sha(object(commit.tree).sha)}?recursive=1`)
    );
    if (tree.truncated !== false || !Array.isArray(tree.tree)) {
      throw new Error("Incomplete central learning tree");
    }
    const paths: string[] = [];
    for (const value of tree.tree) {
      const entry = object(value);
      if (
        typeof entry.path !== "string" ||
        !["blob", "tree", "commit"].includes(String(entry.type))
      ) {
        throw new Error("Invalid central learning tree entry");
      }
      if (
        entry.type === "blob" &&
        /^learnings\/(?:models|notes)\/(?:[^/]+\/)?[^/]+\.(?:jsonl|md)$/.test(entry.path) &&
        !entry.path.split("/").some((part) => part === "." || part === "..")
      ) {
        paths.push(entry.path);
      }
    }
    if (new Set(paths).size !== paths.length) {
      throw new Error("Duplicate central learning path");
    }
    return paths.sort();
  }

  private async pending(people: Person[], viewer: Record<string, unknown>, repo: string) {
    const github = this.github();
    const author = learningAuthor(people, viewer, repo);
    const [owner, name] = repo.split("/");
    const texts: string[] = [];
    const notes: string[] = [];
    const annotations = new Map<string, string>();
    const urls: string[] = [];
    const targets: { number: number; branch: string; head: string; addOnly: boolean }[] = [];
    for (let page = 1; ; page++) {
      const listed = await github.rest(
        `/repos/${central}/pulls?state=open&base=${base}&per_page=100&page=${page}`
      );
      if (!Array.isArray(listed)) {
        throw new Error("Invalid open learning PR list");
      }
      for (const value of listed) {
        const candidate = object(value);
        const user = object(candidate.user);
        // Gate identity before any further PR/file reads; unrelated PRs are not inputs.
        if (
          user.id !== author.id ||
          user.type !== author.type ||
          String(user.login).toLowerCase() !== author.login.toLowerCase()
        ) {
          continue;
        }
        if (!Number.isSafeInteger(candidate.number) || Number(candidate.number) < 1) {
          throw new Error("Invalid pending learning PR number");
        }
        const number = Number(candidate.number);
        const endpoint = `/repos/${central}/pulls/${number}`;
        const pr = object(await github.rest(endpoint));
        learningAuthor(people, pr.user, repo);
        if (object(pr.user).id !== author.id) {
          throw new Error("Pending learning PR author moved; retry");
        }
        if (
          pr.state !== "open" ||
          object(pr.base).ref !== base ||
          object(object(pr.base).repo).full_name !== central ||
          String(object(object(pr.head).repo).full_name).toLowerCase() !==
            `${author.login}/vmethod`.toLowerCase()
        ) {
          continue;
        }
        const ref = sha(object(pr.head).sha);
        const files = await learningFiles(github, number, pr.changed_files);
        let addOnly = true;
        try {
          learningPaths(people, viewer, repo, files);
        } catch {
          addOnly = false;
          // Read-only compatibility for pre-layout submissions such as PR 47. This
          // does not grant legacy modifications learning-policy/CI authorization.
          const legacy = new Set([
            `learnings/models/${owner}-${name}.jsonl`,
            `learnings/notes/${name}.md`,
          ]);
          if (
            !files.every(
              (file) =>
                legacy.has(file.filename) &&
                ["added", "modified"].includes(file.status) &&
                file.previous_filename === undefined
            )
          ) {
            continue;
          }
        }
        for (const file of files) {
          const content = await this.requiredContent(`${author.login}/vmethod`, file.filename, ref);
          if (/\/notes-\d+-v\d+(?:-\d+)?\.jsonl$/.test(file.filename)) {
            const value = annotation(JSON.parse(content.trim()));
            if (value.repo.toLowerCase() !== repo) {
              throw new Error("Foreign pending annotation");
            }
            const prior = annotations.get(file.filename);
            if (prior !== undefined && prior !== content) {
              throw new Error("Conflicting pending annotation");
            }
            annotations.set(file.filename, content);
          } else if (file.filename.endsWith(".jsonl")) {
            texts.push(content);
          } else {
            notes.push(content);
          }
        }
        const current = object(await github.rest(endpoint));
        if (
          current.state !== "open" ||
          object(current.head).sha !== ref ||
          object(current.user).id !== author.id ||
          current.changed_files !== pr.changed_files
        ) {
          throw new Error("Pending learning PR moved; retry");
        }
        urls.push(`https://github.com/${central}/pull/${number}`);
        const branch = object(pr.head).ref;
        if (
          typeof branch !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) ||
          branch.split("/").some((part) => !part || part === "." || part === "..")
        ) {
          throw new Error("Invalid pending learning branch");
        }
        targets.push({ number, branch, head: ref, addOnly });
      }
      if (listed.length < 100) {
        break;
      }
      if (page >= 30) {
        throw new Error("Open learning PR pagination limit reached");
      }
    }
    const records = unionRecords(texts);
    if (records.some((record) => record.repo.toLowerCase() !== repo)) {
      throw new Error("Pending model log contains a foreign repository");
    }
    return { records, notes, annotations, urls, targets };
  }

  private async readRecords(repo: string, paths: string[], ref: string, source?: string) {
    const texts: string[] = [];
    for (const path of paths.filter((path) => path.endsWith(".jsonl") && !isAnnotationPath(path))) {
      texts.push(await this.requiredContent(repo, path, ref));
    }
    const records = unionRecords(texts);
    if (source !== undefined && records.some((record) => record.repo.toLowerCase() !== source)) {
      throw new Error("Shared model log contains a foreign repository");
    }
    return records;
  }

  private async requiredContent(repo: string, path: string, ref: string): Promise<string> {
    const content = await this.content(repo, path, ref);
    if (content === undefined) {
      throw new Error(`Missing listed learning file ${path}`);
    }
    return content;
  }

  private async showData(family?: string): Promise<string[]> {
    const isData = (path: string) =>
      /^learnings\/models\/(?:[^/]+\/)?[^/]+\.jsonl$/.test(path) ||
      /^learnings\/notes\/(?:[^/]+\/)?[^/]+\.md$/.test(path);
    const texts: [string, string][] = [];
    let origin = `${central}:${base}`;
    try {
      const ref = object(await this.github().rest(`/repos/${central}/git/ref/heads/${base}`));
      const parent = sha(object(ref.object).sha);
      for (const path of (await this.dataPaths(parent)).filter(isData)) {
        texts.push([path, await this.requiredContent(central, path, parent)]);
      }
    } catch (error) {
      this.deps.report(
        `Learnings remote unavailable: ${(error as Error).message}; using bundled snapshot`
      );
      texts.length = 0;
      texts.push(...Object.entries(this.snapshot).filter(([path]) => isData(path)));
      origin = "bundled snapshot";
    }
    const records = unionRecords(
      texts
        .filter(([path]) => path.endsWith(".jsonl") && !isAnnotationPath(path))
        .map(([, text]) => text)
    ).filter((record) => !family || record.segments.some((segment) => segment.family === family));
    return [
      ...(records.length
        ? [
            `from ${origin} (model records: legacy seeds and submissions)\n${untrusted(records.map((record) => JSON.stringify(record)).join("\n"))}`,
          ]
        : []),
      ...texts
        .filter(
          ([path]) =>
            path.startsWith("learnings/notes/") || /\/notes-\d+-v\d+(?:-\d+)?\.jsonl$/.test(path)
        )
        .map(([path, text]) => `from ${origin} (${path})\n${untrusted(text)}`),
    ];
  }

  private saveReceipt(path: string, value: unknown): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  }

  private async content(repo: string, path: string, ref: string): Promise<string | undefined> {
    let data;
    try {
      data = object(
        await this.github().rest(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)
      );
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
    if (
      data.type !== "file" ||
      data.encoding !== "base64" ||
      typeof data.content !== "string" ||
      data.path !== path
    ) {
      throw new Error("Invalid learning content response");
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  }
}

function unionRecords(texts: string[]): ModelRecord[] {
  const records = new Map<string, ModelRecord>();
  for (const text of texts) {
    for (const record of modelRecords(text)) {
      const key = `${record.repo.toLowerCase()}#${record.pr}`;
      const previous = records.get(key);
      if (previous && !isDeepStrictEqual(previous, record)) {
        throw new Error(`Conflicting shared delivery ${key}`);
      }
      records.set(key, record);
    }
  }
  return [...records.values()];
}

function plainReport(report: ReturnType<typeof learningReport>): string {
  const ratio = (value: number | null) => (value === null ? "n/a" : value.toFixed(2));
  const counts = (title: string, values: Record<string, number>, rates = false) => [
    `${title}:`,
    ...Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `  ${key}: ${rates ? ratio(value) : value}`),
    ...(Object.keys(values).length ? [] : ["  none"]),
  ];
  const group = (value: typeof report | (typeof report.byFamily)[string]) => [
    `Deliveries: ${value.deliveries}; rounds: ${value.rounds}; points: ${value.points}; rounds per point: ${ratio(value.roundsPerPoint)}`,
    `USD: ${ratio(value.usd)}; USD per estimate point: ${ratio(value.usdPerPoint)}`,
    ...counts("Finding rates", value.findingsRate, true),
    ...counts("Caught by", value.caughtBy),
    ...counts("Outcomes", value.outcomes),
    ...counts("Switch reasons", value.switchReasons),
  ];
  return [
    ...group(report),
    ...(
      [
        ["By family", report.byFamily],
        ["By kind", report.byKind],
      ] as const
    ).flatMap(([title, groups]) => [
      title,
      ...Object.entries(groups).flatMap(([name, value]) => [
        `  ${name}`,
        ...group(value).map((line) => `    ${line}`),
      ]),
    ]),
  ].join("\n");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("Missing Git object SHA");
  }
  return value;
}
