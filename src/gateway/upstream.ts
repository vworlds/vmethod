import packageMetadata from "../../package.json" with { type: "json" };
import { validateYaml } from "../config.js";
import { GitHubClient, GitHubHttpError } from "./client.js";
import { base, central } from "./learnings.js";
import { object, type Person } from "./people.js";
import { learningAuthor } from "./learning-policy.js";

/** The provenance footer: the consumer repository and its pinned vmethod version. */
export function upstreamFooter(repo: string): string {
  return `Filed from ${repo} (vmethod ${packageMetadata.version})`;
}

/** The central gate the two upstream verbs share (#333): require the token viewer's
 * numeric id, account type and login to pin in vworlds/vmethod's people.yaml from
 * dev as an `orchestrator` bound to this checkout's configured repository. The
 * local people.yaml cannot grant this; an unbound caller is refused with the
 * owner ask before any write. */
export async function upstreamCaller(github: GitHubClient, repo: string): Promise<Person> {
  const people = validateYaml(await registryText(github), "people", `${central}:people.yaml`);
  const viewer = object(await github.rest("/user"));
  try {
    return learningAuthor(people, viewer, repo);
  } catch (error) {
    throw new Error(
      `ask the vmethod owner to bind ${String(viewer.login ?? "<missing>")} to ${repo} in vworlds/vmethod people.yaml`,
      { cause: error }
    );
  }
}

/** The central registry: vworlds/vmethod's people.yaml from dev; absence fails closed. */
async function registryText(github: GitHubClient): Promise<string> {
  try {
    const data = object(
      await github.rest(`/repos/${central}/contents/people.yaml?ref=${encodeURIComponent(base)}`)
    );
    if (
      data.type !== "file" ||
      data.encoding !== "base64" ||
      typeof data.content !== "string" ||
      data.path !== "people.yaml"
    ) {
      throw new Error("Invalid central registry response");
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) {
      throw new Error("Missing central upstream authorization registry", { cause: error });
    }
    throw error;
  }
}
