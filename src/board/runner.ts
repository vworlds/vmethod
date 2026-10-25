import { randomUUID } from "node:crypto";
import { compatibility, readState, writeState } from "./readme.js";
import { validateMigrations } from "./migrations.js";
import type {
  BoardIO,
  Card,
  BoardState,
  BoardStatus,
  Field,
  Migration,
  MigrationResult,
  Operation,
  Option,
  Snapshot,
} from "./types.js";

const lockName = "vmethod-migration-lock";
const minute = 60000;
const batchSize = 25;
/** The ordered Status column lifecycle every vmethod board keeps, Backlog first. */
export const workflowColumns = [
  "Backlog",
  "Scoping",
  "Spec review",
  "Executing",
  "Owner review",
  "Approved",
  "Done",
];
class BudgetPause extends Error {}

function drift(snapshot: Snapshot, migration?: Migration): string[] {
  if (!migration) {
    return [];
  }
  const output: string[] = [];
  for (const [name, expected] of Object.entries(migration.expect.fields)) {
    const fields = snapshot.fields.filter((field) => field.name === name);
    const field = fields[0];
    if (fields.length !== 1 || field.type !== expected.type) {
      output.push(`${name}: expected ${expected.type}`);
    } else if (
      expected.options &&
      (JSON.stringify(field.options.map((option) => option.name)) !==
        JSON.stringify(
          expected.options.map((option) => (typeof option === "string" ? option : option.name))
        ) ||
        expected.options.some(
          (option, index) =>
            typeof option !== "string" &&
            (field.options[index]?.color !== option.color ||
              field.options[index]?.description !== option.description)
        ))
    ) {
      output.push(
        `${name}: expected options ${expected.options.map((option) => (typeof option === "string" ? option : JSON.stringify(option))).join(", ")}`
      );
    }
  }
  return output;
}

function holderTime(lock?: string): number {
  return lock ? Date.parse(lock.split(" since ")[1]?.split(" identity ")[0] ?? "") : NaN;
}

export class MigrationRunner {
  private run = randomUUID();
  private lockId?: string;
  private initialAppend = false;
  private position = "";
  constructor(
    private io: BoardIO,
    private migrations: Migration[],
    private boardVersion: number,
    private packageVersion: string
  ) {
    validateMigrations(migrations);
    if (migrations.at(-1)?.version !== boardVersion) {
      throw new Error("Package boardVersion does not match migrations");
    }
  }

  async status(): Promise<BoardStatus> {
    const snapshot = await this.io.snapshot();
    const state = readState(snapshot.readme);
    const mismatches = (await this.io.cards(snapshot.id)).flatMap((card) => {
      if (!["Issue", "PullRequest"].includes(card.kind) || card.number === undefined) {
        return [];
      }
      const closed = Boolean(card.closedAt);
      const status = typeof card.values.Status === "string" ? card.values.Status : null;
      return closed !== (status === "Done") || !status
        ? [
            {
              itemId: card.id,
              number: card.number,
              closed,
              status,
              summary: `#${card.number}: ${closed ? "closed" : "open"}, Status ${status ?? "(unset)"}`,
            },
          ]
        : [];
    });
    return {
      state,
      pending: this.migrations.filter((migration) => migration.version > state.version),
      drift: drift(snapshot, this.migrations[Math.min(state.version || 1, this.boardVersion) - 1]),
      mismatches,
    };
  }

  async fixStatus(): Promise<BoardStatus> {
    const status = await this.status();
    const snapshot = await this.io.snapshot();
    const statusField = this.field(snapshot, "Status");
    const progressField = this.field(snapshot, "Progress");
    for (const mismatch of status.mismatches) {
      await this.io.setCards(snapshot.id, statusField, [
        { id: mismatch.itemId, value: mismatch.closed ? "Done" : "Backlog" },
      ]);
      await this.io.setCards(snapshot.id, progressField, [{ id: mismatch.itemId, value: null }]);
    }
    return this.status();
  }

