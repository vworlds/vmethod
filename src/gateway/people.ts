import type { Digest } from "./digest.js";

export interface Person {
  login: string;
  id: number;
  type: "User" | "Bot";
  role: "owner" | "orchestrator" | "worker" | "collaborator" | "system";
  events?: ("check_run" | "status" | "workflow_run")[];
  appIds?: number[];
  /** Central, owner-approved project bindings for learning submissions. */
  repos?: string[];
}
export type ObjectData = Record<string, unknown>;
export function object(value: unknown): ObjectData {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectData)
    : {};
}

export class PeopleFilter {
  constructor(
    public people: Person[],
    readonly org: string,
    private digest: Digest,
    private readonly trustedRepos: readonly string[] = []
  ) {
    this.reload(people);
  }

  /** Atomically replace validated people; duplicate pins leave the previous list intact. */
  reload(people: Person[]): void {
    if (
      new Set(people.map((p) => p.id)).size !== people.length ||
      new Set(people.map((p) => p.login.toLowerCase())).size !== people.length
    ) {
      throw new Error("people.yaml: duplicate id or login");
    }
    this.people = people;
  }

  /** The orchestrator role is per repository (#186): the owner-approved `repos`
   * binding lists the repositories where the account is authoritative; in every
   * other repository, including this project's, it acts as a collaborator (it may
   * open issues and discuss, and stays an authorized learning submitter, but it is
   * never this project's orchestrator). Other declared roles are global.
   */
  roleIn(person: Person, repo: string): Person["role"] {
    return person.role === "orchestrator" &&
      !person.repos?.some((bound) => bound.toLowerCase() === repo.toLowerCase())
      ? "collaborator"
      : person.role;
  }

  identity(value: unknown, normalizeBotLogin = true): Person | undefined {
    const actor = object(value);
    if (
      !["User", "Bot"].includes(String(actor.__typename)) ||
      !Number.isSafeInteger(actor.databaseId) ||
      Number(actor.databaseId) < 1
    ) {
      return undefined;
    }
    return this.people.find(
      (person) =>
        person.id === actor.databaseId &&
        person.type === actor.__typename &&
        typeof actor.login === "string" &&
        (normalizeBotLogin
          ? identityLogin(person.login, person.type) === identityLogin(actor.login, person.type)
          : person.login.toLowerCase() === actor.login.toLowerCase())
    );
  }

  accept(item: ObjectData, owner: string, link: string, kind = "comment"): Person | undefined {
    let person = this.identity(item.author);
    if (item.lastEditedAt != null) {
      person = this.identity(item.editor);
    }
    const repository = String(object(item.repository).nameWithOwner ?? "");
    if (
      (owner.toLowerCase() !== this.org.toLowerCase() &&
        !this.trustedRepos.some((repo) => repo.toLowerCase() === repository.toLowerCase())) ||
      !person ||
      (person.role === "system" && !person.events?.includes(kind as "check_run"))
    ) {
      this.digest.drop(link);
      return undefined;
    }
    // Authority is per repository: a peer orchestrator is delivered as a collaborator.
    const role = this.roleIn(person, repository);
    return role === person.role ? person : { ...person, role };
  }

  check(run: ObjectData, owner: string, link: string): Person | undefined {
    const app = object(run.app);
    const person = this.people.find(
      (entry) =>
        entry.role === "system" &&
        ["User", "Bot"].includes(entry.type) &&
        entry.events?.includes("check_run") &&
        typeof app.id === "number" &&
        entry.appIds?.includes(app.id)
    );
    if (owner.toLowerCase() !== this.org.toLowerCase() || !person) {
      this.digest.drop(link);
      return undefined;
    }
    return person;
  }
}

/** GraphQL omits REST's trailing [bot] suffix; only Bot accounts share these spellings. */
function identityLogin(login: string, type: Person["type"]): string {
  const lower = login.toLowerCase();
  return type === "Bot" ? lower.replace(/\[bot\]$/, "") : lower;
}

/** A variable-length fence cannot be closed by hostile body text. */
export function untrusted(text: string): string {
  const length = Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1));
  const fence = "`".repeat(length);
  return `UNTRUSTED DATA\n${fence}text\n${text}\n${fence}`;
}

export function labelled(person: Person, text: string): string {
  return `from ${person.login} (${person.role})\n${untrusted(text)}`;
}

export function checkFacts(run: ObjectData): ObjectData {
  return {
    appId: object(run.app).id,
    headSha: /^[a-f\d]{40}$/i.test(String(run.head_sha)) ? run.head_sha : null,
    status: ["queued", "in_progress", "completed", "waiting", "pending", "requested"].includes(
      String(run.status)
    )
      ? run.status
      : "unknown",
    conclusion: [
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
    ].includes(String(run.conclusion))
      ? run.conclusion
      : null,
  };
}
