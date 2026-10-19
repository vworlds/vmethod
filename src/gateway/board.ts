import { parseDocument } from "yaml";
import { assertEstimate } from "../board/estimate.js";
import type { Config } from "../config.js";
import { compatibility, readState } from "../board/readme.js";
import { MigrationRunner } from "../board/runner.js";
import { loadMigrations } from "../board/migrations.js";
import { progressStates } from "../board/progress.js";
import type {
  BoardIO,
  Card,
  Field,
  FieldShape,
  Migration,
  Option,
  Snapshot,
} from "../board/types.js";
import { GitHubClient, type Dependencies } from "./client.js";
import { object, type ObjectData } from "./people.js";
import packageInfo from "../../package.json" with { type: "json" };

const fieldSelection =
  "... on ProjectV2Field { id name dataType createdAt } ... on ProjectV2IterationField { id name dataType createdAt } ... on ProjectV2SingleSelectField { id name dataType createdAt options { id name color description } }";
const pageInfo = "pageInfo { hasNextPage endCursor }";
const contentSelection =
  "content { __typename ... on Issue { id number closedAt repository { nameWithOwner } assignees(first: 100) { nodes { login } } } ... on PullRequest { id number closedAt repository { nameWithOwner } assignees(first: 100) { nodes { login } } } }";
const valueSelection =
  "... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }";
const initialValues = `fieldValues(first: 100) { nodes { ${valueSelection} } ${pageInfo} }`;
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

export class BoardService implements BoardIO {
  private readonly settings: ObjectData;
  private readonly runner: MigrationRunner;
  constructor(
    private config: Config,
    private github: GitHubClient,
    private deps: Dependencies,
    migrations: Migration[] = loadMigrations(),
    private boardVersion = packageInfo.boardVersion
  ) {
    this.settings = object(config.board);
    if (this.settings.enabled === false) {
      throw new Error("Board is disabled");
    }
    this.runner = new MigrationRunner(this, migrations, boardVersion, packageInfo.version);
  }
  now = (): number => this.deps.now();
  report = (message: string): void => this.deps.report(message);
  budgetStopped = (): boolean => this.github.budgetStopped();
  cleanup = <T>(action: () => Promise<T>): Promise<T> => this.github.usingReserve(action);
  status = () => this.runner.status();
  fixStatus = () => this.runner.fixStatus();
  migrate = (input: { dryRun?: boolean; steal?: boolean }) => this.runner.migrate(input);

  async login(): Promise<string> {
    return text(
      object(object(await this.github.graphql("query BoardViewer { viewer { login } }")).viewer)
        .login
    );
  }

  private async pages(read: (cursor: string | null) => Promise<ObjectData>): Promise<ObjectData[]> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const output: ObjectData[] = [];
    for (;;) {
      const connection = await read(cursor);
      output.push(...nodes(connection));
      const info = object(connection.pageInfo);
      if (info.hasNextPage === false) {
        return output;
      }
      if (
        info.hasNextPage !== true ||
        typeof info.endCursor !== "string" ||
        seen.has(info.endCursor)
      ) {
        throw new Error("Invalid board pagination cursor");
      }
      cursor = info.endCursor;
      seen.add(cursor);
    }
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
                  singleSelectOptions: shape.options.map((name) => ({
                    name,
                    color: "GRAY",
                    description: "",
                  })),
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
  async options(field: Field, options: Omit<Option, "id">[]): Promise<void> {
    await this.github.graphql(
      "mutation BoardOptions($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }",
      { input: { fieldId: field.id, singleSelectOptions: options } }
    );
  }

