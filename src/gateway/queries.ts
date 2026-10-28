import {
  Kind,
  parse,
  print,
  visit,
  type ASTNode,
  type DocumentNode,
  type SelectionNode,
  type SelectionSetNode,
} from "graphql";
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
// Only known fields establish content types; selecting text never establishes a type.
const contentFieldTypes: Record<string, readonly string[]> = {
  issue: ["Issue"],
  issues: ["Issue"],
  pullRequest: ["PullRequest"],
  pullRequests: ["PullRequest"],
  issueOrPullRequest: ["Issue", "PullRequest"],
  comments: ["IssueComment"],
  issueComments: ["IssueComment"],
  reviews: ["PullRequestReview"],
  pullRequestReviews: ["PullRequestReview"],
  reviewComments: ["PullRequestReviewComment"],
  pullRequestReviewComments: ["PullRequestReviewComment"],
  search: ["Issue", "PullRequest"],
  content: ["Issue", "PullRequest"],
  node: [...contentTypes],
  nodes: [...contentTypes],
  timelineItems: ["IssueComment", "PullRequestReview"],
};
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

/** Parse one read operation and add identity only in schema-compatible content fragments. */
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
    SelectionSet: {
      leave(node, _key, parent, _path, ancestors) {
        if (!parent || !("kind" in parent)) {
          return;
        }
        let extra: readonly SelectionNode[];
        const container = [...ancestors]
          .reverse()
          .find(
            (ancestor) =>
              !Array.isArray(ancestor) &&
              "kind" in ancestor &&
              ancestor.kind === Kind.FIELD &&
              ancestor.name.value === "checkRuns"
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
        } else {
          const types = contentSelectionTypes(parent, ancestors);
          extra = types.map((name) => ({
            kind: Kind.INLINE_FRAGMENT,
            typeCondition: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: name } },
            selectionSet: { kind: Kind.SELECTION_SET, selections: selections(injection) },
          }));
        }
        if (extra.length) {
          return { ...node, selections: [...node.selections, ...extra] };
        }
      },
    },
  });
  return print(enriched);
}

function contentSelectionTypes(
  parent: ASTNode,
  ancestors: readonly (ASTNode | readonly ASTNode[])[]
): readonly string[] {
  if (parent.kind === Kind.INLINE_FRAGMENT || parent.kind === Kind.FRAGMENT_DEFINITION) {
    const type = parent.typeCondition?.name.value;
    return type && contentTypes.has(type) ? [type] : [];
  }
  if (parent.kind !== Kind.FIELD) {
    return [];
  }
  const context = ancestors.filter((ancestor): ancestor is ASTNode => !Array.isArray(ancestor));
  const fields = context.filter((ancestor) => ancestor.kind === Kind.FIELD);
  const name = parent.name.value;
  let field = name;
  if (["nodes", "node"].includes(name)) {
    if (
      !fields.length &&
      parent.arguments?.some((argument) => ["id", "ids"].includes(argument.name.value))
    ) {
      return contentFieldTypes[name];
    }
    const holder = fields.at(-1)?.name.value;
    field = holder === "edges" ? (fields.at(-2)?.name.value ?? "") : (holder ?? "");
  } else if (!["issue", "pullRequest", "issueOrPullRequest", "content"].includes(name)) {
    return [];
  }
  const scope = context.flatMap((ancestor) => {
    if (ancestor.kind === Kind.FIELD) {
      return [ancestor.name.value];
    }
    if (ancestor.kind === Kind.INLINE_FRAGMENT || ancestor.kind === Kind.FRAGMENT_DEFINITION) {
      return [ancestor.typeCondition?.name.value ?? ""];
    }
    return [];
  });
  if (
    field === "content" &&
    !scope.some((value) => ["ProjectV2Item", "projectV2", "projectsV2"].includes(value))
  ) {
    return [];
  }
  const holder = scope
    .toReversed()
    .find((value) =>
      [
        "issue",
        "issues",
        "Issue",
        "pullRequest",
        "pullRequests",
        "PullRequest",
        "reviews",
        "pullRequestReviews",
        "PullRequestReview",
        "reviewThreads",
        "PullRequestReviewThread",
      ].includes(value)
    );
  if (field === "comments") {
    if (!holder) {
      return [];
    }
    if (
      [
        "reviewThreads",
        "reviews",
        "pullRequestReviews",
        "PullRequestReview",
        "PullRequestReviewThread",
      ].includes(holder)
    ) {
      return contentFieldTypes.reviewComments;
    }
  }
  if (field === "timelineItems") {
    if (!holder) {
      return [];
    }
    if (["issue", "issues", "Issue"].includes(holder)) {
      return contentFieldTypes.comments;
    }
  }
  return Object.hasOwn(contentFieldTypes, field) ? contentFieldTypes[field] : [];
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

/**
 * Filter diagnostic identities, counting whole root-list drops, nested removals and
 * unattributable text fields separately. Pass the enriched query for path-scoped
 * GraphQL text aliases; omit it for REST responses.
 */
export function filterDiagnostic(
  value: unknown,
  filter: PeopleFilter,
  repo: string,
  link: string,
  counts: { dropped: number; redacted: number; textRedacted?: number } = {
    dropped: 0,
    redacted: 0,
  },
  query?: string
): unknown {
  const textAliases = diagnosticTextAliases(query);
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      const result = filterDiagnosticValue(child, filter, repo, link, counts, textAliases);
      if (result === undefined) {
        counts.dropped++;
        return [];
      }
      return [result];
    });
  }
  return filterDiagnosticValue(value, filter, repo, link, counts, textAliases);
}

