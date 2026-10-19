import { resolve } from "node:path";
import {
  addTokens,
  opencodeUsage,
  opencodeRequests,
  zeroTokens,
  type Usage,
  type CostRequest,
} from "../cost.js";
import type { Config } from "../config.js";
import type { ProcessRuntime } from "./claude.js";
import type { WorkerFilesystem } from "./access.js";
import { object, type ObjectData } from "./people.js";
import { WriteJournal } from "./write-journal.js";

export interface Dependencies {
  /** Backends distinguish no recorded session (stopped for merging) from unknown status. */
  workers?: {
    status(pr: number, forMerge?: boolean): Promise<"stopped" | "live" | "unknown">;
    resume(pr: number, prompt: string): Promise<string | void>;
    stop?(pr: number): Promise<string | void>;
    /** Best-effort list closure; false leaves the merge journal step retryable. */
    close?(pr: number): Promise<boolean>;
  };
  fetch: typeof fetch;
  exec: (
    file: string,
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
  ) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  report: (message: string) => void;
  processes?: ProcessRuntime;
  workerFilesystem?: WorkerFilesystem;
}

/** A GraphQL answer that carried `errors`: the data is refused, and the watcher reports at once. */
export class GraphQLResponseError extends Error {
  constructor(
    message: string,
    readonly errors: readonly string[]
  ) {
    super(message);
  }
}

export interface ResourceBudget {
  remaining: number;
  limit: number;
  reset: number;
}

export interface BudgetStatus {
  resources: Record<string, ResourceBudget>;
  secondaryUntil: number;
}

/** Watch polls yield instead of sleeping inside HTTP, so budget events can be delivered now. */
export class BudgetPause extends Error {}

/** Preserve HTTP status for callers independently of contextual diagnostic text. */
export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    detail = ""
  ) {
    super(`GitHub HTTP ${status} on ${method} ${path}${detail ? `: ${detail}` : ""}`);
  }
}

/** Credentials and unfiltered responses must never cross the operation seam. */
export class GitHubClient {
  /** Session-local successful-write attribution; no credentials or response text. */
  readonly writes: WriteJournal;
  private readonly token: string;
  private pauseUntil = 0;
  private reserveUse = 0;
  private readonly reserve: number;
  private readonly retries: number;
  private readonly budgets = new Map<string, ResourceBudget>();
  private secondaryUntil = 0;
  private pollDepth = 0;

  async polling<T>(action: () => Promise<T>): Promise<T> {
    this.pollDepth++;
    try {
      return await action();
    } finally {
      this.pollDepth--;
    }
  }

  constructor(
    config: Config,
    env: NodeJS.ProcessEnv,
    private deps: Dependencies
  ) {
    const credentials = config.credentials as Record<string, string> | undefined;
    this.token = env[credentials?.githubToken ?? ""] ?? "";
    if (!this.token) {
      throw new Error("Missing configured GitHub token environment variable");
    }
    const budget = config.gateway as { reserve?: number; maxRetries?: number } | undefined;
    this.reserve = budget?.reserve ?? 100;
    this.retries = budget?.maxRetries ?? 3;
    this.writes = new WriteJournal(config, env, deps.now);
  }

  private redact(text: string): string {
    return text.split(this.token).join("[redacted]");
  }

