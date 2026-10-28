import { Kind, parse, print, visit, type DocumentNode, type SelectionNode } from "graphql";
import { object, type ObjectData, type PeopleFilter, labelled, checkFacts } from "./people.js";
import { isDigestLink } from "./digest.js";

export const actorFields = "__typename login ... on User { databaseId } ... on Bot { databaseId }";
export const identityFields = `id author { ${actorFields} } editor { ${actorFields} } lastEditedAt repository { nameWithOwner owner { login } }`;

const contentTypes = new Set([
  "Issue",
  "PullRequest",
  "IssueComment",
  "PullRequestReview",
  "PullRequestReviewComment",
]);
const contentFields = new Set(["issue", "pullRequest", "issueOrPullRequest"]);
const contentNames = new Set(["body", "bodyText", "bodyHTML", "title", "author", "editor"]);
const injection = parse(
  `{ placeholder { __vm_author: author { ${actorFields} } __vm_editor: editor { ${actorFields} } __vm_edited: lastEditedAt __vm_url: url __vm_repository: repository { nameWithOwner owner { login } } } }`
);
const repoInjection = parse(
  "{ placeholder { __vm_owner: owner { login } __vm_repo: nameWithOwner } }"
);
const checkInjection = parse(
  "{ placeholder { __vm_app: checkSuite { app { databaseId } repository { nameWithOwner owner { login } } commit { oid } } __vm_status: status __vm_conclusion: conclusion } }"
);
const statusInjection = parse(
  `{ placeholder { __vm_statusActor: creator { ${actorFields} } __vm_statusState: state __vm_statusCommit: commit { repository { nameWithOwner owner { login } } } } }`
);
const actorInjection = parse(
  "{ placeholder { __vm_actor: __typename __vm_login: login ... on User { __vm_databaseId: databaseId } } }"
);
const contentConnections = new Set([
  "issues",
  "pullRequests",
  "comments",
  "reviews",
  "reviewComments",
  "issueComments",
  "pullRequestReviews",
  "pullRequestReviewComments",
]);
function selections(document: DocumentNode): readonly SelectionNode[] {
  const operation = document.definitions[0];
  if (operation.kind !== Kind.OPERATION_DEFINITION) {
    throw new Error("Invalid internal query");
  }
  const field = operation.selectionSet.selections[0];
  if (field.kind !== Kind.FIELD || !field.selectionSet) {
    throw new Error("Invalid internal query");
  }
  return field.selectionSet.selections;
}