  private async held(): Promise<{ snapshot: Snapshot; state: BoardState }> {
    const snapshot = await this.io.snapshot();
    const state = readState(snapshot.readme);
    if (
      !snapshot.fields.some((field) => field.id === this.lockId && field.name === lockName) ||
      !state.lock?.startsWith(`${this.run} `)
    ) {
      throw new Error("Migration lock lost");
    }
    return { snapshot, state };
  }

  private async update(change: (state: BoardState) => void): Promise<void> {
    const { snapshot, state } = await this.held();
    change(state);
    await this.io.readme(snapshot.id, writeState(snapshot.readme, state));
  }

  private async acquire(steal: boolean, login: string): Promise<void> {
    let snapshot = await this.io.snapshot();
    const state = readState(snapshot.readme);
    this.initialAppend = !snapshot.readme.includes("<!-- vmethod-board -->");
    const lock = snapshot.fields.find((field) => field.name === lockName);
    if (lock) {
      const since = holderTime(state.lock);
      const identity = state.lock?.split(" identity ")[1];
      const dead = identity !== undefined && this.io.lockDead?.(identity) === true;
      if (!dead && Number.isFinite(since) && this.io.now() - since <= 60 * minute) {
        throw new Error("Migration lock held; stale locks require --steal");
      }
      // No holder line (or a stale one): only the field's own age can tell a
      // live acquirer, whose holder write is still in flight, from an orphan.
      // Without proof of death, a fresh field is never stealable.
      if (!dead && this.io.now() - lock.createdAt < minute) {
        throw new Error("Migration lock being acquired");
      }
      if (!dead && !steal) {
        throw new Error(
          Number.isFinite(since)
            ? "Migration lock held; stale locks require --steal"
            : "LOCK ORPHANED (no holder); use --steal"
        );
      }
      const current = await this.io.snapshot();
      if (
        readState(current.readme).lock !== state.lock ||
        !current.fields.some(({ id, name }) => id === lock.id && name === lockName)
      ) {
        throw new Error("Migration lock changed during recovery; retry");
      }
      await this.io.deleteField(lock.id);
    }
    try {
      this.lockId = await this.io.createField(snapshot.id, lockName, {
        type: "text",
      });
    } catch {
      snapshot = await this.io.snapshot();
      const current = readState(snapshot.readme);
      const field = snapshot.fields.find((entry) => entry.name === lockName);
      if (field && !Number.isFinite(holderTime(current.lock))) {
        // The same age rule as the pre-check: a fresh field without a holder
        // may be another run (or this one, if the response was lost) still
        // acquiring it; an old one is a genuine orphan.
        if (this.io.now() - field.createdAt < minute) {
          throw new Error("Migration lock being acquired");
        }
        throw new Error("LOCK ORPHANED (no holder); use --steal");
      }
      throw new Error("Migration lock not acquired");
    }
    // Re-read immediately before the first holder write too.
    snapshot = await this.io.snapshot();
    const current = readState(snapshot.readme);
    if (!snapshot.fields.some((field) => field.id === this.lockId)) {
      throw new Error("Migration lock lost");
    }
    current.lock = `${this.run} ${login} since ${new Date(this.io.now()).toISOString()}`;
    const identity = this.io.lockIdentity?.();
    if (identity) {
      current.lock += ` identity ${identity}`;
    }
    await this.io.readme(snapshot.id, writeState(snapshot.readme, current, this.initialAppend));
  }

  private async release(paused?: string): Promise<void> {
    await this.update((state) => {
      state.paused = paused;
      state.migrating = undefined;
    });
    await this.held();
    await this.io.deleteField(this.lockId!);
    // Retain the holder until deletion succeeds. A deletion failure must not
    // disguise a still-held lock as an orphan.
    const snapshot = await this.io.snapshot();
    const state = readState(snapshot.readme);
    if (snapshot.fields.some((field) => field.name === lockName)) {
      return;
    }
    if (state.lock?.startsWith(`${this.run} `)) {
      state.lock = undefined;
      await this.io.readme(snapshot.id, writeState(snapshot.readme, state));
    }
  }

