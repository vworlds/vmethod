import { parseDocument } from "yaml";
import { assertEstimate } from "../board/estimate.js";
import type { Config } from "../config.js";
import { compatibility, readState } from "../board/readme.js";
import { MigrationRunner } from "../board/runner.js";
import { loadMigrations } from "../board/migrations.js";
import { progressStates, parseProgress, expectedTurn } from "../core/progress.js";
import type {
  BoardIO,
  Card,
  Field,
  FieldShape,
  Migration,
  Option,
  Snapshot,
} from "../board/types.js";
import { GitHubClient, GitHubHttpError, type Dependencies } from "./client.js";
import { object, type ObjectData, type PeopleFilter } from "./people.js";
import { ownerForTurn, sameAssignees, setTurn, turnAssignees } from "./turn.js";
import { ScopeReader } from "../evidence/scope.js";
import { migrationIdentity, migrationHolderDead } from "./process-identity.js";
import packageInfo from "../../package.json" with { type: "json" };
import { batchPages, pages, pageCursor } from "../github/pages.js";
import {
  fieldSelection,
  pageInfo,
  contentSelection,
  valueSelection,
  initialValues,
} from "../github/selections.js";

function nodes(value: unknown): ObjectData[] {
  const connection = object(value);
  if (!Array.isArray(connection.nodes)) {
    throw new Error("Missing board connection");
  }
  return connection.nodes.map(object);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Missing board identifier");
  }
  return value;
}
function fieldType(value: unknown): Field["type"] {
  return value === "TEXT"
    ? "text"
    : value === "NUMBER"
      ? "number"
      : value === "SINGLE_SELECT"
        ? "single_select"
        : "other";
}
function created(value: unknown): number {
  // The lock's own age decides orphan status, so a missing creation time
  // must fail closed rather than guess.
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) {
    throw new Error("Missing or invalid board field creation time");
  }
  return timestamp;
}

function nextCursor(connection: ObjectData, seen: Set<string>): string | null {
  return pageCursor(connection, seen, { cursorError: "Invalid board pagination cursor" });
}

/** Explicitly scoped to one verb's card choreography; never retained on the service. */
export interface BoardOperation {
  membership?: { snapshot: Snapshot; node?: ObjectData; itemId: string };
  card?: Card;
}

export class BoardService implements BoardIO {
  private readonly settings: NonNullable<Config["board"]>;
  private readonly runner: MigrationRunner;
  constructor(
    private config: Config,
    private github: GitHubClient,
    private deps: Dependencies,
    migrations: Migration[] = loadMigrations(),
    private boardVersion = packageInfo.boardVersion,
    private filter?: PeopleFilter
  ) {
    this.settings = config.board ?? {};
    if (this.settings.enabled === false) {
      throw new Error("Board is disabled");
    }
    this.runner = new MigrationRunner(this, migrations, boardVersion, packageInfo.version);
  }
  now = (): number => this.deps.now();
  lockIdentity = migrationIdentity;
  lockDead = migrationHolderDead;
  report = (message: string): void => this.deps.report(message);
  budgetStopped = (): boolean => this.github.budgetStopped();
  cleanup = <T>(action: () => Promise<T>): Promise<T> => this.github.usingReserve(action);
  status = () => this.runner.status();
  /** Orchestrator-only, journaled and resumable initialization of an empty v0 board. */
  init = (input: { steal?: boolean } = {}) => this.runner.init(input);
  fixStatus = () => this.runner.fixStatus();
  migrate = (input: { dryRun?: boolean; steal?: boolean }) => this.runner.migrate(input);

  async workflowEvidence(cards: Card[]) {
    if (!this.filter) {
      throw new Error("Workflow migration requires the authenticated people filter");
    }
    const scopes = await new ScopeReader(this.github, this.filter, this.config).read(
      cards
        .filter(
          (card) =>
            card.kind === "Issue" && ["Approved", "In review"].includes(String(card.values.Status))
        )
        .map((card) => text(card.contentId))
    );
    return new Map(
      cards.map((card) => [
        card.id,
        {
          approved: scopes.get(String(card.contentId))?.approved === true,
          reviewPending: scopes.get(String(card.contentId))?.reviewPending === true,
          ownerTurn: card.assignees.some((login) =>
            this.filter!.people.some(
              (person) =>
                person.role === "owner" && person.login.toLowerCase() === login.toLowerCase()
            )
          ),
        },
      ])
    );
  }

  async login(): Promise<string> {
    return text(
      object(object(await this.github.graphql("query BoardViewer { viewer { login } }")).viewer)
        .login
    );
  }

  private async pages(read: (cursor: string | null) => Promise<ObjectData>): Promise<ObjectData[]> {
    const output: ObjectData[] = [];
    for await (const connection of pages(read, {
      connectionError: "Missing board connection",
      cursorError: "Invalid board pagination cursor",
    })) {
      output.push(...nodes(connection));
    }
    return output;
  }

