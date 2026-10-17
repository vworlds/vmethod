import { randomUUID } from "node:crypto";
import { modelRecord } from "../learnings.js";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadYaml, type Config } from "../config.js";
import {
  classifyTurn,
  OpencodeClient,
  type Dependencies,
  type WorkerSessionStatus,
} from "./client.js";
import { processes, type ProcessIdentity } from "./claude.js";
import { object, untrusted } from "./people.js";

interface Model {
  family: string;
  model: string;
  kind: "opencode" | "claude";
  gate: "none" | "owner";
  tier: "expensive" | "standard" | "cheap";
  fallback?: string[];
}
interface Segment {
  family: string;
  model: string;
  rounds: number[];
  why: string;
  at: string;
}
interface Session {
  version: 1;
  repo: string;
  pr: number;
  issue: number;
  directory: string;
  id: string;
  model: Model;
  segments: Segment[];
  points_open: number;
  process?: ProcessIdentity;
  interrupted?: boolean;
  logOffset?: number;
}
export interface TaskMetadata {
  pr: number;
  issue?: number;
  branch: string;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  blocked: boolean;
  estimate?: number;
  pointsOpen?: number;
  model?: string;
  kind: string;
  merged: boolean;
  comments: { body: string; role: string; date: string }[];
}
export interface WorkerHooks {
  metadata(pr: number): Promise<TaskMetadata>;
  prepare(pr: number): Promise<string>;
  setModel(pr: number, family: string): Promise<void>;
  setEstimate(issue: number, points: number): Promise<void>;
  workerIdentity(): Promise<NodeJS.ProcessEnv>;
  issue(ref: number): Promise<{ estimate?: number; kind: string }>;
}

