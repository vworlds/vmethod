import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePlan } from "./release-plan.mjs";
import { releaseNotes } from "./release-notes.mjs";

/** Publish once per source commit, then repair missing release metadata on retries. */
export function publish(run = execFileSync) {
  const candidate = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const requiredRef = candidate ? "refs/heads/dev" : "refs/heads/master";
  if (process.env.GITHUB_REF !== requiredRef) {
    throw new Error(`Publishing requires ${requiredRef}`);
  }
  const command = (bin, args, timeout = 10000) =>
    run(bin, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  let metadata;
  try {
    metadata = JSON.parse(command("npm", ["view", pkg.name, "--json"], 60000));
  } catch (error) {
    const text = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (!text.includes("E404") || metadata) {
      throw error;
    }
    metadata = { versions: [], "dist-tags": {} };
  }
  const head = command("git", ["rev-parse", "HEAD"]);
  // npm's wildcard ranges exclude RCs. An explicit union includes them and
  // recovers gitHead even if publication succeeded but tagging failed.
  const versions = (metadata.versions ?? []).filter((version) =>
    (candidate ? /^\d+\.\d+\.\d+-rc\.\d+$/ : /^\d+\.\d+\.\d+$/).test(version)
  );
  const records = versions.length
    ? JSON.parse(
        command(
          "npm",
          ["view", `${pkg.name}@${versions.join(" || ")}`, "version", "gitHead", "--json"],
          60000
        )
      )
    : [];
  const matching = (Array.isArray(records) ? records : [records]).filter(
    (entry) => entry.gitHead === head
  );
  if (matching.length > 1) {
    throw new Error(`Multiple published versions for ${head}; refusing ambiguous retry`);
  }
  const published = matching[0];
  const latest = metadata?.["dist-tags"]?.latest ?? "0.0.0";
  if (!/^\d+\.\d+\.\d+$/.test(latest)) {
    throw new Error(`Invalid latest stable version: ${latest}`);
  }
  const tags = command("git", ["tag", "--merged", "HEAD"]).split("\n");
  const fragmentsSince = (previous) => {
    const paths = previous
      ? command("git", [
          "diff",
          "--name-only",
          "--diff-filter=A",
          `${previous}..HEAD`,
          "--",
          "changes/unreleased",
        ]).split("\n")
      : readdirSync("changes/unreleased").map((file) => `changes/unreleased/${file}`);
    return paths
      .filter((file) => /^changes\/unreleased\/\d+\.md$/.test(file))
      .map((file) => ({
        number: file.match(/(\d+)\.md$/)[1],
        text: readFileSync(file, "utf8"),
      }));
  };
  const plan = published
    ? { version: published.version, tag: candidate ? "next" : "latest" }
    : releasePlan(
        metadata,
        fragmentsSince(tags.includes(`v${latest}`) ? `v${latest}` : null).map(({ text }) => text),
        candidate
      );
  const tag = `v${plan.version}`;
  const previousTags = tags.filter(
    (entry) => /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(entry) && entry !== tag
  );
  const previous = previousTags.length
    ? command("git", [
        "describe",
        "--tags",
        "--abbrev=0",
        ...previousTags.flatMap((entry) => ["--match", entry]),
        "HEAD",
      ])
    : null;
  writeFileSync("RELEASE-NOTES.md", releaseNotes(plan.version, fragmentsSince(previous)));
  if (!published) {
    pkg.version = plan.version;
    writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
    command("npm", ["run", "build"], 120000);
    try {
      command("npm", ["publish", "--provenance", "--access", "public", "--tag", plan.tag], 120000);
    } catch (error) {
      const text = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
      if (/ENEEDAUTH|E401|E403|E404|EOTP|trusted publish|OIDC/i.test(text)) {
        console.error(
          "trusted publisher not configured: owner must configure npm OIDC trusted publishing for this repository and publish.yml"
        );
      }
      throw new Error(`npm publish failed for ${plan.version}: ${text}`, { cause: error });
    }
    // No bump commit: the immutable tag is the published source of truth.
    command("git", ["tag", tag]);
    command("git", ["push", "origin", `refs/tags/${tag}`], 60000);
  }
  // Listing distinguishes an absent release from authentication/network failures.
  try {
    const releases = JSON.parse(
      command(
        "gh",
        ["api", "--paginate", "--slurp", "repos/vworlds/vmethod/releases?per_page=100"],
        60000
      )
    ).flat();
    if (!releases.some((release) => release.tag_name === tag)) {
      command(
        "gh",
        [
          "release",
          "create",
          tag,
          "--repo",
          "vworlds/vmethod",
          "--target",
          head,
          "--title",
          tag,
          "--notes-file",
          "RELEASE-NOTES.md",
          ...(candidate ? ["--prerelease"] : []),
        ],
        60000
      );
    }
  } catch (error) {
    throw new Error(
      `GitHub release failed for ${plan.version}; rerun this workflow to create the missing release: ${error.stderr ?? error.message}`,
      { cause: error }
    );
  }
  console.log(`Published ${pkg.name}@${plan.version} (${plan.tag}), release ${tag}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publish();
}
