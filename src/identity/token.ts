import type { Config } from "../config.js";
import type { GitHubClient } from "../gateway/client.js";
import type { PeopleFilter, Person, ObjectData } from "../gateway/people.js";
import { object } from "../gateway/people.js";
import type { CallContext, Operations } from "../gateway/transport.js";

/** Read only the non-secret credential identity; callers may cache this promise. */
export async function tokenViewer(client: GitHubClient): Promise<ObjectData> {
  return object(
    object(await client.graphql("query GatewayIdentity { viewer { databaseId login __typename } }"))
      .viewer
  );
}

/** Match token pins strictly; only the gated Actions learning path permits its recorded User viewer. */
export function tokenIdentity(
  viewer: ObjectData,
  filter: PeopleFilter,
  actionsLearningCheck = false
): Person {
  const person =
    filter.identity(viewer, false) ??
    (actionsLearningCheck && viewer.__typename === "User"
      ? filter.people.find(
          (person) =>
            person.role === "system" &&
            person.type === "Bot" &&
            person.id === viewer.databaseId &&
            person.login === viewer.login
        )
      : undefined);
  if (!person) {
    throw new Error(
      `Gateway token refused: identity is not pinned in people.yaml: login=${String(viewer.login ?? "<missing>")} databaseId=${String(viewer.databaseId ?? "<missing>")} type=${String(viewer.__typename ?? "<missing>")}`
    );
  }
  return person;
}

/** Per-gateway lazy authentication; config and client are resolved after watcher reloads. */
export class TokenAuthentication {
  private identity?: Promise<ObjectData>;
  constructor(
    private github: () => GitHubClient,
    private config: () => Config,
    private filter: PeopleFilter,
    private env: NodeJS.ProcessEnv
  ) {}
  /** Cache the promise too, so concurrent first calls share one viewer lookup. */
  async authenticate(ctx: CallContext, operation: keyof Operations): Promise<boolean> {
    const viewer = await (this.identity ??= tokenViewer(this.github()));
    const actionsLearningCheck =
      operation === "learningCheck" &&
      this.env.GITHUB_ACTIONS === "true" &&
      ctx.taskPr === undefined;
    const person = tokenIdentity(viewer, this.filter, actionsLearningCheck);
    // Authority is per repository (#186): a peer project's orchestrator holds no
    // gateway orchestration role for this configuration's repository.
    const role = this.filter.roleIn(person, String(this.config().repo));
    // The CI-only learning validator retains its pinned-base registry and write gates.
    // Neither an environment flag alone nor a system identity grants any other verb.
    if (person.role === "system" && actionsLearningCheck) {
      return true;
    }
    if (role !== "orchestrator" && role !== "worker") {
      throw new Error(
        `Gateway token refused: ${person.login} (${role}) is not an orchestrator or worker identity`
      );
    }
    if (ctx.taskPr !== undefined && role !== "worker") {
      throw new Error(
        `worker session holds a non-worker token (${person.login}); fix the worker environment`
      );
    }
    if (ctx.role === "orchestrator" && role !== "orchestrator") {
      throw new Error(
        `VMETHOD_ROLE=orchestrator refused: token belongs to ${person.login} (${role})`
      );
    }
    return false;
  }
}
