type FieldType = "text" | "number" | "single_select";
export interface Option {
  id: string;
  name: string;
  color: string;
  description: string;
}
export interface Field {
  id: string;
  name: string;
  createdAt: number;
  type: FieldType | "other";
  options: Option[];
}
export interface Card {
  contentId?: string;
  number?: number;
  closedAt?: string | null;
  archived?: boolean;
  id: string;
  repo: string | null;
  kind: string;
  assignees: string[];
  values: Record<string, string | number | null>;
}
export interface FieldShape {
  type: FieldType;
  /** Ordered options; new migrations use metadata objects, legacy name lists remain valid. */
  options?: (string | Omit<Option, "id">)[];
  states?: { name: string; emoji: string }[];
}
export type Operation =
  | { op: "workflow_columns"; field: "Status" }
  | ({ op: "add_field"; field: string } & FieldShape)
  | {
      op: "add_option" | "set_option_meta";
      field: string;
      option: string;
      color?: string;
      description?: string;
    }
  | { op: "rename_option"; field: string; from: string; to: string }
  | { op: "add_progress_alias"; from: string; to: string }
  | { op: "rewrite_progress"; from: string; to: string }
  | { op: "remove_option"; field: string; option: string }
  | { op: "remove_field"; field: string };
export interface Migration {
  version: number;
  up: Operation[];
  expect: { fields: Record<string, FieldShape>; policy: { doneKeeps: number } };
  requires?: string;
}
export interface BoardState {
  version: number;
  minCompatible: number;
  migrated?: string;
  lock?: string;
  paused?: string;
  migrating?: string;
  aliases: Record<string, string>;
  completed?: string[];
  /** Legacy restore journal: read for compatibility, discarded on migration resume; never replayed. */
  optionUpdate?: {
    position: string;
    field: string;
    options: Omit<Option, "id">[];
    finalOptions?: Omit<Option, "id">[];
    values: { id: string; value: string | null }[];
  };
}
export interface Snapshot {
  id: string;
  readme: string;
  fields: Field[];
}
export interface BoardStatus {
  state: BoardState;
  pending: Migration[];
  drift: string[];
  mismatches: {
    itemId: string;
    number: number;
    closed: boolean;
    status: string | null;
    summary: string;
  }[];
}
export interface MigrationResult extends BoardStatus {
  dryRun: boolean;
  workflows?: string[];
  /** Human-readable outcome; dry runs list pending operations and version changes without writes. */
  message: string;
}
export interface BoardIO {
  /** Process identity scoped to the machine/boot; unknown remote holders are never declared dead. */
  lockIdentity?(): string | undefined;
  lockDead?(identity: string): boolean;
  /** Batched authenticated v5 scope evidence and pinned owner turns for v6 remapping. */
  workflowEvidence?(
    cards: Card[]
  ): Promise<Map<string, { approved: boolean; reviewPending: boolean; ownerTurn: boolean }>>;
  now(): number;
  login(): Promise<string>;
  snapshot(): Promise<Snapshot>;
  readme(projectId: string, readme: string): Promise<void>;
  createField(projectId: string, name: string, shape: FieldShape): Promise<string>;
  deleteField(id: string): Promise<void>;
  /** Keep existing IDs (including explicit old-name → new-name renames); callers snapshot/check values. */
  options(
    field: Field,
    options: Omit<Option, "id">[],
    renames?: Record<string, string>
  ): Promise<void>;
  cards(projectId: string): Promise<Card[]>;
  setCards(
    projectId: string,
    field: Field,
    cards: { id: string; value: string | number | null }[]
  ): Promise<void>;
  setArchived(itemId: string, archived: boolean): Promise<void>;
  budgetStopped(): boolean;
  cleanup<T>(action: () => Promise<T>): Promise<T>;
  announce(message: string): Promise<void>;
  workflows(projectId: string): Promise<string[]>;
  adoption(requires: string): Promise<void>;
  report(message: string): void;
}