export class WorkerService {
  private readonly state: string;
  private readonly models: Model[];
  private readonly runtime;
  constructor(
    private root: string,
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies,
    private hooks: WorkerHooks
  ) {
    const name = String(config.stateName ?? String(config.repo).replace("/", "-"));
    if (!/^[\w.-]+$/.test(name) || name === ".." || name === ".") {
      throw new Error("Invalid stateName");
    }
    this.state = join(
      env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local/state"),
      "vmethod",
      name,
      "workers"
    );
    this.models = loadYaml(root, "models") as Model[];
    if (new Set(this.models.map((m) => m.family)).size !== this.models.length) {
      throw new Error("Duplicate model family");
    }
    for (const model of this.models) {
      for (const family of model.fallback ?? []) {
        if (!this.models.some((m) => m.family === family)) {
          throw new Error(`Unknown fallback family ${family}`);
        }
      }
    }
    this.runtime = deps.processes ?? processes;
  }
  private client() {
    return new OpencodeClient(this.env, this.deps.fetch, this.deps.now);
  }
  private file(pr: number) {
    return join(this.state, `${pr}.json`);
  }
  private read(pr: number): Session | undefined {
    if (!existsSync(this.file(pr))) {
      return;
    }
    const record = JSON.parse(readFileSync(this.file(pr), "utf8")) as Session;
    if (
      record.version !== 1 ||
      record.repo !== this.config.repo ||
      record.pr !== pr ||
      !record.id ||
      !Array.isArray(record.segments)
    ) {
      throw new Error("Invalid worker session record");
    }
    return record;
  }
  private save(record: Session) {
    mkdirSync(this.state, { recursive: true, mode: 0o700 });
    const file = `${this.file(record.pr)}.new`;
    writeFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
    renameSync(file, this.file(record.pr));
  }
  private async locked<T>(pr: number, action: () => Promise<T>): Promise<T> {
    mkdirSync(this.state, { recursive: true, mode: 0o700 });
    const lock = join(this.state, `${pr}.lock`);
    try {
      mkdirSync(lock);
    } catch {
      throw new Error(
        `Worker #${pr} is locked; another operation is active (remove stale lock only after confirming its process exited)`
      );
    }
    try {
      return await action();
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
  private resolve(selected: string, approved: boolean): Model {
    let model = this.models.find((m) => m.family === selected || m.model === selected);
    if (!model && typeof selected === "string" && /^[^/\s]+\/[^\s]+$/.test(selected)) {
      const other = this.models.find((m) => m.family === "other" && m.kind === "opencode");
      if (other) {
        model = { ...other, model: selected };
      }
    }
    if (!model) {
      throw new Error(
        `Unknown model ${selected}; configure it in models.yaml (raw ids require an 'other' family policy)`
      );
    }
    if (model.gate === "owner" && !approved) {
      throw new Error(`${model.family} requires --owner-approved`);
    }
    return model;
  }
  private idPath(record: Session) {
    return `/api/session/${encodeURIComponent(record.id)}`;
  }
  private round(meta: TaskMetadata): number {
    return Math.max(
      1,
      ...meta.comments.map((c) =>
        Number(/(?:REVIEW|READY FOR REVIEW).*?round\s+(\d+)/i.exec(c.body)?.[1] ?? 1)
      )
    );
  }
  private redact(text: string): string {
    const credentials = object(this.config.credentials);
    for (const name of [...Object.values(credentials), "OPENCODE_SERVER_PASSWORD"]) {
      const secret = this.env[String(name)];
      if (secret) {
        for (const representation of [secret, JSON.stringify(secret).slice(1, -1)]) {
          text = text.split(representation).join("[redacted]");
        }
      }
    }
    return text;
  }
  private async status(
    record: Session,
    comments = true,
    deadline?: number
  ): Promise<WorkerSessionStatus> {
    let status: WorkerSessionStatus;
    if (record.model.kind === "claude") {
      if (record.process && this.runtime.alive(record.process)) {
        status = { reason: "running", active: true };
      } else {
        const log = join(record.directory, ".tmp/claude-worker.log");
        const turn = existsSync(log)
          ? readFileSync(log)
              .subarray(record.logOffset ?? 0)
              .toString("utf8")
          : "";
        const lines = turn.split("\n").map((line) => {
          try {
            return object(JSON.parse(line));
          } catch {
            return {};
          }
        });
        const result = lines.filter((m) => m.type === "result").at(-1);
        status = result
          ? classifyTurn(result)
          : record.interrupted
            ? { reason: "idle", active: false }
            : record.process
              ? {
                  reason: "provider-error",
                  active: false,
                  error: turn || "Claude exited without a turn result",
                }
              : { reason: "session unknown", active: false };
      }
    } else {
      status = await this.client().status(record.directory, record.id, deadline);
    }
    if (status.reason === "idle" && comments) {
      const meta = await this.hooks.metadata(record.pr);
      const latest = (role: string) =>
        meta.comments
          .filter((c) => c.role === role && c.body.startsWith(`[${role}]`))
          .map((c) => c.date)
          .sort()
          .at(-1) ?? "";
      if (latest("orchestrator") > latest("worker")) {
        status.reason = "idle without reply";
      }
    }
    if (status.error) {
      status.error = this.redact(status.error);
    }
    return status;
  }
  private render(record: Session, status: WorkerSessionStatus): string {
    const fallback =
      this.models.find((model) => model.family === record.model.family)?.fallback ?? [];
    const advice = ["quota", "provider-error"].includes(status.reason)
      ? `\nQUOTA ${record.model.family}; fallback: ${fallback.join(" → ") || "none configured"} (owner decision; not switched)`
      : "";
    const details = ` | ${record.model.family} | ${JSON.stringify(status.directory ?? record.directory)}${status.title ? ` | ${JSON.stringify(status.title)}` : ""}${status.inputTokens === undefined ? "" : ` | tokens in ${status.inputTokens} out ${status.outputTokens ?? 0}`}${status.updated === undefined ? "" : ` | updated ${status.updated}`}${status.permissions ? ` | ${status.permissions} permission request(s)` : ""}`;
    return `#${record.pr} ${record.id} ${status.reason}${details}${status.error ? ` ${untrusted(status.error)}` : ""}${advice}`;
  }
  private claudeLog(record: Session): string[] {
    const file = join(record.directory, ".tmp/claude-worker.log");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
  }
  private async interrupt(record: Session, deadline?: number) {
    if (record.model.kind === "claude") {
      if (record.process) {
        this.runtime.stop(record.process);
        record.interrupted = true;
        this.save(record);
      }
    } else {
      await this.client().request("POST", `${this.idPath(record)}/interrupt`, undefined, deadline);
    }
  }
  private async idle(record: Session, seconds: number, end = this.deps.now() + seconds * 1000) {
    for (;;) {
      const status = await this.status(record, false, end);
      if (status.reason === "session unknown") {
        throw new Error("session unknown; prompt not sent");
      }
      if (!status.active && status.reason !== "permission-wait") {
        return status;
      }
      if (this.deps.now() >= end) {
        throw new Error(`Still busy after ${seconds}s; prompt not sent`);
      }
      await this.deps.sleep(Math.min(1000, end - this.deps.now()));
    }
  }
  private async prompt(record: Session, text: string, delivery = "steer", resume = true) {
    if (record.model.kind === "opencode") {
      await this.client().request("POST", `${this.idPath(record)}/prompt`, { text, delivery });
    } else {
      const env = await this.hooks.workerIdentity();
      const log = join(record.directory, ".tmp/claude-worker.log");
      record.logOffset = existsSync(log) ? statSync(log).size : 0;
      record.interrupted = false;
      record.process = await this.runtime.launch({
        args: [
          "-p",
          resume ? "--resume" : "--session-id",
          record.id,
          "--model",
          record.model.model,
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          "Bash",
          "Edit",
          "Write",
          "Read",
          "Grep",
          "Glob",
        ],
        cwd: record.directory,
        env: { ...env, VMETHOD_TASK_PR: String(record.pr) },
        prompt: text,
        log,
      });
      this.save(record);
    }
  }
  async command(args: string[]): Promise<string> {
    const [verb, ref, ...rest] = args;
    if (verb === "models" || verb === "health") {
      if (args.length !== 1) {
        throw new Error(`Usage: worker ${verb}`);
      }
      if (verb === "health") {
        await this.client().request("GET", "/api/session/active");
        return "opencode answers and accepts our login";
      }
      const available = object(await this.client().request("GET", "/api/model")).data;
      if (!Array.isArray(available)) {
        throw new Error("Invalid opencode model response");
      }
      return (
        this.models
          .map(
            (m) =>
              `${m.family}\t${m.model}\t${m.kind}\t${m.gate}\tfallback: ${(m.fallback ?? []).join(" → ")}`
          )
          .join("\n") +
        `\nAvailable on opencode:\n${untrusted(
          this.redact(
            available
              .map((entry) => {
                const model = object(entry);
                return `${String(model.providerID)}/${String(model.id)}`;
              })
              .join("\n")
          )
        )}`
      );
    }
    if (verb === "status" && ref === undefined) {
      if (!existsSync(this.state)) {
        return "No worker sessions";
      }
      const lines = [];
      for (const file of readdirSync(this.state).filter((f) => /^\d+\.json$/.test(f))) {
        lines.push(await this.command(["status", file.slice(0, -5)]));
      }
      return lines.join("\n");
    }
    if (verb === "adopt" && ref === "--from-legacy") {
      if (rest.length) {
        throw new Error("Usage: worker adopt --from-legacy");
      }
      return this.adoptLegacy();
    }
    if (!/^[1-9]\d*$/.test(ref ?? "") || !Number.isSafeInteger(Number(ref))) {
      throw new Error("Worker requires a positive PR number");
    }
    const pr = Number(ref);
    if (
      !["start", "adopt", "send", "status", "log", "stop", "wait", "permit", "model"].includes(verb)
    ) {
      throw new Error("Unknown worker command");
    }
    if (verb === "status") {
      if (rest.length) {
        throw new Error("Usage: worker status [pr]");
      }
      const record = this.read(pr);
      return record ? this.render(record, await this.status(record)) : `#${pr} session unknown`;
    }
    return this.locked(pr, async () => {
      if (verb === "start") {
        return this.start(pr, rest);
      }
      if (verb === "adopt") {
        if (rest.length !== 1 || !/^[\w-]+$/.test(rest[0])) {
          throw new Error("Usage: worker adopt <pr> <session-id>");
        }
        return this.adopt(pr, rest[0]);
      }
      const record = this.read(pr);
      if (!record) {
        throw new Error(`No session recorded for PR #${pr}`);
      }
      const path = this.idPath(record);
      if (verb === "stop") {
        if (rest.length) {
          throw new Error("Usage: worker stop <pr>");
        }
        await this.interrupt(record);
        return `Interrupted ${record.id}`;
      }
      if (verb === "model") {
        const selected = rest[0];
        let approved = false,
          why = "owner-request";
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === "--owner-approved" && !approved) {
            approved = true;
          } else if (rest[i] === "--why" && rest[i + 1]) {
            why = rest[++i];
          } else {
            throw new Error("Usage: worker model <pr> <family> [--owner-approved] [--why reason]");
          }
        }
        const model = this.resolve(selected, approved);
        if (model.kind !== record.model.kind) {
          throw new Error("Cannot switch backend and retain context");
        }
        if (model.family === record.model.family && model.model === record.model.model) {
          await this.hooks.setModel(pr, model.family);
          return `Model unchanged for ${record.id}; PR Model synchronized`;
        }
        if (record.model.kind === "claude" && (await this.status(record, false)).active) {
          throw new Error("Stop the Claude turn before switching model");
        }
        const meta = await this.hooks.metadata(pr);
        if (model.kind === "opencode") {
          await this.client().request("POST", `${path}/model`, { model: this.apiModel(model) });
        }
        record.model = model;
        record.segments.push({
          family: model.family,
          model: model.model,
          rounds: [this.round(meta)],
          why,
          at: new Date(this.deps.now()).toISOString(),
        });
        this.save(record);
        await this.hooks.setModel(pr, model.family);
        return `Switched ${record.id} to ${model.family}`;
      }
      if (verb === "send") {
        if (
          rest.length < 1 ||
          rest.length > 2 ||
          (rest[1] && !["--queue", "--now"].includes(rest[1]))
        ) {
          throw new Error("Usage: worker send <pr> <file> [--queue|--now]");
        }
        const text = readFileSync(rest[0], "utf8");
        if (!text.trim()) {
          throw new Error("Empty prompt");
        }
        if (rest[1] === "--now") {
          const end = this.deps.now() + 30000;
          try {
            await this.interrupt(record, end);
            await this.idle(record, 30, end);
          } catch (error) {
            throw new Error(`Did not send: ${(error as Error).message}`, { cause: error });
          }
        } else if (record.model.kind === "claude") {
          if (rest[1] === "--queue") {
            await this.idle(record, 600);
          } else if ((await this.status(record, false)).active) {
            throw new Error("Session running: use --queue or --now; prompt not sent");
          }
        }
        await this.prompt(record, text, rest[1] === "--queue" ? "queue" : "steer");
        const meta = await this.hooks.metadata(pr);
        const round = this.round(meta);
        const segment = record.segments.at(-1)!;
        if (!segment.rounds.includes(round)) {
          segment.rounds.push(round);
        }
        this.save(record);
        return `Sent to ${record.id}`;
      }
      if (verb === "wait" || verb === "log") {
        const n = Number(rest[0] ?? (verb === "wait" ? 600 : 15));
        if (rest.length > 1 || !Number.isInteger(n) || n < 1 || n > 86400) {
          throw new Error("Expected a positive bounded integer");
        }
        if (verb === "wait") {
          return this.render(record, await this.idle(record, n));
        }
        if (record.model.kind === "claude") {
          return untrusted(this.redact(this.claudeLog(record).slice(-n).join("\n")));
        }
        return untrusted(
          this.redact(
            JSON.stringify(
              await this.client().request("GET", `${path}/message?limit=${n}`),
              null,
              2
            )
          )
        );
      }
      if (rest.length > 1 || (rest[0] && !["once", "always", "reject"].includes(rest[0]))) {
        throw new Error("Usage: worker permit <pr> [once|always|reject]");
      }
      if (record.model.kind === "claude") {
        throw new Error(
          "Claude uses owner-installed permission rules; no gateway permission requests"
        );
      }
      const requests = object(await this.client().request("GET", `${path}/permission`)).data;
      if (!Array.isArray(requests)) {
        throw new Error("Invalid permission response");
      }
      if (!rest[0]) {
        return untrusted(this.redact(JSON.stringify(requests)));
      }
      for (const request of requests) {
        const id = object(request).id;
        if (typeof id !== "string" || !/^[\w-]+$/.test(id)) {
          throw new Error("Invalid permission request id");
        }
        await this.client().request("POST", `${path}/permission/${id}/reply`, {
          decision: rest[0],
        });
      }
      return `Replied ${rest[0]} to ${requests.length} permission request(s)`;
    });
  }
  private apiModel(model: Model) {
    const [providerID, ...id] = model.model.split("/");
    return { providerID, id: id.join("/") };
  }
  async mergeStatus(pr: number): Promise<"live" | "stopped" | "unknown"> {
    const record = this.read(pr);
    if (!record) {
      return "unknown";
    }
    const status = await this.status(record, false);
    return status.reason === "session unknown"
      ? "unknown"
      : status.active || status.reason === "permission-wait"
        ? "live"
        : "stopped";
  }
  /** Read the recorded task session's activity without fetching GitHub comments. */
  async watchStatus(pr: number): Promise<WorkerSessionStatus> {
    const record = this.read(pr);
    return record ? this.status(record, false) : { reason: "session unknown", active: false };
  }
  async resume(pr: number, text: string): Promise<void> {
    await this.locked(pr, async () => {
      const record = this.read(pr);
      if (!record) {
        throw new Error(`No session recorded for PR #${pr}`);
      }
      await this.prompt(record, text);
    });
  }
  private async adopt(pr: number, id: string): Promise<string> {
    if (this.read(pr)) {
      throw new Error(`Session already recorded for PR #${pr}; refusing to overwrite history`);
    }
    const meta = await this.hooks.metadata(pr);
    if (meta.pr !== pr || meta.state !== "OPEN" || !meta.issue || meta.pointsOpen === undefined) {
      throw new Error("Adopt requires an open task PR with linked issue and opening Estimate");
    }
    const directory = await this.hooks.prepare(pr);
    const session = object(
      object(await this.client().request("GET", `/api/session/${encodeURIComponent(id)}`)).data
    );
    const sessionDirectory = session.directory ?? object(session.location).directory;
    if (
      session.id !== id ||
      typeof sessionDirectory !== "string" ||
      resolve(sessionDirectory) !== resolve(directory)
    ) {
      throw new Error("Session does not belong to the PR worktree");
    }
    const apiModel = object(session.model);
    const modelId =
      typeof session.model === "string"
        ? session.model
        : `${String(apiModel.providerID)}/${String(apiModel.id ?? apiModel.modelID)}`;
    const configured = this.models.find((m) => m.kind === "opencode" && m.model === modelId);
    const other = this.models.find((m) => m.kind === "opencode" && m.family === "other");
    const model =
      configured ??
      (other && /^[^/\s]+\/[^\s]+$/.test(modelId) && !modelId.includes("undefined")
        ? { ...other, model: modelId }
        : undefined);
    if (!model) {
      throw new Error("Cannot verify existing session model against models.yaml");
    }
    this.save({
      version: 1,
      repo: String(this.config.repo),
      pr,
      issue: meta.issue,
      directory,
      id,
      model,
      points_open: meta.pointsOpen,
      segments: [
        {
          family: model.family,
          model: model.model,
          rounds: [this.round(meta)],
          why: "adopt",
          at: new Date(this.deps.now()).toISOString(),
        },
      ],
    });
    await this.hooks.setModel(pr, model.family);
    return `Adopted ${id} for #${pr} on ${model.family}`;
  }
  private async adoptLegacy(): Promise<string> {
    const lines: string[] = [];
    const stateRoot = this.env.XDG_STATE_HOME ?? join(this.env.HOME ?? homedir(), ".local/state");
    for (const name of (this.config.legacyWorkers ?? []) as string[]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        throw new Error("Invalid legacyWorkers directory name");
      }
      const directory = join(
        stateRoot,
        `${name}${this.config.track ? `-${String(this.config.track)}` : ""}`
      );
      if (!existsSync(directory)) {
        continue;
      }
      for (const file of readdirSync(directory).sort()) {
        const match = /^([1-9]\d*)\.json$/.exec(file);
        if (!match || !Number.isSafeInteger(Number(match[1]))) {
          continue;
        }
        const pr = Number(match[1]);
        try {
          const legacy = object(JSON.parse(readFileSync(join(directory, file), "utf8")));
          const id = legacy.sessionId ?? legacy.id;
          if (
            typeof id !== "string" ||
            !/^[\w-]+$/.test(id) ||
            (legacy.pr !== undefined && legacy.pr !== pr) ||
            (legacy.repo !== undefined && legacy.repo !== this.config.repo)
          ) {
            throw new Error("Invalid legacy record");
          }
          lines.push(await this.command(["adopt", String(pr), id]));
        } catch {
          lines.push(`Skipped #${pr}: unverified legacy record or session already recorded`);
        }
      }
    }
    return lines.join("\n") || "No legacy worker records";
  }
  private async start(pr: number, flags: string[]): Promise<string> {
    let selected: string | undefined,
      approved = false,
      replace = false;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--model" && flags[i + 1] && selected === undefined) {
        selected = flags[++i];
      } else if (flags[i] === "--owner-approved" && !approved) {
        approved = true;
      } else if (flags[i] === "--replace" && !replace) {
        replace = true;
      } else {
        throw new Error(
          "Usage: worker start <pr> [--model family|provider/id] [--owner-approved] [--replace]"
        );
      }
    }
    const meta = await this.hooks.metadata(pr);
    if (!meta.draft || meta.state !== "OPEN") {
      throw new Error("Worker start requires an open draft task PR");
    }
    if (!meta.issue) {
      throw new Error("Task PR has no linked issue");
    }
    if (meta.blocked || /ON HOLD|\[HOLD:/i.test(meta.title + "\n" + meta.body)) {
      throw new Error("Task issue is blocked or on hold");
    }
    const model = this.resolve(selected ?? meta.model ?? "", approved);
    if (model.kind === "claude") {
      await this.hooks.workerIdentity();
    }
    const previous = this.read(pr);
    let unknown = false;
    if (previous) {
      unknown = (await this.status(previous, false)).reason === "session unknown";
      if (!unknown && !replace) {
        throw new Error("A live session already exists; use --replace");
      }
      if (!unknown) {
        await this.interrupt(previous);
        await this.idle(previous, 30);
      }
    }
    const points = previous?.points_open ?? meta.pointsOpen;
    if (points === undefined) {
      throw new Error(
        "Missing opening Estimate snapshot in task PR (points_open or Estimate header); refusing to substitute today's issue Estimate"
      );
    }
    const directory = await this.hooks.prepare(pr);
    const packagePath = join(directory, "package.json");
    const selfHosting =
      existsSync(packagePath) &&
      object(JSON.parse(readFileSync(packagePath, "utf8"))).name === "@vworlds/vmethod";
    if (selfHosting) {
      const env: NodeJS.ProcessEnv = { HUSKY: "0" };
      for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
        if (this.env[key]) {
          env[key] = this.env[key];
        }
      }
      await this.deps.exec("npm", ["ci"], { cwd: directory, env });
      await this.deps.exec("npm", ["run", "build"], { cwd: directory, env });
    }
    try {
      accessSync(
        join(directory, selfHosting ? "dist/vmethod.mjs" : "node_modules/.bin/vmethod"),
        selfHosting ? constants.R_OK : constants.X_OK
      );
    } catch {
      throw new Error(
        selfHosting
          ? "Missing built dist/vmethod.mjs in task worktree"
          : "Missing node_modules/.bin/vmethod; run npm ci in the task worktree"
      );
    }
    const response =
      model.kind === "opencode"
        ? object(
            object(
              await this.client().request("POST", "/api/session", {
                location: { directory },
                model: this.apiModel(model),
                title: meta.title,
              })
            ).data
          )
        : { id: randomUUID() };
    if (typeof response.id !== "string" || !/^[\w-]+$/.test(response.id)) {
      throw new Error("Server returned no valid session id");
    }
    const record: Session = {
      version: 1,
      repo: String(this.config.repo),
      pr,
      issue: meta.issue,
      directory,
      id: response.id,
      model,
      points_open: points,
      segments: [
        ...(previous?.segments ?? []),
        {
          family: model.family,
          model: model.model,
          rounds: [this.round(meta)],
          why: unknown ? "resume" : replace ? "owner-request" : "start",
          at: new Date(this.deps.now()).toISOString(),
        },
      ],
    };
    this.save(record);
    const amendment = meta.comments
      .filter((c) => c.role === "orchestrator" && c.body.startsWith("[orchestrator]"))
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
    const prompt = unknown
      ? `The PR description is your prompt: https://github.com/${String(this.config.repo)}/pull/${pr}\n\n${amendment?.body ?? "No orchestrator amendment."}`
      : meta.body;
    await this.prompt(record, prompt, "steer", false);
    await this.hooks.setModel(pr, model.family);
    return `Started ${record.id} for #${pr} on ${model.family}`;
  }
  async grade(pr: number, points?: number): Promise<string> {
    return this.locked(pr, async () => {
      const meta = await this.hooks.metadata(pr);
      if (!meta.issue) {
        throw new Error("Cannot grade: PR has no linked issue");
      }
      if (meta.state === "OPEN") {
        throw new Error("Grade requires a closed delivery PR");
      }
      const session = this.read(pr);
      if (!session || session.issue !== meta.issue) {
        throw new Error("Cannot grade: missing or mismatched delivery session history");
      }
      points ??= meta.estimate;
      if (points === undefined || ![0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999].includes(points)) {
        throw new Error("Invalid final Estimate");
      }
      const record = {
        date: new Date(this.deps.now()).toISOString().slice(0, 10),
        repo: this.config.repo,
        pr,
        task: meta.title,
        kind: meta.kind,
        segments: session.segments.map(({ family, model, rounds, why }) => ({
          family,
          model,
          rounds,
          why,
        })),
        points_open: session.points_open,
        points_final: points,
        rounds: this.round(meta),
        round_causes: [],
        outcome: meta.merged ? "merged" : "abandoned",
        prompt_defects: [],
        stalls: [],
        findings: [],
        notes: "",
      };
      const file = join(this.root, ".vmethod/model-log.jsonl");
      modelRecord(record);
      const records = existsSync(file)
        ? readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => object(JSON.parse(line)))
        : [];
      const prior = records.find((r) => r.repo === this.config.repo && r.pr === pr);
      if (prior && JSON.stringify({ ...prior, date: record.date }) !== JSON.stringify(record)) {
        throw new Error(
          "Delivery already graded with a different record; reconcile before regrading"
        );
      }
      await this.hooks.setEstimate(meta.issue, points);
      if (!prior) {
        mkdirSync(join(this.root, ".vmethod"), { recursive: true });
        appendFileSync(file, JSON.stringify(record) + "\n");
      }
      return `Graded PR #${pr}: issue #${meta.issue} Estimate ${points}`;
    });
  }
  async suggest(issue: number): Promise<string> {
    const meta = await this.hooks.issue(issue);
    const wanted =
      /architecture|security|design/i.test(meta.kind) || (meta.estimate ?? 0) >= 13 ? "sol" : "glm";
    const model = this.models.find((m) => m.family === wanted);
    if (!model) {
      throw new Error(`Suggested family ${wanted} is not configured`);
    }
    const file = join(this.root, "learnings/models", `${model.family}.md`);
    const lesson = existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .find((line) => line.trim() && !line.startsWith("#"))
      : "Shared model learnings not available locally yet";
    return `${model.family}: Estimate ${meta.estimate ?? "unset"}, kind ${meta.kind}; gate ${model.gate}${model.gate === "owner" ? " (requires --owner-approved)" : ""}\n${untrusted(lesson ?? "No matching learning")}`;
  }
}