  async snapshot(): Promise<Snapshot> {
    const data = object(
      await this.github.graphql(
        `query BoardProject($owner: String!, $number: Int!) { organization(login: $owner) { projectV2(number: $number) { id readme } } }`,
        { owner: this.settings.owner, number: this.settings.number }
      )
    );
    const project = object(object(data.organization).projectV2);
    const id = text(project.id);
    if (project.readme !== null && typeof project.readme !== "string") {
      throw new Error("Missing board README");
    }
    const fields = await this.pages(async (cursor) => {
      const result = object(
        await this.github.graphql(
          `query BoardFields($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { fields(first: 100, after: $cursor) { nodes { ${fieldSelection} } ${pageInfo} } } } }`,
          { id, cursor }
        )
      );
      return object(object(result.node).fields);
    });
    return {
      id,
      readme: project.readme ?? "",
      fields: fields.map((field) => ({
        id: text(field.id),
        name: text(field.name),
        createdAt: created(field.createdAt),
        type: fieldType(field.dataType),
        options: Array.isArray(field.options)
          ? field.options.map((value) => {
              const option = object(value);
              return {
                id: text(option.id),
                name: text(option.name),
                color: text(option.color),
                description: typeof option.description === "string" ? option.description : "",
              };
            })
          : [],
      })),
    };
  }

  async readme(projectId: string, readme: string): Promise<void> {
    await this.github.graphql(
      "mutation BoardReadme($input: UpdateProjectV2Input!) { updateProjectV2(input: $input) { projectV2 { id } } }",
      { input: { projectId, readme } }
    );
  }
  async createField(projectId: string, name: string, shape: FieldShape): Promise<string> {
    const result = object(
      await this.github.graphql(
        "mutation BoardCreateField($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2Field { id } ... on ProjectV2SingleSelectField { id } } } }",
        {
          input: {
            projectId,
            name,
            dataType: shape.type.toUpperCase(),
            ...(shape.options
              ? {
                  singleSelectOptions: shape.options.map((option) =>
                    typeof option === "string"
                      ? {
                          name: option,
                          color: "GRAY",
                          description: "",
                        }
                      : option
                  ),
                }
              : {}),
          },
        },
        false
      )
    );
    return text(object(object(result.createProjectV2Field).projectV2Field).id);
  }
  async deleteField(fieldId: string): Promise<void> {
    await this.github.graphql(
      "mutation BoardDeleteField($input: DeleteProjectV2FieldInput!) { deleteProjectV2Field(input: $input) { clientMutationId } }",
      { input: { fieldId } },
      false
    );
  }
  async options(
    field: Field,
    options: Omit<Option, "id">[],
    renames: Record<string, string> = {}
  ): Promise<void> {
    const singleSelectOptions = options.map((option) => {
      const existing = field.options.find(
        ({ name }) => (Object.hasOwn(renames, name) ? renames[name] : name) === option.name
      );
      return { ...option, ...(existing ? { id: existing.id } : {}) };
    });
    await this.github.graphql(
      "mutation BoardOptions($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }",
      { input: { fieldId: field.id, singleSelectOptions } }
    );
  }

  async cards(projectId: string): Promise<Card[]> {
    // Everyday operations need only the cheap active-project listing.
    const values = await this.pages(async (cursor) => {
      const result = object(
        await this.github.graphql(
          `query BoardCards($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $cursor) { nodes { id isArchived ${contentSelection} ${initialValues} } ${pageInfo} } } } }`,
          { id: projectId, cursor }
        )
      );
      return object(object(result.node).items);
    });
    await this.completeConnections(values, "fieldValues");
    const cards: Card[] = [];
    for (const card of values) {
      cards.push(await this.decodeCard(card));
    }
    return cards;
  }

  /** Migration-only full enumeration: archived issue/PR memberships cost a repository-history scan. */
  async allCards(projectId: string): Promise<Card[]> {
    const merged = new Map((await this.cards(projectId)).map((card) => [card.id, card]));
    const memberships = new Map<string, ObjectData>();
    for (const repo of this.repositories()) {
      const [owner, name] = repo.split("/");
      for (const kind of ["issues", "pullRequests"] as const) {
        const content = await this.pages(async (cursor) => {
          const result = object(
            await this.github.graphql(
              `query BoardRepositoryCards($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { ${kind}(first: 25, after: $cursor) { nodes { id projectItems(first: 25, includeArchived: true) { nodes { id isArchived project { id } ${contentSelection} ${initialValues} } ${pageInfo} } } ${pageInfo} } } }`,
              { owner, name, cursor }
            )
          );
          const entries = object(object(result.repository)[kind]);
          await this.completeConnections(nodes(entries), "projectItems");
          return entries;
        });
        for (const entry of content) {
          for (const card of nodes(entry.projectItems)) {
            if (object(card.project).id === projectId) {
              memberships.set(text(card.id), card);
            }
          }
        }
      }
    }
    const items = [...memberships.values()];
    await this.completeConnections(items, "fieldValues");
    for (const card of items) {
      merged.set(text(card.id), await this.decodeCard(card));
    }
    return [...merged.values()];
  }

