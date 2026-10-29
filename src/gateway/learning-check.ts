import { validateYaml } from "../config.js";
import type { GitHubClient } from "./client.js";
import { learningPaths } from "./learning-policy.js";
import { object } from "./people.js";

/** Read metadata only; this operation never reads or executes a fork's files or configuration. */
export async function checkLearningPr(
  github: GitHubClient,
  pr: number,
  label = false
): Promise<string> {
  const repo = "vworlds/vmethod";
  const endpoint = `/repos/${repo}/pulls/${pr}`;
  const metadata = object(await github.rest(endpoint));
  const learningLabel =
    Array.isArray(metadata.labels) &&
    metadata.labels.some((entry) => object(entry).name === "learning");
  try {
    return await validateLearningPr(github, metadata, pr, label, learningLabel);
  } catch (error) {
    if (label && learningLabel) {
      await github.rest(`/repos/${repo}/issues/${pr}/labels/learning`, "DELETE", undefined, false);
    }
    throw error;
  }
}

/** Validate pinned PR metadata and recheck its refs before granting learning-only access. */
export async function validateLearningPr(
  github: GitHubClient,
  metadata: Record<string, unknown>,
  pr: number,
  label: boolean,
  learningLabel: boolean
): Promise<string> {
  const repo = "vworlds/vmethod";
  const endpoint = `/repos/${repo}/pulls/${pr}`;
  const head = object(metadata.head);
  const base = object(metadata.base);
  if (
    metadata.state !== "open" ||
    object(base.repo).full_name !== repo ||
    typeof base.ref !== "string" ||
    !/^[a-f0-9]{40}$/.test(String(base.sha)) ||
    !/^[a-f0-9]{40}$/.test(String(head.sha))
  ) {
    throw new Error("Learning PR has invalid base/head metadata");
  }
  const user = object(metadata.user);
  // Read the central registry from the pinned, protected base, never from the fork.
  const content = object(await github.rest(`/repos/${repo}/contents/people.yaml?ref=${base.sha}`));
  if (
    content.type !== "file" ||
    content.path !== "people.yaml" ||
    content.encoding !== "base64" ||
    typeof content.content !== "string"
  ) {
    throw new Error("Missing central learning registry");
  }
  const people = validateYaml(
    Buffer.from(content.content, "base64").toString("utf8"),
    "people",
    `${repo}:people.yaml`
  );
  const author = people.find(
    (person) =>
      person.id === user.id &&
      person.login.toLowerCase() === String(user.login).toLowerCase() &&
      person.type === user.type &&
      person.role === "orchestrator"
  );
  const fork = object(head.repo).full_name !== repo;
  const files = await learningFiles(github, pr, metadata.changed_files);
  const touchesLearnings = files.some(
    (file) =>
      /^learnings\/(?:models|notes)\//.test(file.filename) ||
      /^learnings\/(?:models|notes)\//.test(file.previous_filename ?? "")
  );
  // Normal task deliveries may seed data or implement the tool. Fork submissions cannot
  // bypass the guard by omitting a label: all fork PRs touching learning data are checked.
  if (!learningLabel && !(fork && touchesLearnings)) {
    return "Not a learning submission";
  }
  if (base.ref !== "dev") {
    throw new Error("Learning submissions must target central dev");
  }
  let valid = false;
  for (const source of author?.repos ?? []) {
    try {
      learningPaths(people, user, source, files);
      valid = true;
      break;
    } catch {
      /* Try only explicit owner-approved bindings. */
    }
  }
  const current = object(await github.rest(endpoint));
  if (
    object(current.head).sha !== head.sha ||
    object(current.base).sha !== base.sha ||
    current.state !== "open" ||
    object(current.user).id !== user.id ||
    current.changed_files !== metadata.changed_files
  ) {
    throw new Error("Learning PR moved during validation; retry");
  }
  if (!valid) {
    throw new Error("Learning PR denied: author/project binding or changed paths do not match");
  }
  if (label) {
    await github.rest(
      `/repos/${repo}/issues/${pr}/labels`,
      "POST",
      { labels: ["learning"] },
      false
    );
  }
  return `Learning PR #${pr}: authorized${label ? "; learning label applied" : ""}`;
}

/** Read the complete, bounded, duplicate-free changed-file list for a central learning PR. */
export async function learningFiles(github: GitHubClient, pr: number, count: unknown) {
  const endpoint = `/repos/vworlds/vmethod/pulls/${pr}`;
  const files: { filename: string; status: string; previous_filename?: string }[] = [];
  if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 3000) {
    throw new Error("Incomplete learning PR changed-file metadata");
  }
  if (count === 0) {
    return files;
  }
  for (let page = 1; ; page++) {
    const values = await github.rest(`${endpoint}/files?per_page=100&page=${page}`);
    if (!Array.isArray(values)) {
      throw new Error("Missing learning PR file list");
    }
    for (const value of values) {
      const file = object(value);
      if (
        typeof file.filename !== "string" ||
        typeof file.status !== "string" ||
        (file.previous_filename !== undefined && typeof file.previous_filename !== "string")
      ) {
        throw new Error("Invalid learning PR file metadata");
      }
      files.push({
        filename: file.filename,
        status: file.status,
        ...(file.previous_filename === undefined
          ? {}
          : { previous_filename: file.previous_filename as string }),
      });
    }
    if (values.length < 100) {
      break;
    }
    if (page >= 30) {
      throw new Error("Learning PR file pagination limit reached");
    }
  }
  if (files.length !== count || new Set(files.map((file) => file.filename)).size !== files.length) {
    throw new Error("Incomplete learning PR changed-file list");
  }
  return files;
}