/** Parse the entire document: comments, strings and fragments cannot hide mutations. */
export function readQuery(source: string): string {
  const document = parse(source, { maxTokens: 20000 });
  const operations = document.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION
  );
  if (
    operations.length !== 1 ||
    operations[0].operation !== "query" ||
    document.definitions.some(
      (definition) =>
        ![Kind.OPERATION_DEFINITION, Kind.FRAGMENT_DEFINITION].includes(
          definition.kind as typeof Kind.OPERATION_DEFINITION
        )
    )
  ) {
    throw new Error(
      "gh-read permits one GraphQL query only; mutations and subscriptions are refused"
    );
  }
  visit(document, {
    Field(node) {
      if (node.alias?.value.startsWith("__vm_") || node.name.value.startsWith("__vm_")) {
        throw new Error("Reserved gateway field alias");
      }
    },
  });
  const enriched = visit(document, {
    SelectionSet(node, _key, parent, _path, ancestors) {
      if (!parent || !("kind" in parent)) {
        return;
      }
      // A top-level account field verifies itself through the injected marker (#323),
      // whatever the caller selects: no intervening field means a top-level `user`.
      if (
        parent.kind === Kind.FIELD &&
        parent.name.value === "user" &&
        !ancestors.some(
          (ancestor) =>
            !Array.isArray(ancestor) && "kind" in ancestor && ancestor.kind === Kind.FIELD
        )
      ) {
        return {
          ...node,
          selections: [...node.selections, ...selections(actorInjection)],
        };
      }
      let extra: readonly SelectionNode[] = [];
      const container = [...ancestors]
        .reverse()
        .find(
          (ancestor) =>
            !Array.isArray(ancestor) &&
            "kind" in ancestor &&
            ancestor.kind === Kind.FIELD &&
            (contentConnections.has(ancestor.name.value) || ancestor.name.value === "checkRuns")
        );
      const connection =
        container && "kind" in container && container.kind === Kind.FIELD
          ? container.name.value
          : "";
      const connectionNode =
        parent.kind === Kind.FIELD && ["nodes", "node"].includes(parent.name.value);
      if (
        (parent.kind === Kind.FIELD && parent.name.value === "repository") ||
        ((parent.kind === Kind.INLINE_FRAGMENT || parent.kind === Kind.FRAGMENT_DEFINITION) &&
          parent.typeCondition?.name.value === "Repository")
      ) {
        extra = selections(repoInjection);
      } else if (
        (parent.kind === Kind.FIELD && parent.name.value === "checkRun") ||
        ((parent.kind === Kind.INLINE_FRAGMENT || parent.kind === Kind.FRAGMENT_DEFINITION) &&
          parent.typeCondition?.name.value === "CheckRun") ||
        (connectionNode && connection === "checkRuns")
      ) {
        extra = selections(checkInjection);
      } else if (
        ((parent.kind === Kind.INLINE_FRAGMENT || parent.kind === Kind.FRAGMENT_DEFINITION) &&
          parent.typeCondition?.name.value === "StatusContext") ||
        (node.selections.some(
          (selection) => selection.kind === Kind.FIELD && selection.name.value === "creator"
        ) &&
          node.selections.some(
            (selection) => selection.kind === Kind.FIELD && selection.name.value === "context"
          ))
      ) {
        extra = selections(statusInjection);
      } else if (
        (parent.kind === Kind.FIELD && contentFields.has(parent.name.value)) ||
        (connectionNode && contentConnections.has(connection)) ||
        ((parent.kind === Kind.INLINE_FRAGMENT || parent.kind === Kind.FRAGMENT_DEFINITION) &&
          parent.typeCondition &&
          contentTypes.has(parent.typeCondition.name.value)) ||
        node.selections.some(
          (selection) => selection.kind === Kind.FIELD && contentNames.has(selection.name.value)
        )
      ) {
        extra = selections(injection);
      }
      if (extra.length) {
        return { ...node, selections: [...node.selections, ...extra] };
      }
    },
  });
  return print(enriched);
}

export function repoOf(item: ObjectData): { owner: string; repo: string } {
  const repo = object(item.repository ?? item.__vm_repository);
  return {
    owner: String(object(repo.owner).login ?? ""),
    repo: String(repo.nameWithOwner ?? ""),
  };
}

export function restActor(value: unknown): ObjectData {
  const actor = object(value);
  return { databaseId: actor.id, __typename: actor.type, login: actor.login };
}

/** REST list items call their accounts `user` or `author`; GraphQL ones use actor fields. */
function restActorFields(value: unknown): boolean {
  const fields = object(value);
  return "id" in fields || "type" in fields;
}

/**
 * Filter a GraphQL data object: every top-level field filters on its own and the
 * root itself is never treated as an item (#323: an unaliased top-level
 * `user(login:)` must not be misread as a REST issue whose author is `item.user`).
 * A field value with the query's injected `__vm_actor` marker is its own author:
 * keep it (without injected keys) only when pinned, otherwise drop and count it.
 */
export function filterData(
  data: unknown,
  filter: PeopleFilter,
  repo: string,
  link: string,
  counts = { dropped: 0, redacted: 0 }
): ObjectData {
  const output: ObjectData = {};
  for (const [field, value] of Object.entries(object(data))) {
    const actor = object(value);
    if ("__vm_actor" in actor) {
      const person = filter.accept(
        {
          author: {
            __typename: actor.__vm_actor,
            databaseId: actor.__vm_databaseId,
            login: actor.__vm_login,
          },
          repository: { nameWithOwner: repo },
        },
        repo.split("/")[0],
        link
      );
      if (!person) {
        counts.dropped++;
      } else {
        output[field] = {
          ...Object.fromEntries(Object.entries(actor).filter(([key]) => !key.startsWith("__vm_"))),
          attribution: `from ${person.login} (${person.role})`,
        };
      }
      continue;
    }
    const filtered = filterDiagnostic(value, filter, repo, link, counts);
    if (filtered !== undefined) {
      output[field] = filtered;
    }
  }
  return output;
}