  /** Page nested connections in bounded GraphQL batches, never per-item requests. */
  private async completeConnections(
    entries: ObjectData[],
    field: "projectItems" | "fieldValues"
  ): Promise<void> {
    const pending = entries.map((entry) => {
      const connection = object(entry[field]);
      const seen = new Set<string>();
      return { entry, values: nodes(connection), seen, cursor: nextCursor(connection, seen) };
    });
    await batchPages(
      pending,
      async (batch) => {
        const declarations: string[] = [];
        const selections: string[] = [];
        const variables: ObjectData = {};
        batch.forEach(({ entry, cursor }, index) => {
          declarations.push(`$id${index}: ID!`, `$cursor${index}: String!`);
          variables[`id${index}`] = text(entry.id);
          variables[`cursor${index}`] = cursor;
          const connection =
            field === "projectItems"
              ? `projectItems(first: 25, after: $cursor${index}, includeArchived: true) { nodes { id isArchived project { id } ${contentSelection} ${initialValues} } ${pageInfo} }`
              : `fieldValues(first: 100, after: $cursor${index}) { nodes { ${valueSelection} } ${pageInfo} }`;
          const fragments =
            field === "projectItems"
              ? `... on Issue { ${connection} } ... on PullRequest { ${connection} }`
              : `... on ProjectV2Item { ${connection} }`;
          selections.push(`n${index}: node(id: $id${index}) { ${fragments} }`);
        });
        const data = object(
          await this.github.graphql(
            `query BoardCardConnections(${declarations.join(", ")}) { ${selections.join(" ")} }`,
            variables
          )
        );
        batch.forEach((entry, index) => {
          const connection = object(object(data[`n${index}`])[field]);
          entry.values.push(...nodes(connection));
          entry.cursor = nextCursor(connection, entry.seen);
        });
      },
      { size: 25, strategy: "drain", initial: "pending" }
    );
    for (const { entry, values } of pending) {
      entry[field] = { nodes: values, pageInfo: { hasNextPage: false, endCursor: null } };
    }
  }

  private repositories(): string[] {
    if (!Array.isArray(this.settings.repos)) {
      throw new Error("Missing board repositories");
    }
    return [
      ...new Set(
        this.settings.repos.map((repo: unknown) => {
          if (
            typeof repo !== "string" ||
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
            repo.split("/")[0].toLowerCase() !== this.config.org.toLowerCase()
          ) {
            throw new Error("Invalid board repository scope");
          }
          return repo;
        })
      ),
    ];
  }

  private async decodeCard(card: ObjectData): Promise<Card> {
    let first = true;
    const fieldValues = await this.pages(async (cursor) => {
      if (first) {
        first = false;
        return object(card.fieldValues);
      }
      const result = object(
        await this.github.graphql(
          `query BoardValues($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2Item { fieldValues(first: 100, after: $cursor) { nodes { ${valueSelection} } ${pageInfo} } } } }`,
          { id: card.id, cursor }
        )
      );
      return object(object(result.node).fieldValues);
    });
    const content = object(card.content);
    const repo = object(content.repository).nameWithOwner;
    const result: Card = {
      id: text(card.id),
      archived: card.isArchived === true,
      repo: typeof repo === "string" ? repo : null,
      kind: String(content.__typename),
      assignees: content.assignees
        ? nodes(content.assignees).map((value) => text(value.login))
        : [],
      values: {},
      ...(typeof content.id === "string" ? { contentId: content.id } : {}),
      ...(typeof content.number === "number" ? { number: content.number } : {}),
      ...(typeof content.closedAt === "string" ? { closedAt: content.closedAt } : {}),
    };
    for (const value of fieldValues) {
      const name = object(value.field).name;
      if (typeof name === "string") {
        result.values[name] = (value.text ?? value.number ?? value.name ?? null) as
          string | number | null;
      }
    }
    return result;
  }

  async setCards(
    projectId: string,
    field: Field,
    cards: { id: string; value: string | number | null }[]
  ): Promise<void> {
    await this.setChanges(
      projectId,
      cards.map((card) => ({ ...card, field }))
    );
  }

  async setArchived(projectId: string, itemId: string, archived: boolean): Promise<void> {
    await this.github.graphql(
      archived
        ? "mutation BoardArchive($input: ArchiveProjectV2ItemInput!) { archiveProjectV2Item(input: $input) { item { id } } }"
        : "mutation BoardUnarchive($input: UnarchiveProjectV2ItemInput!) { unarchiveProjectV2Item(input: $input) { item { id } } }",
      { input: { projectId, itemId } }
    );
  }

  private async setChanges(
    projectId: string,
    cards: { id: string; field: Field; value: string | number | null }[]
  ): Promise<void> {
    const variables: ObjectData = {};
    const declarations: string[] = [];
    const mutations: string[] = [];
    for (const [index, card] of cards.entries()) {
      const field = card.field;
      const clear = card.value === null;
      const name = `m${index}`;
      const input: ObjectData = {
        projectId,
        itemId: card.id,
        fieldId: field.id,
      };
      if (!clear) {
        if (field.type === "text" && typeof card.value === "string") {
          input.value = { text: card.value };
        } else if (
          field.type === "number" &&
          typeof card.value === "number" &&
          Number.isFinite(card.value)
        ) {
          input.value = { number: card.value };
        } else if (field.type === "single_select" && typeof card.value === "string") {
          const option = field.options.find((option) => option.name === card.value);
          if (!option) {
            throw new Error(`Unknown ${field.name} option`);
          }
          input.value = { singleSelectOptionId: option.id };
        } else {
          throw new Error(`Invalid value for ${field.name}`);
        }
      }
      variables[name] = input;
      declarations.push(
        `$${name}: ${clear ? "ClearProjectV2ItemFieldValueInput" : "UpdateProjectV2ItemFieldValueInput"}!`
      );
      mutations.push(
        `${name}: ${clear ? "clearProjectV2ItemFieldValue" : "updateProjectV2ItemFieldValue"}(input: $${name}) { projectV2Item { id } }`
      );
    }
    if (mutations.length) {
      await this.github.graphql(
        `mutation BoardSetCards(${declarations.join(", ")}) { ${mutations.join(" ")} }`,
        variables
      );
    }
  }