  async migrate({
    dryRun = false,
    steal = false,
  }: {
    dryRun?: boolean;
    steal?: boolean;
  }): Promise<MigrationResult> {
    const initial = await this.status();
    if (dryRun) {
      const remaps = initial.pending.some((migration) =>
        migration.up.some(
          (op, index) =>
            op.op === "workflow_columns" &&
            !initial.state.completed?.includes(`${migration.version}/${index + 1}`)
        )
      )
        ? await this.workflowPlan((await this.io.snapshot()).id)
        : [];
      const touchesStatus = initial.pending.some((migration) =>
        migration.up.some((op) => "field" in op && op.field === "Status")
      );
      return {
        ...initial,
        dryRun,
        workflows: touchesStatus ? await this.io.workflows((await this.io.snapshot()).id) : [],
        message: initial.pending.length
          ? [
              `Dry run: ${initial.state.version} → ${initial.pending.at(-1)!.version}`,
              ...initial.pending.flatMap((migration) =>
                migration.up.length
                  ? migration.up.map((op) => `v${migration.version}: ${describeOperation(op)}`)
                  : [`v${migration.version}: version only`]
              ),
              ...remaps.map(
                (card) =>
                  `#${card.number ?? card.id} (${card.kind}): ${card.from} → ${card.value}; ${card.evidence}`
              ),
              ...(await this.previewOptions(initial.pending)),
            ].join("; ")
          : "Dry run: no changes",
      };
    }
    compatibility(initial.state, this.boardVersion, this.io.report);
    if (!initial.pending.length) {
      return {
        ...initial,
        dryRun,
        message: "Board is up to date; never downgrade",
      };
    }
    const login = await this.io.login();
    await this.acquire(steal, login);
    const { state } = await this.held();
    const from = state.version;
    await this.update((current) => {
      current.migrating = `${from}→${this.boardVersion} by ${login} since ${new Date(this.io.now()).toISOString()}`;
      current.paused = undefined;
      current.optionUpdate = undefined;
    });
    await this.io.announce(`[vmethod] board migration ${from}→${this.boardVersion}`);
    try {
      for (const migration of this.migrations.filter((entry) => entry.version > from)) {
        await this.held();
        if (migration.requires) {
          try {
            await this.io.adoption(migration.requires);
          } catch (error) {
            await this.release();
            throw error;
          }
        }
        for (const [index, op] of migration.up.entries()) {
          this.position = `${migration.version}/${index + 1}`;
          const progress = (await this.held()).state;
          if (progress.completed?.includes(this.position)) {
            continue;
          }
          if (this.io.budgetStopped()) {
            throw new BudgetPause("0 cards left (operation pending)");
          }
          await this.apply(op);
          await this.update((current) => {
            current.completed = [...(current.completed ?? []), this.position];
            current.optionUpdate = undefined;
          });
        }
        if (this.io.budgetStopped()) {
          throw new BudgetPause("0 cards left (verification pending)");
        }
        const { snapshot, state: verified } = await this.held();
        const differences = drift(snapshot, migration);
        if (differences.length) {
          throw new Error(
            `Migration ${migration.version} expect failed: ${differences.join("; ")}`
          );
        }
        if (verified.version >= migration.version) {
          throw new Error("Board version changed during migration");
        }
        await this.update((current) => {
          current.version = migration.version;
          current.completed = undefined;
          if (migration.requires) {
            current.minCompatible = migration.version;
          }
          current.migrated = `${new Date(this.io.now()).toISOString()} by ${login} (vmethod v${this.packageVersion})`;
        });
      }
    } catch (error) {
      if (!(error instanceof BudgetPause)) {
        throw error;
      }
      return this.io.cleanup(async () => {
        await this.release(this.position);
        return {
          ...(await this.status()),
          dryRun,
          message: `BUDGET: ${error.message}; paused at ${this.position}`,
        };
      });
    }
    await this.release();
    return {
      ...(await this.status()),
      dryRun,
      message: `Migrated ${from}→${this.boardVersion}`,
    };
  }