  private async request(
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
    accept?: string,
    retry = true,
    redirect: RequestRedirect = "error"
  ): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path)) {
      throw new Error("Invalid GitHub endpoint");
    }
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") {
      throw new Error("Invalid GitHub origin");
    }
    for (let attempt = 0; ; attempt++) {
      const wait = this.pauseUntil - this.deps.now();
      if (wait > 0 && !this.reserveUse) {
        if (this.pollDepth) {
          throw new BudgetPause("Watch poll deferred until budget reset");
        }
        await this.deps.sleep(wait);
      }
      if (!this.reserveUse) {
        this.pauseUntil = 0;
      }
      let response: Response;
      try {
        response = await this.deps.fetch(url, {
          method,
          redirect,
          signal: AbortSignal.timeout(30000),
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: accept ?? "application/vnd.github+json",
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (!retry || attempt >= this.retries) {
          throw new Error("GitHub network request failed (retry limit reached)");
        }
        this.deps.report("GitHub network failure; retrying");
        await this.deps.sleep(1000 * 2 ** attempt);
        continue;
      }
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      const limit = response.headers.get("x-ratelimit-limit");
      const resource =
        response.headers.get("x-ratelimit-resource") ?? (path === "/graphql" ? "graphql" : "core");
      if (
        remaining !== null &&
        reset !== null &&
        Number.isFinite(Number(remaining)) &&
        Number.isFinite(Number(reset))
      ) {
        // The headers are the only budget source; the GraphQL rateLimit field lags.
        this.budgets.set(resource, {
          remaining: Number(remaining),
          limit: Number.isFinite(Number(limit)) ? Number(limit) : 0,
          reset: Number(reset),
        });
      }
      if (
        remaining !== null &&
        Number.isFinite(Number(remaining)) &&
        Number(remaining) <= this.reserve + 1
      ) {
        if (!reset || !Number.isFinite(Number(reset))) {
          throw new Error("BUDGET: missing valid reset header");
        }
        this.pauseUntil = Math.max(this.pauseUntil, Number(reset) * 1000);
        this.deps.report("BUDGET: paused before reserve");
      }
      const retryAfter = response.headers.get("retry-after");
      if ((response.status === 403 || response.status === 429) && retryAfter !== null) {
        const delay = /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - this.deps.now();
        if (!Number.isFinite(delay)) {
          throw new Error("BUDGET (secondary): invalid retry-after");
        }
        this.deps.report("BUDGET (secondary): honoring retry-after");
        this.secondaryUntil = Math.max(this.secondaryUntil, this.deps.now() + Math.max(0, delay));
        this.pauseUntil = Math.max(this.pauseUntil, this.deps.now() + Math.max(0, delay));
        await response.body?.cancel();
        if (this.pollDepth) {
          throw new BudgetPause("Watch poll deferred by secondary budget");
        }
        if (!retry || attempt >= this.retries) {
          throw new Error("BUDGET (secondary): retry limit reached");
        }
        continue;
      }
      if (retry && response.status >= 500 && attempt < this.retries) {
        this.deps.report(`GitHub HTTP ${response.status} on ${method} ${path}; retrying`);
        await response.body?.cancel();
        await this.deps.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok && !(redirect === "manual" && response.status === 302)) {
        let detail = "";
        try {
          const data = object(await response.json());
          const messages = [str(data.message)];
          if (Array.isArray(data.errors)) {
            for (const error of data.errors) {
              const item = object(error);
              const message = str(item.message);
              const code = str(item.code);
              if (message || code) {
                messages.push(message && code ? `${message} (${code})` : message || code);
              }
            }
          }
          detail = messages
            .filter(Boolean)
            .map((message) =>
              JSON.stringify(
                this.redact(message)
                  .replace(/[\r\n\t]/g, " ")
                  .slice(0, 200)
              )
            )
            .join("; ")
            .slice(0, 1000);
        } catch {
          // Non-JSON errors have no safe structured message to expose.
        }
        throw new GitHubHttpError(response.status, method, path, detail);
      }
      return response;
    }
  }

  async rest(
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET",
    body?: unknown,
    retry = true
  ): Promise<unknown> {
    const response = await this.request(path, method, body, undefined, retry);
    const at = new Date(this.deps.now()).toISOString();
    if (response.status === 204) {
      this.writes.record(path, method, body, null, at);
      return null;
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("GitHub returned invalid JSON");
    }
    // A GraphQL POST can be a read. Refused/partial mutations are not successful writes.
    if (
      path !== "/graphql" ||
      object(result).errors === undefined ||
      (Array.isArray(object(result).errors) && (object(result).errors as unknown[]).length === 0)
    ) {
      this.writes.record(path, method, body, result, at);
    }
    return result;
  }

  async diff(path: string): Promise<string> {
    return (await this.request(path, "GET", undefined, "application/vnd.github.diff")).text();
  }

  /** Job log redirects are signed URLs: never forward the API credential. */
  async jobLog(path: string): Promise<string> {
    const url = new URL(path, "https://api.github.com");
    if (
      url.origin !== "https://api.github.com" ||
      !/^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/\d+\/logs$/.test(path)
    ) {
      throw new Error("Invalid job log endpoint");
    }
    const response = await this.request(path, "GET", undefined, undefined, true, "manual");
    if (response.ok) {
      return this.redact(await response.text());
    }
    if (response.status !== 302) {
      throw new GitHubHttpError(response.status, "GET", path);
    }
    const destination = new URL(response.headers.get("location") ?? "");
    if (destination.protocol !== "https:" || destination.username || destination.password) {
      throw new Error("Invalid job log redirect");
    }
    await response.body?.cancel();
    const log = await this.deps.fetch(destination, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!log.ok) {
      throw new Error(`Log HTTP ${log.status}`);
    }
    return this.redact(await log.text());
  }

  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
    retry = true
  ): Promise<unknown> {
    const result = (await this.rest(
      "/graphql",
      "POST",
      {
        query,
        variables,
      },
      retry
    )) as { data?: unknown; errors?: unknown };
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("GitHub GraphQL: invalid response");
    }
    if (result.errors !== undefined && !Array.isArray(result.errors)) {
      throw new Error("GitHub GraphQL: invalid errors response; refusing partial data");
    }
    if (Array.isArray(result.errors) && result.errors.length) {
      const messages = result.errors.map((error: unknown) =>
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : "unspecified error"
      );
      throw new GraphQLResponseError(
        `GitHub GraphQL (untrusted errors): ${messages.map((message) => JSON.stringify(this.redact(message))).join("; ")}`,
        messages
      );
    }
    if (
      !Object.hasOwn(result, "data") ||
      result.data === null ||
      typeof result.data !== "object" ||
      Array.isArray(result.data)
    ) {
      throw new Error("GitHub GraphQL: missing data");
    }
    return result.data;
  }

  budgetStopped(): boolean {
    return this.pauseUntil > this.deps.now();
  }

  /** Read-only view of the last rate-limit headers per resource, for the watcher's pacing. */
  budget(): BudgetStatus {
    const resources: Record<string, ResourceBudget> = {};
    for (const [resource, status] of this.budgets) {
      if (status.reset * 1000 > this.deps.now()) {
        resources[resource] = { ...status };
      }
    }
    return { resources, secondaryUntil: this.secondaryUntil };
  }

  async usingReserve<T>(action: () => Promise<T>): Promise<T> {
    this.reserveUse++;
    try {
      return await action();
    } finally {
      this.reserveUse--;
    }
  }
}