  async item(itemId: string): Promise<Card> {
    const snapshot = await this.snapshot();
    const data = object(
      await this.github.graphql(
        `query BoardItem($id: ID!) { node(id: $id) { ... on ProjectV2Item { id isArchived project { id } ${contentSelection} ${initialValues} } } }`,
        { id: itemId }
      )
    );
    return this.projectCard(object(data.node), snapshot.id);
  }
  /** One card shape for the writer: the configured-board check, then only the five
   * operation fields with null defaults (no arbitrary custom field text). */
  private async projectCard(node: ObjectData, projectId: string): Promise<Card> {
    if (object(node.project).id !== projectId) {
      throw new Error("Card is not on configured board");
    }
    const card = await this.decodeCard(node);
    // Do not return arbitrary custom field text through the operation seam.
    return {
      ...card,
      values: Object.fromEntries(
        ["Status", "Estimate", "Model", "Progress", "Cost"].map((name) => [
          name,
          card.values[name] ?? null,
        ])
      ),
    };
  }
  private scope(card: Card): void {
    if (card.repo?.toLowerCase() !== this.config.repo.toLowerCase()) {
      throw new Error("Refusing write to a foreign repository card");
    }
  }
  /** Return an issue/PR's configured-project membership from the content side, adding
   * it if absent. An optional operation shares that resolution with subsequent `set`s. */
  async ensure(contentId: string, operation?: BoardOperation): Promise<string> {
    const membership = await this.ensureCard(contentId);
    if (operation) {
      operation.membership = membership;
      operation.card = undefined;
    }
    return membership.itemId;
  }
  /** Resolve membership once per operation, validating content before adding it.
   * Pass the result to `setIssueFields` to reuse its snapshot and existing issue-side
   * membership. After an add the writer still reads the new card's actual values:
   * workflow defaults must not be replaced with a synthetic empty card. */
  async ensureCard(contentId: string): Promise<{
    snapshot: Snapshot;
    node?: ObjectData;
    itemId: string;
  }> {
    const snapshot = await this.snapshot();
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    // Validate repository and kind before an add mutation, just as ordinary writes do.
    const data = object(
      await this.github.graphql(
        "query BoardContent($id: ID!) { node(id: $id) { __typename ... on Issue { repository { nameWithOwner } } ... on PullRequest { repository { nameWithOwner } } } }",
        { id: contentId }
      )
    );
    const content = object(data.node);
    if (
      !["Issue", "PullRequest"].includes(String(content.__typename)) ||
      object(content.repository).nameWithOwner !== this.config.repo
    ) {
      throw new Error("Refusing foreign or draft board content");
    }
    const existing = await this.issueSideItem(contentId, snapshot.id);
    if (existing) {
      return { snapshot, node: existing, itemId: text(existing.id) };
    }
    const result = object(
      await this.github.graphql(
        "mutation BoardAdd($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }",
        { input: { projectId: snapshot.id, contentId } }
      )
    );
    return {
      snapshot,
      itemId: text(object(object(result.addProjectV2ItemById).item).id),
    };
  }

  /** The configured-board issue card for a content ID, or null when the issue has no
   * live membership in the configured project (#287 board add idempotence probe);
   * membership is read from the issue side, never the eventually consistent listing. */
  async issueCard(contentId: string): Promise<Card | null> {
    const snapshot = await this.snapshot();
    const node = await this.issueSideItem(contentId, snapshot.id);
    if (!node) {
      return null;
    }
    const card = await this.decodeCard(node);
    if (card.kind !== "Issue" || card.contentId !== contentId) {
      return null;
    }
    return card;
  }

  private async issueSideItem(
    contentId: string,
    projectId: string
  ): Promise<ObjectData | undefined> {
    const data = object(
      await this.github.graphql(
        `query BoardContentItems($id: ID!) { node(id: $id) { ... on Issue { projectItems(first: 100) { nodes { id isArchived project { id } ${contentSelection} ${initialValues} } pageInfo { hasNextPage } } } ... on PullRequest { projectItems(first: 100) { nodes { id isArchived project { id } ${contentSelection} ${initialValues} } pageInfo { hasNextPage } } } } }`,
        { id: contentId }
      )
    );
    const connection = object(object(data.node).projectItems);
    if (object(connection.pageInfo).hasNextPage === true) {
      throw new Error("Too many project memberships; refusing incomplete metadata");
    }
    const memberships = nodes(connection);
    const match = memberships.find((item) => object(item.project).id === projectId);
    return match;
  }