  private field(snapshot: Snapshot, name: string): Field {
    const field = snapshot.fields.find((entry) => entry.name === name);
    if (!field) {
      throw new Error(`Missing board field ${name}`);
    }
    return field;
  }

  private async move(field: Field, from: string, to: string, rewrite = false): Promise<void> {
    const { snapshot } = await this.held();
    const cards = (await this.io.cards(snapshot.id)).flatMap((card) => {
      const value = card.values[field.name];
      if (
        typeof value !== "string" ||
        (rewrite
          ? !value.startsWith(from) ||
            !/^(?:\s|🔁|🔴|$)/u.test(value.slice(from.length)) ||
            from === to
          : value !== from)
      ) {
        return [];
      }
      return [{ id: card.id, value: rewrite ? to + value.slice(from.length) : to }];
    });
    for (let index = 0; index < cards.length; index += batchSize) {
      if (this.io.budgetStopped()) {
        throw new BudgetPause(`${cards.length - index} cards left`);
      }
      await this.held();
      if (this.io.budgetStopped()) {
        throw new BudgetPause(`${cards.length - index} cards left`);
      }
      await this.io.setCards(snapshot.id, field, cards.slice(index, index + batchSize));
    }
    if (!cards.length) {
      return;
    }
    const live = new Map((await this.io.cards(snapshot.id)).map((card) => [card.id, card]));
    if (cards.some(({ id, value }) => live.get(id)?.values[field.name] !== value)) {
      throw new Error(`Card move verification failed for ${field.name}`);
    }
  }

  private async apply(op: Operation): Promise<void> {
    const { snapshot, state } = await this.held();
    if (op.op === "workflow_columns") {
      const field = this.field(snapshot, "Status");
      const plan = await this.workflowPlan(snapshot.id);
      const final = workflowColumns.map((name) => {
        const option = field.options.find((option) => option.name === name);
        return { name, color: option?.color ?? "GRAY", description: option?.description ?? "" };
      });
      const expanded = field.options.map(({ name, color, description }) => ({
        name,
        color,
        description,
      }));
      for (const option of final) {
        if (!expanded.some(({ name }) => name === option.name)) {
          expanded.push(option);
        }
      }
      await this.preserveOptions(field, expanded);
      const expandedField = this.field((await this.held()).snapshot, field.name);
      const changed = plan.filter(({ from, value }) => from !== value);
      for (let index = 0; index < changed.length; index += batchSize) {
        if (this.io.budgetStopped()) {
          throw new BudgetPause(`${changed.length - index} cards left`);
        }
        await this.held();
        if (this.io.budgetStopped()) {
          throw new BudgetPause(`${changed.length - index} cards left`);
        }
        await this.io.setCards(snapshot.id, expandedField, changed.slice(index, index + batchSize));
      }
      const live = new Map((await this.io.cards(snapshot.id)).map((card) => [card.id, card]));
      if (plan.some(({ id, value }) => (live.get(id)?.values.Status ?? "") !== value)) {
        throw new Error("Workflow remap verification failed");
      }
      await this.preserveOptions(expandedField, final);
      return;
    }
    if (op.op === "add_progress_alias") {
      await this.update((current) => {
        current.aliases[op.from] = op.to;
      });
      return;
    }
    if (op.op === "rewrite_progress") {
      if (state.aliases[op.from] !== op.to) {
        throw new Error("Missing live Progress alias");
      }
      await this.move(this.field(snapshot, "Progress"), op.from, op.to, true);
      return;
    }
    if (op.op === "add_field") {
      const existing = snapshot.fields.find((field) => field.name === op.field);
      if (!existing) {
        await this.io.createField(snapshot.id, op.field, op);
      } else if (existing.type !== op.type) {
        throw new Error(`Field type conflict: ${op.field}`);
      }
      return;
    }
    const field = snapshot.fields.find((entry) => entry.name === op.field);
    if (!field && op.op === "remove_field") {
      return;
    }
    if (!field) {
      throw new Error(`Missing board field ${op.field}`);
    }
    if (op.op === "remove_field") {
      await this.io.deleteField(field.id);
      return;
    }
    if (field.type !== "single_select") {
      throw new Error("Option operation requires single_select");
    }
    const options = field.options.map(({ name, color, description }) => ({
      name,
      color,
      description,
    }));
    if (op.op === "rename_option") {
      const source = options.find((option) => option.name === op.from);
      if (!source || op.from === op.to) {
        return;
      }
      if (options.some((option) => option.name === op.to)) {
        await this.move(field, op.from, op.to);
      } else {
        options.push({ ...source, name: op.to });
        await this.preserveOptions(field, options, { [op.from]: op.to });
      }
    } else if (op.op === "remove_option") {
      if (!options.some((option) => option.name === op.option)) {
        return;
      }
      if ((await this.io.cards(snapshot.id)).some((card) => card.values[op.field] === op.option)) {
        throw new Error(`Cannot remove occupied option ${op.option}`);
      }
      await this.preserveOptions(
        field,
        options.filter((option) => option.name !== op.option)
      );
    } else {
      const option = options.find((entry) => entry.name === op.option);
      if (option) {
        if (op.op === "set_option_meta") {
          option.color = op.color ?? option.color;
          option.description = op.description ?? option.description;
        }
      } else if (op.op === "set_option_meta") {
        throw new Error(`Missing option ${op.option}`);
      } else {
        options.push({
          name: op.option,
          color: op.color ?? "GRAY",
          description: op.description ?? "",
        });
      }
      if (op.op === "add_option") {
        const migration = this.migrations.find(
          ({ version }) => String(version) === this.position.split("/")[0]
        )!;
        orderOptions(options, migration.expect.fields[op.field]?.options);
      }
      if (
        JSON.stringify(options) !==
        JSON.stringify(
          field.options.map(({ name, color, description }) => ({
            name,
            color,
            description,
          }))
        )
      ) {
        await this.preserveOptions(field, options);
      }
    }
  }