function diagnosticTextAliases(query?: string): ReadonlyMap<string, ReadonlySet<string>> {
  const aliases = new Map<string, Set<string>>();
  if (!query) {
    return aliases;
  }
  const document = parse(query);
  const fragments = new Map(
    document.definitions.flatMap((definition) =>
      definition.kind === Kind.FRAGMENT_DEFINITION
        ? [[definition.name.value, definition] as const]
        : []
    )
  );
  const visited = new Set<string>();
  function collect(selectionSet: SelectionSetNode, path: string, active: ReadonlySet<string>) {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        const key = selection.alias?.value ?? selection.name.value;
        if (selection.alias && isFreeText(selection.name.value)) {
          const fields = aliases.get(path) ?? new Set<string>();
          fields.add(key);
          aliases.set(path, fields);
        }
        if (selection.selectionSet) {
          collect(selection.selectionSet, `${path}.${key}`, active);
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        collect(selection.selectionSet, path, active);
      } else {
        const name = selection.name.value;
        if (active.has(name)) {
          throw new Error("Cyclic diagnostic query fragment");
        }
        const fragment = fragments.get(name);
        if (!fragment) {
          throw new Error(`Unknown diagnostic query fragment: ${name}`);
        }
        const key = `${path}:${name}`;
        if (!visited.has(key)) {
          visited.add(key);
          collect(fragment.selectionSet, path, new Set([...active, name]));
        }
      }
    }
  }
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      collect(definition.selectionSet, "", new Set());
    }
  }
  return aliases;
}

function filterDiagnosticValue(
  value: unknown,
  filter: PeopleFilter,
  repo: string,
  link: string,
  counts: { dropped: number; redacted: number; textRedacted?: number },
  textAliases: ReadonlyMap<string, ReadonlySet<string>>,
  branchMetadata = false,
  path = ""
): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      const result = filterDiagnosticValue(
        child,
        filter,
        repo,
        link,
        counts,
        textAliases,
        false,
        path
      );
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
  const aliases = textAliases.get(path);
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
  const hasIdentity = ["__vm_author", "author", "user"].some(
    (key) => key in item && !aliases?.has(key)
  );
  const hasContent = Object.keys(item).some((key) => isFreeText(key) || aliases?.has(key));
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
    !("user" in item) &&
    !hasContent &&
    (gitCommit(item) || (item.author === null && gitCommit(object(item.commit))));
  if (signatureOnly) {
    attribution = "git signature (unverified)";
  } else if (hasIdentity && !structuralBranch) {
    const injected = "__vm_author" in item;
    const author = injected
      ? item.__vm_author
      : "user" in item
        ? restActor(item.user)
        : "id" in object(item.author) || "type" in object(item.author)
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
  const output: ObjectData = {};
  for (const [key, child] of Object.entries(item)) {
    if (key.startsWith("__vm_")) {
      continue;
    }
    if (!hasIdentity && (isFreeText(key) || aliases?.has(key))) {
      counts.textRedacted = (counts.textRedacted ?? 0) + 1;
      continue;
    }
    const filtered = filterDiagnosticValue(
      child,
      filter,
      repo,
      link,
      counts,
      textAliases,
      (key === "head" || key === "base") && "number" in item && hasIdentity,
      `${path}.${key}`
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

function isFreeText(key: string): boolean {
  return (
    key.startsWith("body") || ["title", "shortDescription", "readme", "description"].includes(key)
  );
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