  async capDone(): Promise<void> {
    const snapshot = await this.snapshot();
    const cards = (await this.cards(snapshot.id))
      .filter(
        (card) =>
          !card.archived &&
          card.values.Status === "Done" &&
          card.closedAt &&
          Number.isFinite(Date.parse(card.closedAt))
      )
      .sort(
        (a, b) => String(b.closedAt).localeCompare(String(a.closedAt)) || a.id.localeCompare(b.id)
      );
    for (const card of cards.slice(6)) {
      if (card.repo?.toLowerCase() === this.config.repo.toLowerCase()) {
        await this.archive(card.id);
      }
    }
  }
  /** Write a scoped card field; Estimate is issue-only, Cost is per PR. The ordered
   * commit goes through `setFields`, the single board writer (B1: a Status write
   * carries its Progress companion in the same mutation, Progress first). Reuse an
   * explicit `BoardOperation` from `ensure` only within the same verb; successful
   * writes update its card values for subsequent writes, without merging batches. */
  async set(
    input: {
      itemId: string;
      field: "Status" | "Estimate" | "Model" | "Progress" | "Cost";
      value: string | number | null;
      progress?: string | null;
    },
    operation?: BoardOperation
  ): Promise<string> {
    if (!["Status", "Estimate", "Model", "Progress", "Cost"].includes(input.field)) {
      throw new Error("Unsupported board field");
    }
    if (input.field === "Estimate" && input.value !== null) {
      assertEstimate(input.value);
    }
    const membership =
      operation?.membership?.itemId === input.itemId ? operation.membership : undefined;
    const card = membership
      ? (operation?.card ??
        (membership.node
          ? await this.projectCard(membership.node, membership.snapshot.id)
          : await this.item(input.itemId)))
      : await this.item(input.itemId);
    this.scope(card);
    if (input.field === "Estimate" && card.kind === "PullRequest") {
      throw new Error(`Never set ${input.field} on a PR`);
    }
    if (input.field === "Cost" && card.kind === "Issue") {
      throw new Error("Never set Cost on an issue");
    }
    if (input.field === "Status" && input.progress === undefined) {
      throw new Error("Status writes require Progress");
    }
    const snapshot = membership?.snapshot ?? (await this.snapshot());
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    const field = snapshot.fields.find((field) => field.name === input.field);
    if (!field) {
      throw new Error("Missing board field");
    }
    await this.setFields(
      card,
      snapshot,
      [
        {
          field,
          value: input.value,
          ...(input.field === "Status" ? { progress: input.progress } : {}),
        },
      ],
      input.field === "Status"
        ? [
            { field: "Progress", value: input.progress! },
            { field: "Status", value: input.value },
          ]
        : [{ field: input.field, value: input.value }]
    );
    if (membership && operation) {
      operation.card = {
        ...card,
        values: {
          ...card.values,
          ...(input.field === "Status" ? { Progress: input.progress! } : {}),
          [input.field]: input.value,
        },
      };
    }
    return "Board field updated";
  }
  /** #267: grade writes through an archived card without touching it while archived.
   * Unarchive, reuse the active-card set() guards and write unchanged, re-archive
   * before returning (also on a failed write so the card never stays unarchived),
   * then verify both the value and the archive state; the verified unarchive, set
   * and archive sequence from the #258 archived moves. */
  async setArchivedCard(input: {
    itemId: string;
    field: "Status" | "Estimate" | "Model" | "Progress" | "Cost";
    value: string | number | null;
    progress?: string | null;
  }): Promise<string> {
    const card = await this.item(input.itemId);
    if (!card.archived) {
      throw new Error(`Card ${input.itemId} is not archived`);
    }
    this.scope(card);
    // The compatibility gate precedes every unarchive, as archive() and set() do.
    const snapshot = await this.snapshot();
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    await this.setArchived(snapshot.id, input.itemId, false);
    let result: string;
    try {
      result = await this.set(input);
    } finally {
      await this.setArchived(snapshot.id, input.itemId, true);
    }
    const verified = await this.item(input.itemId);
    if (!verified.archived || (verified.values[input.field] ?? null) !== input.value) {
      throw new Error(`Archived write verification failed for ${input.field} on ${input.itemId}`);
    }
    return result;
  }
  /** Set a single-select/number field or validated Progress by issue content ID.
   * A null value clears only Progress or Estimate through the native field-clear mutation.
   * Estimates must use the shared points scale. Cost is refused. Status writes clear Progress;
   * Membership is read from the issue side, never the eventually consistent project listing.
   * GitHubClient journals the successful mutations.
   */
  async setIssueField(
    contentId: string,
    name: string,
    value: string | null,
    progressValue?: string
  ): Promise<string> {
    return this.setIssueFields(contentId, [
      { name, value, ...(progressValue !== undefined ? { progressValue } : {}) },
    ]);
  }