  /** Snapshot/check only: never write item values or persist a replayable snapshot. */
  private async preserveOptions(
    field: Field,
    options: Omit<Option, "id">[],
    renames: Record<string, string> = {}
  ): Promise<void> {
    const { snapshot } = await this.held();
    const values = (await this.io.cards(snapshot.id)).map((card) => {
      const value = card.values[field.name];
      return {
        id: card.id,
        value:
          typeof value === "string"
            ? Object.hasOwn(renames, value)
              ? renames[value]
              : value
            : null,
      };
    });
    for (const entry of values) {
      if (entry.value !== null && !options.some((option) => option.name === entry.value)) {
        throw new Error(
          `Cannot preserve ${field.name} on ${entry.id}: option ${entry.value} disappears`
        );
      }
    }
    if (
      JSON.stringify(
        field.options.map(({ name, color, description }) => ({ name, color, description }))
      ) !== JSON.stringify(options)
    ) {
      if (this.io.budgetStopped()) {
        throw new BudgetPause("option update pending");
      }
      await this.io.options(field, options, renames);
    }
    await this.held();
    const verified = new Map((await this.io.cards(snapshot.id)).map((card) => [card.id, card]));
    const mismatches = values.filter(
      ({ id, value }) =>
        !verified.has(id) || (verified.get(id)!.values[field.name] ?? null) !== value
    );
    if (mismatches.length) {
      throw new Error(
        `Option update verification failed for ${field.name}: ${mismatches.map(({ id, value }) => `${id} expected ${value ?? "(unset)"}, got ${verified.has(id) ? (verified.get(id)!.values[field.name] ?? "(unset)") : "(missing item)"}`).join("; ")}`
      );
    }
  }