export interface WorkerStatus {
  state: "permission" | "failed" | "idle" | "other";
  /** What distinguishes this stop (the permission or error); keys the once-per-stop report. */
  detail?: string;
}

function listed(value: unknown, field: string, path: string): ObjectData[] {
  value = opencodeData(value);
  const items = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Array.isArray((value as Record<string, unknown>)[field])
      ? ((value as Record<string, unknown>)[field] as unknown[])
      : null;
  if (items === null) {
    throw new Error(`Invalid opencode response on GET ${path}: expected ${field} list`);
  }
  return items.map(object);
}

function sessionDirectory(session: ObjectData): string {
  const location = object(session.location);
  return str(session.directory) || str(location.directory);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sessionIds(value: unknown): string[] {
  value = opencodeData(value);
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry : str(object(entry).id)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const inner = (value as Record<string, unknown>).sessions;
    if (Array.isArray(inner)) {
      return sessionIds(inner);
    }
    return Object.keys(value);
  }
  throw new Error("Invalid opencode response on GET /api/session/active: expected session map");
}

function opencodeData(value: unknown): unknown {
  return value !== null && typeof value === "object" && Object.hasOwn(value, "data")
    ? object(value).data
    : value;
}

function validSessionId(id: string): boolean {
  return /^ses_[A-Za-z0-9_-]+$/.test(id);
}

export class OpencodeClient {
  private readonly url: URL;
  private readonly authorization: string;
  private readonly secrets: string[];
  private readonly pollErrors = new Map<string, Set<string>>();