  /** Write several fields of one issue card through a single ordered board mutation,
   * journaling the verb's board writes as one operation (#199). A Status entry keeps
   * its progress companion: the progress change rides the same mutation before Status
   * (the #178 scope handoff order). Estimates must use the shared points scale; Cost
   * is refused. Membership is read from the issue side, never the project listing —
   * or reused from the operation's `ensureCard` resolution. A newly added card still
   * needs an issue-side read of its actual values before the ordering hooks run.
   */
  async setIssueFields(
    contentId: string,
    entries: { name: string; value: string | null; progressValue?: string }[],
    membership?: { snapshot: Snapshot; node?: ObjectData }
  ): Promise<string> {
    if (entries.some((entry) => entry.name === "Cost")) {
      throw new Error("Never set Cost on an issue");
    }
    for (const entry of entries) {
      if (
        typeof entry.name !== "string" ||
        !entry.name ||
        (entry.value !== null && (typeof entry.value !== "string" || !entry.value.trim()))
      ) {
        throw new Error("Invalid board field/value");
      }
      if (entry.value === null && !["Progress", "Estimate"].includes(entry.name)) {
        throw new Error("Only Progress and Estimate support --clear");
      }
      if (
        entry.progressValue !== undefined &&
        (entry.name !== "Status" || !entry.progressValue.trim())
      ) {
        throw new Error("Progress override is supported only for Status writes");
      }
    }
    const snapshot = membership?.snapshot ?? (await this.snapshot());
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    const resolved = entries.map((entry) => {
      const field = snapshot.fields.find((candidate) => candidate.name === entry.name);
      if (
        !field ||
        (!["number", "single_select"].includes(field.type) &&
          !(entry.name === "Progress" && field.type === "text"))
      ) {
        throw new Error("Expected a single-select or number board field, or Progress");
      }
      for (const text of [
        ...(entry.name === "Progress" && entry.value !== null ? [entry.value] : []),
        ...(entry.progressValue !== undefined ? [entry.progressValue] : []),
      ]) {
        const states = new Set([
          ...Object.values(progressStates),
          ...Object.values(readState(snapshot.readme).aliases),
        ]);
        const words = text.trim().split(/\s+/);
        if (
          !states.has(words[0]) ||
          !/^(?:🔁(?:\d\uFE0F\u20E3)+(?: 🔴)?|🔴)?$/.test(words.slice(1).join(" "))
        ) {
          throw new Error("Invalid Progress value");
        }
      }
      return { field, value: entry.value, progressValue: entry.progressValue };
    });
    const node = membership?.node ?? (await this.issueSideItem(contentId, snapshot.id));
    if (!node) {
      throw new Error("Issue is not on configured board");
    }
    const card = await this.decodeCard(node);
    if (card.kind !== "Issue" || card.contentId !== contentId) {
      throw new Error("Issue is not on configured board");
    }
    this.scope(card);
    const writes: {
      field: Field;
      value: string | number | null;
      progress?: string | null;
    }[] = [];
    for (const entry of resolved) {
      let parsed: string | number | null = entry.value;
      if (entry.field.name === "Estimate" && entry.value !== null) {
        assertEstimate(entry.value.trim() ? Number(entry.value) : NaN);
      }
      if (entry.field.type === "number" && entry.value !== null) {
        if (
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(entry.value) ||
          !Number.isFinite(Number(entry.value))
        ) {
          throw new Error("Expected finite numeric board value");
        }
        parsed = Number(entry.value);
      }
      // Preserve validation precedence for a missing companion before later entries.
      if (
        entry.field.name === "Status" &&
        !snapshot.fields.some((candidate) => candidate.name === "Progress")
      ) {
        throw new Error("Missing Progress field");
      }
      writes.push({
        field: entry.field,
        value: parsed,
        ...(entry.field.name === "Status" ? { progress: entry.progressValue ?? null } : {}),
      });
    }
    // The batch decides order once: the last Status entry wins the column and
    // carries the effective Progress (progress-only entries never queue).
    await this.setFields(
      card,
      snapshot,
      writes,
      resolved.map((entry) =>
        entry.field.name === "Status"
          ? { field: "Status", value: entry.value, progress: entry.progressValue ?? null }
          : { field: String(entry.field.name), value: entry.value }
      )
    );
    return "Board field updated";
  }