  private async workflowPlan(projectId: string) {
    const cards = await this.io.cards(projectId);
    if (!this.io.workflowEvidence) {
      throw new Error("Missing workflow migration evidence reader");
    }
    const evidence = await this.io.workflowEvidence(cards);
    return cards.map((card: Card) => {
      const from = String(card.values.Status ?? "");
      const proof = evidence.get(card.id);
      let value = from;
      let reason = "unchanged";
      if (from === "Ready") {
        value = "Scoping";
        reason = "legacy queue rename";
      } else if (from === "In progress") {
        value = "Executing";
        reason = "legacy execution rename";
      } else if (from === "In review" && card.kind === "Issue") {
        if (!proof) {
          throw new Error(`Missing scope evidence for ${card.id}`);
        }
        value = proof.reviewPending ? "Spec review" : "Scoping";
        reason = proof.reviewPending
          ? "authenticated SCOPE REVIEW pending"
          : "no pending authenticated SCOPE REVIEW";
      } else if (from === "Approved" && card.kind === "Issue") {
        if (!proof) {
          throw new Error(`Missing scope evidence for ${card.id}`);
        }
        value = proof.approved ? "Executing" : "Spec review";
        reason = proof.approved
          ? "valid authenticated scope approval"
          : "scope approval invalid or absent";
      } else if (from === "In review" && card.kind === "PullRequest") {
        if (!proof) {
          throw new Error(`Missing owner-turn evidence for ${card.id}`);
        }
        value = proof.ownerTurn ? "Owner review" : "Executing";
        reason = proof.ownerTurn ? "pinned owner holds the turn" : "owner does not hold the turn";
      } else if (from === "In review") {
        throw new Error(`Cannot classify legacy review card ${card.id}`);
      }
      if (value && !workflowColumns.includes(value)) {
        throw new Error(`Cannot map unknown Status ${from} on ${card.id}`);
      }
      return { id: card.id, number: card.number, kind: card.kind, from, value, evidence: reason };
    });
  }