  async cards(projectId: string): Promise<Card[]> {
    const values = await this.pages(async (cursor) => {
      const result = object(
        await this.github.graphql(
          `query BoardCards($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $cursor) { nodes { id ${contentSelection} ${initialValues} } ${pageInfo} } } } }`,
          { id: projectId, cursor }
        )
      );
      return object(object(result.node).items);
    });
    const cards: Card[] = [];
    for (const card of values) {
      cards.push(await this.decodeCard(card));
    }
    return cards;
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
    const node = object(data.node);
    if (object(node.project).id !== snapshot.id) {
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
    if (card.repo?.toLowerCase() !== String(this.config.repo).toLowerCase()) {
      throw new Error("Refusing write to a foreign repository card");
    }
  }
  /** Return an issue/PR's configured-project membership from the content side, adding it if absent. */
  async ensure(contentId: string): Promise<string> {
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
      return text(existing.id);
    }
    const result = object(
      await this.github.graphql(
        "mutation BoardAdd($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }",
        { input: { projectId: snapshot.id, contentId } }
      )
    );
    return text(object(object(result.addProjectV2ItemById).item).id);
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
          card.values.Status === "Done" &&
          card.closedAt &&
          Number.isFinite(Date.parse(card.closedAt))
      )
      .sort(
        (a, b) => String(b.closedAt).localeCompare(String(a.closedAt)) || a.id.localeCompare(b.id)
      );
    for (const card of cards.slice(6)) {
      if (card.repo?.toLowerCase() === String(this.config.repo).toLowerCase()) {
        await this.archive(card.id);
      }
    }
  }
  /** Write a scoped card field; Estimate is issue-only, Cost is per PR. */
  async set(input: {
    itemId: string;
    field: "Status" | "Estimate" | "Model" | "Progress" | "Cost";
    value: string | number | null;
    progress?: string | null;
  }): Promise<string> {
    if (!["Status", "Estimate", "Model", "Progress", "Cost"].includes(input.field)) {
      throw new Error("Unsupported board field");
    }
    if (input.field === "Estimate" && input.value !== null) {
      assertEstimate(input.value);
    }
    const card = await this.item(input.itemId);
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
    const snapshot = await this.snapshot();
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    const field = snapshot.fields.find((field) => field.name === input.field);
    if (!field) {
      throw new Error("Missing board field");
    }
    const changes = [{ id: card.id, field, value: input.value }];
    if (input.field === "Status") {
      const progress = snapshot.fields.find((field) => field.name === "Progress");
      if (!progress) {
        throw new Error("Missing Progress field");
      }
      changes.unshift({ id: card.id, field: progress, value: input.progress! });
    }
    await this.setChanges(snapshot.id, changes);
    return "Board field updated";
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
    if (name === "Cost") {
      throw new Error("Never set Cost on an issue");
    }
    if (
      typeof name !== "string" ||
      !name ||
      (value !== null && (typeof value !== "string" || !value.trim()))
    ) {
      throw new Error("Invalid board field/value");
    }
    if (value === null && !["Progress", "Estimate"].includes(name)) {
      throw new Error("Only Progress and Estimate support --clear");
    }
    if (progressValue !== undefined && (name !== "Status" || !progressValue.trim())) {
      throw new Error("Progress override is supported only for Status writes");
    }
    const snapshot = await this.snapshot();
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    const field = snapshot.fields.find((field) => field.name === name);
    if (
      !field ||
      (!["number", "single_select"].includes(field.type) &&
        !(name === "Progress" && field.type === "text"))
    ) {
      throw new Error("Expected a single-select or number board field, or Progress");
    }
    if (name === "Progress" && value !== null) {
      const states = new Set([
        ...Object.values(progressStates),
        ...Object.values(readState(snapshot.readme).aliases),
      ]);
      const words = value.trim().split(/\s+/);
      if (
        !states.has(words[0]) ||
        !/^(?:🔁(?:\d\uFE0F\u20E3)+(?: 🔴)?|🔴)?$/.test(words.slice(1).join(" "))
      ) {
        throw new Error("Invalid Progress value");
      }
    }
    if (progressValue !== undefined) {
      const states = new Set([
        ...Object.values(progressStates),
        ...Object.values(readState(snapshot.readme).aliases),
      ]);
      const words = progressValue.trim().split(/\s+/);
      if (
        !states.has(words[0]) ||
        !/^(?:🔁(?:\d\uFE0F\u20E3)+(?: 🔴)?|🔴)?$/.test(words.slice(1).join(" "))
      ) {
        throw new Error("Invalid Progress value");
      }
    }
    const node = await this.issueSideItem(contentId, snapshot.id);
    if (!node) {
      throw new Error("Issue is not on configured board");
    }
    const card = await this.decodeCard(node);
    if (card.kind !== "Issue" || card.contentId !== contentId) {
      throw new Error("Issue is not on configured board");
    }
    this.scope(card);
    let parsed: string | number | null = value;
    if (name === "Estimate" && value !== null) {
      assertEstimate(value.trim() ? Number(value) : NaN);
    }
    if (field.type === "number" && value !== null) {
      if (
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ||
        !Number.isFinite(Number(value))
      ) {
        throw new Error("Expected finite numeric board value");
      }
      parsed = Number(value);
    }
    const changes: { id: string; field: Field; value: string | number | null }[] = [
      { id: card.id, field, value: parsed },
    ];
    if (name === "Status") {
      const progressField = snapshot.fields.find((field) => field.name === "Progress");
      if (!progressField) {
        throw new Error("Missing Progress field");
      }
      changes.unshift({ id: card.id, field: progressField, value: progressValue ?? null });
    }
    await this.setChanges(snapshot.id, changes);
    return "Board field updated";
  }
  async archive(itemId: string): Promise<string> {
    this.scope(await this.item(itemId));
    const snapshot = await this.snapshot();
    compatibility(readState(snapshot.readme), this.boardVersion, this.report);
    await this.github.graphql(
      "mutation BoardArchive($input: ArchiveProjectV2ItemInput!) { archiveProjectV2Item(input: $input) { item { id } } }",
      { input: { projectId: snapshot.id, itemId } }
    );
    return "Board card archived";
  }

  async announce(body: string): Promise<void> {
    if (!this.settings.announce) {
      return;
    }
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(
      String(this.settings.announce)
    );
    if (!match || match[1].split("/")[0].toLowerCase() !== String(this.config.org).toLowerCase()) {
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
    if (!Array.isArray(this.settings.repos)) {
      throw new Error("Missing board repositories");
    }
    for (const repo of this.settings.repos) {
      if (
        typeof repo !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
        repo.split("/")[0].toLowerCase() !== String(this.config.org).toLowerCase()
      ) {
        throw new Error("Invalid board repository scope");
      }
      const metadata = object(await this.github.rest(`/repos/${repo}`));
      const doc = parseDocument(
        await this.file(repo, text(metadata.default_branch), "vmethod.yaml"),
        { uniqueKeys: true }
      );
      if (doc.errors.length) {
        throw new Error("Invalid adoption configuration");
      }
      const config = object(doc.toJS());
      const base = text(config.baseBranch);
      const prefixes = object(config.branches);
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