  /** Orchestrator-only management-assignee housekeeping (#257): set or clear the single
   * management (turn) assignee on a configured-repository issue or PR card. The result
   * must agree with the card's Status and Progress under the same turn rules the
   * watcher's reconcileTurn enforces (a 👤 Progress holds the owner turn, worker-protocol
   * states hold the orchestrator, working or no Progress holds none, and Spec/Owner
   * review columns hold exactly one turn assignee); a mismatch is refused before any
   * write, naming the expected assignee. Worker assignees are never added or removed,
   * and the REST assignment writes are journaled at the single GitHub boundary, so the
   * session's own watcher attributes them to itself and reports nothing for them.
   * Membership and turn fields are read from the issue side, never the eventually
   * consistent project listing. */
  async setAssignees(number: number, value: "owner" | "orchestrator" | null): Promise<string> {
    if (!this.filter) {
      throw new Error("Assignee housekeeping requires the authenticated people filter");
    }
    const repo = this.config.repo;
    const snapshot = await this.snapshot();
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    const item = object(await this.github.rest(`/repos/${repo}/issues/${number}`));
    if (!Array.isArray(item.assignees)) {
      throw new Error("Missing assignees metadata");
    }
    if (typeof item.node_id !== "string" || !item.node_id) {
      throw new Error("Missing issue node id");
    }
    const node = await this.issueSideItem(item.node_id, snapshot.id);
    if (!node) {
      throw new Error("Item is not on the configured board");
    }
    const card = await this.decodeCard(node);
    this.scope(card);
    if (card.archived) {
      throw new Error("Refusing assignee housekeeping on an archived board item");
    }
    const { people } = this.filter;
    const expected = expectedTurn(
      parseProgress(card.values.Progress).state,
      String(card.values.Status ?? "")
    );
    const owner =
      expected === "owner" ? await ownerForTurn(this.github, people, repo, number) : undefined;
    const describe = (role: "owner" | "orchestrator" | null): string =>
      role
        ? `${role} (${turnAssignees(people, repo, [], role, owner)[0]})`
        : "no management assignee";
    if (value !== expected) {
      throw new Error(
        value === null
          ? `Refusing to clear assignees: ${describe(expected)} holds the turn on #${number}`
          : `Refusing ${value} assignee: expected ${describe(expected)} on #${number}`
      );
    }
    const current = (item.assignees as ObjectData[]).map((person) => text(object(person).login));
    // Only the management turn assignee changes: workers keep their own assignments,
    // so the write adds or removes the management login over the kept non-management set.
    const kept = turnAssignees(people, repo, current, null);
    const next =
      value === null ? kept : [...kept, turnAssignees(people, repo, [], value, owner)[0]];
    this.github.writes.beginOperation("board set assignees", [{ repo, number }]);
    await setTurn(this.github, repo, number, current, next);
    return sameAssignees(current, next)
      ? `Turn assignees already agree on #${number}`
      : value === null
        ? `Cleared the management assignee on #${number}`
        : `Assigned the ${value} turn on #${number}`;
  }
  /** Best-effort ordering on GitHub's single manual order per project
   * (`updateProjectV2ItemPosition`; `afterId: null` is the top, and the item
   * listing returns that order). Executing activity belongs at the top and an
   * Owner review handover at the bottom; every other column keeps the owner's
   * order. A failed position write is reported and never blocks the verb or
   * watcher move that triggered it, and the position mutation is journaled with
   * the write's other board updates at the single GitHub boundary. */
  async moveToTop(itemId: string, projectId?: string): Promise<void> {
    try {
      await this.positionItem(itemId, projectId ?? (await this.guardedProject()).id, null);
    } catch (error) {
      this.report(
        `Board card order update to the top failed for item ${itemId}: ${(error as Error).message}`
      );
    }
  }
  /** Best-effort: move a card after the column's last card left in Owner review
   * (after the top when none left), so handovers read oldest-first. */
  async moveToOwnerReviewBottom(itemId: string, projectId?: string): Promise<void> {
    try {
      const project = projectId ?? (await this.guardedProject()).id;
      const last = (await this.cards(project))
        .filter(
          (card) =>
            card.values.Status === "Owner review" && card.id !== itemId && card.archived !== true
        )
        .at(-1);
      await this.positionItem(itemId, project, last?.id ?? null);
    } catch (error) {
      this.report(
        `Board card order update after Owner review failed for item ${itemId}: ${(error as Error).message}`
      );
    }
  }
  /** The watch-side order helpers write without a carrying field write, so they
   * re-check board compatibility exactly like other board writes do. */
  private async guardedProject(): Promise<Snapshot> {
    const snapshot = await this.snapshot();
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    return snapshot;
  }
  private async positionItem(
    itemId: string,
    projectId: string,
    afterId: string | null
  ): Promise<void> {
    await this.github.graphql(
      "mutation BoardPosition($input: UpdateProjectV2ItemPositionInput!) { updateProjectV2ItemPosition(input: $input) { clientMutationId } }",
      { input: { projectId, itemId, afterId } }
    );
  }
  /** The single ordered write for card fields: every write path (`set`,
   * `setIssueFields`, and with them the watcher's board writes, the archived-card
   * sequence and TaskFlow's card choreography) commits here. Each write names a
   * resolved field; a Status write carries its Progress companion value, and the
   * companion field write rides the same mutation immediately before Status,
   * Progress first (B1, the #178 order). `order` is the same writes in the
   * caller's entry shape for the card-order hooks. The card and snapshot are the
   * operation's cached membership reads, so the write itself re-reads nothing. */
  private async setFields(
    card: Card,
    snapshot: Snapshot,
    writes: { field: Field; value: string | number | null; progress?: string | null }[],
    order: { field: string; value: string | number | null; progress?: string | number | null }[]
  ): Promise<void> {
    const changes: { id: string; field: Field; value: string | number | null }[] = [];
    for (const write of writes) {
      if (write.field.name === "Status") {
        const progress = snapshot.fields.find((field) => field.name === "Progress");
        if (!progress) {
          throw new Error("Missing Progress field");
        }
        changes.push({ id: card.id, field: progress, value: write.progress ?? null });
      }
      changes.push({ id: card.id, field: write.field, value: write.value });
    }
    await this.setChanges(snapshot.id, changes);
    await this.orderAfterEntries(card, order, snapshot.id);
  }
  /** Card order caused by Progress/Status entries: a changed Executing-Progress or a
   * Status entry into Executing moves the card to the top; a Status entry into Owner
   * review queues it after the column's last card. All other target columns are
   * owner-ordered and never moved. */
  private async orderAfterEntries(
    card: Card,
    entries: { field: string; value: string | number | null; progress?: string | number | null }[],
    projectId: string
  ): Promise<void> {
    if (!entries.some((entry) => ["Status", "Progress"].includes(entry.field))) {
      return;
    }
    let status = String(card.values.Status ?? "");
    let progress = card.values.Progress ?? null;
    for (const entry of entries) {
      if (entry.field === "Status") {
        // A Status entry carries its companion (null clears), and decides the column.
        status = String(entry.value ?? "");
        progress = entry.progress ?? null;
      } else if (entry.field === "Progress") {
        progress = entry.value;
      }
    }
    const changed =
      status !== String(card.values.Status ?? "") || progress !== (card.values.Progress ?? null);
    if (!changed) {
      return;
    }
    if (status === "Executing") {
      await this.moveToTop(card.id, projectId);
    } else if (entries.some((entry) => entry.field === "Status") && status === "Owner review") {
      await this.moveToOwnerReviewBottom(card.id, projectId);
    }
  }
  async archive(itemId: string): Promise<string> {
    this.scope(await this.item(itemId));
    const snapshot = await this.snapshot();
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    await this.setArchived(snapshot.id, itemId, true);
    return "Board card archived";
  }