  private async previewOptions(pending: Migration[]): Promise<string[]> {
    const snapshot = await this.io.snapshot();
    const fields = structuredClone(snapshot.fields);
    const cards = await this.io.cards(snapshot.id);
    const output: string[] = [];
    const state = readState(snapshot.readme);
    if (state.optionUpdate) {
      output.push("Discard legacy option restore journal; use current live values");
    }
    for (const migration of pending) {
      for (const [index, op] of migration.up.entries()) {
        const position = `${migration.version}/${index + 1}`;
        if (state.completed?.includes(position)) {
          continue;
        }
        if (!("field" in op)) {
          continue;
        }
        if (op.op === "add_field") {
          if (!fields.some(({ name }) => name === op.field)) {
            fields.push({
              id: "preview",
              name: op.field,
              type: op.type,
              createdAt: this.io.now(),
              options: (op.options ?? []).map((option) => ({
                id: "preview",
                ...(typeof option === "string"
                  ? { name: option, color: "GRAY", description: "" }
                  : option),
              })),
            });
          }
          continue;
        }
        if (op.op === "remove_field") {
          const index = fields.findIndex(({ name }) => name === op.field);
          if (index !== -1) {
            fields.splice(index, 1);
          }
          for (const card of cards) {
            delete card.values[op.field];
          }
          continue;
        }
        const field = fields.find((field) => field.name === op.field);
        if (!field || field.type !== "single_select") {
          continue;
        }
        let options = field.options.map(({ name, color, description }) => ({
          name,
          color,
          description,
        }));
        if (op.op === "workflow_columns") {
          options = workflowColumns.map(
            (name) =>
              options.find((option) => option.name === name) ?? {
                name,
                color: "GRAY",
                description: "",
              }
          );
          const plan = await this.workflowPlan(snapshot.id);
          for (const card of cards) {
            card.values.Status = plan.find(({ id }) => id === card.id)!.value || null;
          }
        } else if (op.op === "rename_option") {
          const source = options.find(({ name }) => name === op.from);
          if (source && !options.some(({ name }) => name === op.to)) {
            options.push({ ...source, name: op.to });
          }
          for (const card of cards) {
            if (card.values[field.name] === op.from) {
              card.values[field.name] = op.to;
            }
          }
        } else if (op.op === "remove_option") {
          options = options.filter(({ name }) => name !== op.option);
        } else if (op.op === "add_option" || op.op === "set_option_meta") {
          const option = options.find(({ name }) => name === op.option);
          if (option && op.op === "set_option_meta") {
            option.color = op.color ?? option.color;
            option.description = op.description ?? option.description;
          } else if (!option && op.op === "add_option") {
            options.push({
              name: op.option,
              color: op.color ?? "GRAY",
              description: op.description ?? "",
            });
          }
          if (op.op === "add_option") {
            orderOptions(options, migration.expect.fields[op.field]?.options);
          }
        }
        if (
          JSON.stringify(options) ===
            JSON.stringify(
              field.options.map(({ name, color, description }) => ({ name, color, description }))
            ) &&
          op.op !== "rename_option"
        ) {
          continue;
        }
        const previousOrder = field.options.map(({ name }) => name);
        const nextOrder = options.map(({ name }) => name);
        if (
          previousOrder.length === nextOrder.length &&
          previousOrder.every((name) => nextOrder.includes(name)) &&
          JSON.stringify(previousOrder) !== JSON.stringify(nextOrder)
        ) {
          output.push(
            `v${migration.version}: ${field.name} option order ${JSON.stringify(previousOrder)} → ${JSON.stringify(nextOrder)}`
          );
        }
        for (const option of options) {
          const old = field.options.find(({ name }) => name === option.name);
          if (old?.color !== option.color || old?.description !== option.description) {
            output.push(
              `v${migration.version}: ${field.name}.${option.name} metadata ${JSON.stringify(old ? { color: old.color, description: old.description } : null)} → ${JSON.stringify({ color: option.color, description: option.description })}`
            );
          }
        }
        for (const card of cards) {
          const value = card.values[field.name] ?? null;
          if (value !== null && !options.some(({ name }) => name === value)) {
            throw new Error(
              `Cannot preserve ${field.name} on ${card.id}: option ${value} disappears`
            );
          }
          output.push(
            `v${migration.version}: check ${field.name} on ${card.id} (#${card.number ?? "unset"}): ${value ?? "(unset)"}`
          );
        }
        field.options = options.map((option) => ({ ...option, id: "preview" }));
      }
    }
    return output;
  }
}

function orderOptions(options: Omit<Option, "id">[], expected?: (string | Omit<Option, "id">)[]) {
  const order = (expected ?? []).map((entry) => (typeof entry === "string" ? entry : entry.name));
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index < 0 ? order.length : index;
  };
  options.sort((a, b) => rank(a.name) - rank(b.name));
}

function describeOperation(op: Operation): string {
  switch (op.op) {
    case "workflow_columns":
      return "remap Status using authenticated scope and owner-turn evidence; order seven workflow columns";
    case "add_field":
      return `add field ${op.field} (${op.type})${op.options ? ` with options ${op.options.map((option) => (typeof option === "string" ? option : JSON.stringify(option))).join(", ")}` : ""}`;
    case "add_option":
      return `add option ${op.option} to ${op.field}${op.color !== undefined || op.description !== undefined ? ` (${JSON.stringify({ color: op.color, description: op.description })})` : ""}`;
    case "set_option_meta":
      return `set option metadata ${op.field}.${op.option} (${JSON.stringify({ color: op.color, description: op.description })})`;
    case "rename_option":
      return `rename option ${op.field}: ${op.from} → ${op.to}`;
    case "add_progress_alias":
      return `add Progress alias ${op.from} → ${op.to}`;
    case "rewrite_progress":
      return `rewrite Progress prefix ${op.from} → ${op.to}`;
    case "remove_option":
      return `remove option ${op.option} from ${op.field}`;
    case "remove_field":
      return `remove field ${op.field}`;
  }
}