  constructor(
    env: NodeJS.ProcessEnv,
    private fetcher: typeof fetch,
    private now: () => number = Date.now,
    private report: (message: string) => void = console.error
  ) {
    if (!env.OPENCODE_BASE_URL || !env.OPENCODE_SERVER_USERNAME || !env.OPENCODE_SERVER_PASSWORD) {
      throw new Error(
        "Missing OPENCODE_BASE_URL / OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD"
      );
    }
    this.url = new URL(env.OPENCODE_BASE_URL);
    if (
      !["http:", "https:"].includes(this.url.protocol) ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash
    ) {
      throw new Error("Invalid opencode base URL");
    }
    this.authorization = `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME}:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
    this.secrets = [
      this.authorization,
      this.authorization.slice(6),
      env.OPENCODE_SERVER_PASSWORD,
      env.OPENCODE_SERVER_USERNAME,
    ].sort((a, b) => b.length - a.length);
  }

  async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    deadline?: number
  ): Promise<unknown> {
    if (!/^\/[A-Za-z0-9_/?=&%.-]*$/.test(path) || path.startsWith("//") || path.includes("..")) {
      throw new Error("Invalid opencode path");
    }
    const url = new URL(`${this.url.toString().replace(/\/$/, "")}${path}`);
    const context = `${method} ${this.redact(path)}`;
    const timeout = Math.min(30000, deadline === undefined ? 30000 : deadline - this.now());
    if (timeout <= 0) {
      throw new Error(`opencode deadline exceeded on ${context}`);
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(Math.ceil(timeout)),
        headers: {
          authorization: this.authorization,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`opencode network request failed on ${context}`);
    }
    if (!response.ok) {
      let message = "";
      try {
        const data = object(await response.json());
        const error = data.error;
        message = str(error) || str(object(error).message) || str(data.message);
      } catch {
        // Non-JSON errors have no safe structured message to expose.
      }
      message = this.redact(message)
        .replace(/[\r\n\t]/g, " ")
        .slice(0, 200);
      throw new OpencodeError(response.status, method, this.redact(path), message);
    }
    if (response.status === 204) {
      return {};
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`opencode returned invalid JSON on ${context}`);
    }
  }

  async status(directory: string): Promise<WorkerStatus>;
  async status(
    directory: string,
    id: string,
    deadline?: number,
    known?: readonly string[]
  ): Promise<WorkerSessionStatus>;
  async status(
    directory: string,
    id?: string,
    deadline?: number,
    known?: readonly string[]
  ): Promise<WorkerStatus | WorkerSessionStatus> {
    return id === undefined
      ? this.watchStatus(directory)
      : this.sessionStatus(directory, id, deadline, known);
  }

  /** Read the recorded session envelope for cost recovery; a missing session is unknown. */
  async costSession(id: string): Promise<unknown | undefined> {
    if (!validSessionId(id)) {
      throw new Error("Invalid opencode session id: expected ses_ prefix");
    }
    try {
      const session = opencodeData(
        await this.request("GET", `/api/session/${encodeURIComponent(id)}`)
      );
      const active = sessionIds(await this.request("GET", "/api/session/active"));
      const messages: unknown[] = [];
      const seenMessages = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
        const envelope = object(
          await this.request("GET", `/api/session/${encodeURIComponent(id)}/message?${query}`)
        );
        const response = opencodeData(envelope);
        if (!Array.isArray(response)) {
          if (page === 0) {
            return { session, messages: [] };
          }
          throw new Error("Invalid opencode cost message response");
        }
        let added = 0;
        for (const message of response) {
          const id = object(message).id;
          const key = typeof id === "string" ? id : JSON.stringify(message);
          if (seenMessages.has(key)) {
            continue;
          }
          seenMessages.add(key);
          messages.push(message);
          added++;
        }
        // Messages are newest-first: next traverses older history, previous goes newer.
        const next = object(envelope.cursor).next;
        if (added === 0 || typeof next !== "string" || !next || next === cursor) {
          break;
        }
        if (page === 99) {
          throw new Error("OpenCode cost history exceeds pagination limit");
        }
        cursor = next;
      }
      return { session, messages, running: active.includes(id) };
    } catch (error) {
      if (error instanceof OpencodeError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private async watchStatus(directory: string): Promise<WorkerStatus> {
    const active = sessionIds(await this.request("GET", "/api/session/active"));
    for (const id of this.pollErrors.keys()) {
      if (!active.includes(id)) {
        this.pollErrors.delete(id);
      }
    }
    let stopped: WorkerStatus = { state: "other" };
    for (const id of active) {
      try {
        if (!validSessionId(id)) {
          throw new Error(
            "Invalid opencode session id on GET /api/session/active: expected ses_ prefix"
          );
        }
        const path = `/api/session/${encodeURIComponent(id)}`;
        const session = object(opencodeData(await this.request("GET", path)));
        const recorded = sessionDirectory(session);
        if (!recorded || resolve(recorded) !== resolve(directory)) {
          continue;
        }
        const permissions = listed(
          await this.request("GET", `${path}/permission`),
          "permissions",
          this.redact(`${path}/permission`)
        );
        if (permissions.length) {
          const permission = permissions[0];
          stopped = {
            state: "permission",
            detail: str(permission.type) || str(permission.title) || undefined,
          };
          this.pollErrors.delete(id);
          continue;
        }
        const messages = listed(
          await this.request("GET", `${path}/message?limit=20`),
          "messages",
          this.redact(`${path}/message?limit=20`)
        );
        const idle = messages.find((message) => str(message.type) === "idle") ?? session;
        if (stopped.state !== "permission" && str(idle.outcome) === "failed") {
          const error = object(idle.error);
          stopped = { state: "failed", detail: str(error.message) || str(error.name) || undefined };
        }
        this.pollErrors.delete(id);
      } catch (error) {
        const status =
          error instanceof OpencodeError ? String(error.status) : (error as Error).message;
        const seen = this.pollErrors.get(id) ?? new Set<string>();
        if (!seen.has(status)) {
          this.report(
            `watcher: worker session ${validSessionId(id) ? this.redact(id) : "(invalid id)"} failed: ${(error as Error).message}`
          );
          seen.add(status);
          this.pollErrors.set(id, seen);
        }
      }
    }
    return stopped;
  }

  private async sessionStatus(
    directory: string,
    id: string,
    deadline?: number,
    known: readonly string[] = []
  ): Promise<WorkerSessionStatus> {
    const active = object(
      opencodeData(await this.request("GET", "/api/session/active", undefined, deadline))
    );
    if (!id) {
      return { reason: "session unknown", active: false };
    }
    if (!validSessionId(id)) {
      throw new Error("Invalid opencode session id on GET /api/session/:id: expected ses_ prefix");
    }
    let session: ObjectData;
    try {
      session = object(
        opencodeData(
          await this.request("GET", `/api/session/${encodeURIComponent(id)}`, undefined, deadline)
        )
      );
    } catch (error) {
      if (error instanceof OpencodeError && error.status === 404) {
        return { reason: "session unknown", active: false };
      }
      throw error;
    }
    if (!session.id) {
      return { reason: "session unknown", active: false };
    }
    const permissions = opencodeData(
      await this.request(
        "GET",
        `/api/session/${encodeURIComponent(id)}/permission`,
        undefined,
        deadline
      )
    );
    let usage = opencodeUsage(session);
    const messageEnvelope = await this.request(
      "GET",
      `/api/session/${encodeURIComponent(id)}/message${usage ? "?limit=20" : ""}`,
      undefined,
      deadline
    );
    const messages = opencodeData(messageEnvelope);
    if (!Array.isArray(permissions) || !Array.isArray(messages)) {
      throw new Error("Invalid opencode status response");
    }
    const seen = new Set(known);
    let pageMessages = messages;
    let cursor = object(object(messageEnvelope).cursor).next;
    for (let page = 0; typeof cursor === "string" && cursor; page++) {
      if (usage && pageMessages.some((message) => seen.has(String(object(message).id)))) {
        break;
      }
      if (page === 99) {
        throw new Error("OpenCode cost history exceeds pagination limit");
      }
      const query = new URLSearchParams({ limit: "200", cursor });
      const envelope = await this.request(
        "GET",
        `/api/session/${encodeURIComponent(id)}/message?${query}`,
        undefined,
        deadline
      );
      const next = opencodeData(envelope);
      if (!Array.isArray(next)) {
        throw new Error("Invalid opencode cost message response");
      }
      messages.push(...next);
      const older = object(object(envelope).cursor).next;
      if (!next.length || older === cursor) {
        break;
      }
      pageMessages = next;
      cursor = older;
    }
    const uniqueMessages = [
      ...new Map(
        messages.map((message) => [
          typeof object(message).id === "string" ? object(message).id : JSON.stringify(message),
          message,
        ])
      ).values(),
    ];
    const latest = uniqueMessages.map(object).find((m) => m.type === "idle");
    if (!usage) {
      const measured = uniqueMessages
        .map((message) => opencodeUsage(message))
        .filter((u) => u !== undefined);
      if (measured.length) {
        usage = opencodeUsage(session, {
          tokens: measured.reduce((sum, u) => addTokens(sum, u.tokens), zeroTokens()),
          ...(measured.every((u) => u.reportedUsd !== undefined)
            ? { reportedUsd: measured.reduce((sum, u) => sum + u.reportedUsd!, 0) }
            : {}),
        });
      }
    }
    const detail = {
      compactions: uniqueMessages
        .map(object)
        .filter(
          (m) =>
            m.type === "compaction" &&
            m.status === "completed" &&
            typeof m.id === "string" &&
            typeof object(m.time).created === "number"
        )
        .map((m) => ({ id: String(m.id), created: Number(object(m.time).created) })),
      requests: opencodeRequests(uniqueMessages),
      ...(usage ? { usage } : {}),
      title: typeof session.title === "string" ? session.title : undefined,
      directory,
      inputTokens:
        typeof object(session.tokens).input === "number"
          ? Number(object(session.tokens).input)
          : undefined,
      outputTokens:
        typeof object(session.tokens).output === "number"
          ? Number(object(session.tokens).output)
          : undefined,
      updated:
        typeof object(session.time).updated === "number"
          ? Number(object(session.time).updated)
          : undefined,
      permissions: permissions.length,
    };
    if (Array.isArray(permissions) && permissions.length) {
      return { reason: "permission-wait", active: Boolean(active[id]), ...detail };
    }
    if (active[id]) {
      return { reason: "running", active: true, ...detail };
    }
    return { ...classifyTurn(latest ?? session), ...detail };
  }

  private redact(text: string): string {
    for (const secret of this.secrets) {
      text = text.split(secret).join("[redacted]");
    }
    return text;
  }
}

/** Structured HTTP failure for bounded, status-specific OpenCode recovery. */
export class OpencodeError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    message: string
  ) {
    super(`opencode HTTP ${status} on ${method} ${path}${message ? `: ${message}` : ""}`);
  }
}

export interface WorkerSessionStatus {
  reason:
    | "running"
    | "permission-wait"
    | "quota"
    | "provider-error"
    | "idle"
    | "idle without reply"
    | "session unknown";
  active: boolean;
  error?: string;
  title?: string;
  directory?: string;
  inputTokens?: number;
  outputTokens?: number;
  updated?: number;
  permissions?: number;
  /** Cumulative provider usage for this session, never inferred from message text. */
  usage?: Usage;
  /** Per-request usage from assistant messages, separate from cumulative totals. */
  requests?: CostRequest[];
  /** Completed compaction events, identified across repeated history polls. */
  compactions?: { id: string; created: number }[];
  /** This task PR's own segments, for the existing board poll; never an issue rollup. */
  prCost?: { pr: number; usd: number | null; lowerBound?: boolean };
}

export function classifyTurn(turn: ObjectData): WorkerSessionStatus {
  if (
    turn.outcome !== "failed" &&
    !turn.error &&
    turn.is_error !== true &&
    !/^error/.test(String(turn.subtype))
  ) {
    return { reason: "idle", active: false };
  }
  const error = JSON.stringify(turn.error ?? turn.errors ?? turn);
  return {
    reason: /quota|rate.?limit|429|subscription|credit|capacity|usage.limit/i.test(error)
      ? "quota"
      : "provider-error",
    active: false,
    error,
  };
}