  async announce(body: string): Promise<void> {
    if (!this.settings.announce) {
      return;
    }
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(this.settings.announce);
    if (!match || match[1].split("/")[0].toLowerCase() !== this.config.org.toLowerCase()) {
      throw new Error("Invalid board announcement scope");
    }
    await this.github.rest(`/repos/${match[1]}/issues/${match[2]}/comments`, "POST", { body });
  }
  async workflows(projectId: string): Promise<string[]> {
    const workflows = await this.pages(async (cursor) => {
      const result = object(
        await this.github.graphql(
          `query BoardWorkflows($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { workflows(first: 100, after: $cursor) { nodes { name enabled } ${pageInfo} } } } }`,
          { id: projectId, cursor }
        )
      );
      return object(object(result.node).workflows);
    });
    return workflows
      .filter((workflow) => workflow.enabled === true)
      .map((workflow) => text(workflow.name));
  }

  private async file(repo: string, ref: string, path: string): Promise<string> {
    const result = object(
      await this.github.rest(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)
    );
    if (result.encoding !== "base64" || typeof result.content !== "string") {
      throw new Error("Missing repository file");
    }
    return Buffer.from(result.content, "base64").toString("utf8");
  }
  async adoption(requires: string): Promise<void> {
    for (const repo of this.repositories()) {
      const metadata = object(await this.github.rest(`/repos/${repo}`));
      let adoption: string;
      try {
        adoption = await this.file(repo, text(metadata.default_branch), "vmethod.yaml");
      } catch (error) {
        if (error instanceof GitHubHttpError && error.status === 404) {
          throw new Error(
            `${repo} has not adopted vmethod >= ${requires} on its default branch yet; merge the adoption PR, then rerun board migrate`,
            { cause: error }
          );
        }
        throw error;
      }
      const doc = parseDocument(adoption, { uniqueKeys: true });
      if (doc.errors.length) {
        throw new Error("Invalid adoption configuration");
      }
      const adoptionConfig = object(doc.toJS());
      const base = text(adoptionConfig.baseBranch);
      const prefixes = object(adoptionConfig.branches);
      const branches = new Set([base]);
      // Include all extant track/pack refs, not only branches with a PR. This
      // deliberately fails closed for an unadopted long-lived branch.
      for (const prefix of [prefixes.trackPrefix ?? "track/", prefixes.packPrefix ?? "pack/"]) {
        if (typeof prefix !== "string" || !prefix) {
          throw new Error("Invalid branch prefix");
        }
        for (let page = 1; ; page++) {
          const refs = await this.github.rest(
            `/repos/${repo}/git/matching-refs/heads/${encodeURIComponent(prefix)}?per_page=100&page=${page}`
          );
          if (!Array.isArray(refs)) {
            throw new Error("Missing branch refs");
          }
          for (const ref of refs) {
            branches.add(text(object(ref).ref).replace(/^refs\/heads\//, ""));
          }
          if (refs.length < 100) {
            break;
          }
        }
      }
      for (const branch of branches) {
        const lock = object(JSON.parse(await this.file(repo, branch, "package-lock.json")));
        const packages = object(lock.packages);
        const pin = object(packages["node_modules/@vworlds/vmethod"]).version;
        const root = object(packages[""]);
        if (root.name === "@vworlds/vmethod") {
          // vmethod itself runs from source: the migration ships in this very tree.
          continue;
        }
        const declared =
          object(root.devDependencies)["@vworlds/vmethod"] ??
          object(root.dependencies)["@vworlds/vmethod"];
        if (typeof pin !== "string" || pin !== declared || !atLeast(pin, requires)) {
          throw new Error(`waiting for ${repo} (${branch}) to adopt ≥ v${requires}`);
        }
      }
    }
  }
}

function atLeast(actual: string, required: string): boolean {
  const parse = (value: string) =>
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value
    );
  const a = parse(actual),
    b = parse(required);
  if (!a || !b) {
    throw new Error("Expected exact semantic version");
  }
  for (let index = 1; index <= 3; index++) {
    if (Number(a[index]) !== Number(b[index])) {
      return Number(a[index]) > Number(b[index]);
    }
  }
  if (!a[4] || !b[4]) {
    return !a[4] || Boolean(b[4]);
  }
  const left = a[4].split("."),
    right = b[4].split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) {
      continue;
    }
    if (left[index] === undefined || right[index] === undefined) {
      return right[index] === undefined;
    }
    const an = /^\d+$/.test(left[index]),
      bn = /^\d+$/.test(right[index]);
    return an && bn
      ? Number(left[index]) > Number(right[index])
      : an !== bn
        ? !an
        : left[index] > right[index];
  }
  return true;
}