/** Filter one diagnostic response; top-level removals count as drops, nested ones as redactions. */
export function filterDiagnostic(
  value: unknown,
  filter: PeopleFilter,
  repo: string,
  link: string,
  counts = { dropped: 0, redacted: 0 }
): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      const result = filterDiagnosticValue(child, filter, repo, link, counts);
      if (result === undefined) {
        counts.dropped++;
        return [];
      }
      return [result];
    });
  }
  if (value !== null && typeof value === "object") {
    const result = filterDiagnosticValue(value, filter, repo, link, counts);
    if (result === undefined) {
      counts.dropped++;
    }
    return result;
  }
  return filterDiagnosticValue(value, filter, repo, link, counts);
}

function filterDiagnosticValue(
  value: unknown,
  filter: PeopleFilter,
  repo: string,
  link: string,
  counts: { dropped: number; redacted: number },
  branchMetadata = false
): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      const result = filterDiagnosticValue(child, filter, repo, link, counts);
      if (result === undefined) {
        counts.redacted++;
        return [];
      }
      return [result];
    });
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const item = object(value);
  if (isDigestLink(item.__vm_url ?? item.html_url)) {
    link = String(item.__vm_url ?? item.html_url);
  } else if (
    typeof item.__vm_repo === "string" &&
    isDigestLink(`https://github.com/${item.__vm_repo}`)
  ) {
    link = `https://github.com/${item.__vm_repo}`;
  } else if (isDigestLink(`https://github.com/${repoOf(item).repo}`)) {
    link = `https://github.com/${repoOf(item).repo}`;
  }
  if ("__vm_statusActor" in item) {
    const commit = object(item.__vm_statusCommit);
    const owner = repoOf(commit).owner;
    const person = filter.accept(
      { author: item.__vm_statusActor, repository: commit.repository },
      owner,
      link,
      "status"
    );
    return person
      ? {
          attribution: `from ${person.login} (${person.role})`,
          state: ["ERROR", "FAILURE", "PENDING", "SUCCESS", "EXPECTED"].includes(
            String(item.__vm_statusState)
          )
            ? item.__vm_statusState
            : "unknown",
        }
      : undefined;
  }
  if ("__vm_app" in item) {
    const suite = object(item.__vm_app);
    const app = object(suite.app);
    const scope = repoOf({ repository: suite.repository });
    const run = {
      app: { id: app.databaseId },
      head_sha: object(suite.commit).oid,
      status: String(item.__vm_status).toLowerCase(),
      conclusion: String(item.__vm_conclusion).toLowerCase(),
    };
    const person = filter.check(run, scope.owner, link);
    return person
      ? {
          attribution: `from ${person.login} (${person.role})`,
          ...checkFacts(run),
        }
      : undefined;
  }
  if ("app" in item && ("conclusion" in item || "check_suite" in item)) {
    const person = filter.check(item, repo.split("/")[0], link);
    return person
      ? {
          attribution: `from ${person.login} (${person.role})`,
          ...checkFacts(item),
        }
      : undefined;
  }
  const systemKind =
    "creator" in item && "context" in item && "state" in item
      ? "status"
      : "workflow_id" in item && "actor" in item
        ? "workflow_run"
        : undefined;
  if (systemKind) {
    const repository = object(item.repository);
    const owner = String(object(repository.owner).login ?? repo.split("/")[0]);
    const person = filter.accept(
      { author: restActor(item.actor ?? item.creator) },
      owner,
      link,
      systemKind
    );
    if (!person) {
      return undefined;
    }
    return {
      attribution: `from ${person.login} (${person.role})`,
      ...checkFacts(item),
      ...(systemKind === "status"
        ? {
            state: ["error", "failure", "pending", "success"].includes(String(item.state))
              ? item.state
              : "unknown",
          }
        : {}),
    };
  }
  if (
    "__vm_owner" in item &&
    String(object(item.__vm_owner).login).toLowerCase() !== filter.org.toLowerCase()
  ) {
    filter.accept({}, "", link);
    return undefined;
  }
  // Only a `user` value with REST actor fields is a REST identity (#323): GraphQL-shaped
  // or removed values must not pose as authors.
  const restUser = "user" in item && restActorFields(item.user);
  const hasIdentity = "__vm_author" in item || "author" in item || restUser;
  const hasContent = Object.keys(item).some((key) =>
    ["body", "body_text", "body_html", "title"].includes(key)
  );
  // A PR branch's user is its repository owner (often an Organization), not an author.
  const structuralBranch =
    branchMetadata &&
    typeof item.ref === "string" &&
    typeof item.sha === "string" &&
    "repo" in item &&
    !("__vm_author" in item) &&
    !("author" in item) &&
    !hasContent;
  let attribution: string | undefined;
  // Git metadata is not a GitHub identity and can never authorize instructions.
  const signatureOnly =
    !("__vm_author" in item) &&
    !restUser &&
    !hasContent &&
    (gitCommit(item) || (item.author === null && gitCommit(object(item.commit))));
  if (signatureOnly) {
    attribution = "git signature (unverified)";
  } else if ((hasIdentity || hasContent) && !structuralBranch) {
    const injected = "__vm_author" in item;
    const author = injected
      ? item.__vm_author
      : "user" in item
        ? restUser
          ? restActor(item.user)
          : item.user // without REST actor fields nothing here is a verifiable author
        : restActorFields(item.author)
          ? restActor(item.author)
          : item.author;
    const owner = injected ? repoOf(item).owner : repo.split("/")[0];
    // REST cannot establish an editor's identity. Never relay edited free text on that path.
    const unknownEditor =
      !injected &&
      hasContent &&
      (typeof item.created_at !== "string" || item.updated_at !== item.created_at);
    // GraphQL reads inject `__vm_repository`; REST list items carry none, so the
    // read context scopes their authors there.
    const known = repoOf(item).repo;
    const repository = known
      ? (item.repository ?? item.__vm_repository)
      : { nameWithOwner: repo, owner: { login: owner } };
    const person = filter.accept(
      {
        author,
        editor: injected ? item.__vm_editor : item.editor,
        lastEditedAt: unknownEditor ? "unknown" : injected ? item.__vm_edited : item.lastEditedAt,
        repository,
      },
      owner,
      link
    );
    if (!person) {
      return undefined;
    }
    attribution = `from ${person.login} (${person.role})`;
  }
  const repository = typeof item.full_name === "string" && "owner" in item;
  const owner = object(item.owner);
  const keepDescription =
    String(owner.login).toLowerCase() === filter.org.toLowerCase() ||
    (item.fork === true && filter.identity(restActor(owner)) !== undefined);
  const output: ObjectData = {};
  for (const [key, child] of Object.entries(item)) {
    if (key.startsWith("__vm_")) {
      continue;
    }
    // Foreign repositories remain useful structural metadata; only their free text is withheld.
    if (repository && key === "description" && typeof child === "string" && !keepDescription) {
      filter.accept({}, "", link);
      counts.redacted++;
      continue;
    }
    const filtered = filterDiagnosticValue(
      child,
      filter,
      repo,
      link,
      counts,
      (key === "head" || key === "base") && "number" in item && hasIdentity
    );
    if (filtered !== undefined) {
      output[key] = filtered;
    } else {
      counts.redacted++;
    }
  }
  if (attribution) {
    output.attribution = attribution;
  }
  return output;
}

function gitCommit(item: ObjectData): boolean {
  return (
    typeof item.message === "string" &&
    typeof object(item.tree).sha === "string" &&
    [item.author, item.committer].every((value) => {
      const signature = object(value);
      return (
        ["name", "email", "date"].every((key) => typeof signature[key] === "string") &&
        !["id", "login", "type", "databaseId", "__typename"].some((key) => key in signature)
      );
    })
  );
}

export function renderItem(
  item: ObjectData,
  filter: PeopleFilter,
  link: string
): string | undefined {
  const person = filter.accept(item, repoOf(item).owner, link);
  return person
    ? labelled(
        person,
        [item.title, item.body].filter((part) => typeof part === "string").join("\n\n")
      )
    : undefined;
}
