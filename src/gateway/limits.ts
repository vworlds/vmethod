import type { Config } from "../config.js";
import { object } from "./people.js";

/** Validated quota windows from the optional oc-limits RPC. Missing timing stays unknown. */
interface LimitWindow {
  id: string;
  remainingPercent: number;
  resetsAt?: string;
  windowSeconds?: number;
  slack?: number;
  model?: string;
}
export interface ProviderLimits {
  provider: string;
  windows: LimitWindow[];
  atRisk: boolean;
}
export interface LimitModel {
  family: string;
  model: string;
  provider?: string;
  gate: string;
}

export function limitsConfig(config: Config): {
  enabled: boolean;
  atRisk: number;
  pollSeconds: number;
} {
  return { enabled: true, atRisk: 15, pollSeconds: 300, ...object(config.limits) };
}

export function modelProvider(model: Pick<LimitModel, "model" | "provider">): string {
  return model.provider ?? model.model.split("/")[0];
}

/** Decode usable reported windows; missing timing stays unknown and expired/invalid windows are ignored. */
export function decodeLimits(value: unknown, now: number, atRisk = 15): ProviderLimits[] {
  const providers = object(value).providers;
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers.flatMap((entry) => {
    const provider = object(entry);
    if (
      provider.status !== "ok" ||
      typeof provider.providerID !== "string" ||
      !/^[A-Za-z0-9_.-]+$/.test(provider.providerID) ||
      !Array.isArray(provider.windows)
    ) {
      return [];
    }
    const windows = provider.windows.flatMap((entry): LimitWindow[] => {
      const window = object(entry);
      if (
        typeof window.id !== "string" ||
        !/^[A-Za-z0-9_.-]+$/.test(window.id) ||
        typeof window.remainingPercent !== "number" ||
        !Number.isFinite(window.remainingPercent) ||
        window.remainingPercent < 0 ||
        window.remainingPercent > 100
      ) {
        return [];
      }
      const reset = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN;
      if (Number.isFinite(reset) && reset <= now) {
        return [];
      }
      const seconds =
        typeof window.windowSeconds === "number" &&
        Number.isFinite(window.windowSeconds) &&
        window.windowSeconds > 0
          ? window.windowSeconds
          : undefined;
      const elapsed =
        seconds && Number.isFinite(reset)
          ? Math.max(0, Math.min(100, 100 * (1 - (reset - now) / (seconds * 1000))))
          : undefined;
      return [
        {
          id: window.id,
          remainingPercent: window.remainingPercent,
          ...(window.scope === "model" &&
          typeof window.model === "string" &&
          /^[A-Za-z0-9_. -]+$/.test(window.model)
            ? { model: window.model }
            : {}),
          ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
          ...(seconds ? { windowSeconds: seconds } : {}),
          ...(elapsed === undefined ? {} : { slack: window.remainingPercent - elapsed }),
        },
      ];
    });
    // The adapter orders windows shortest first when it cannot supply durations.
    windows.sort((a, b) =>
      a.windowSeconds && b.windowSeconds ? a.windowSeconds - b.windowSeconds : 0
    );
    return windows.length
      ? [{ provider: provider.providerID, windows, atRisk: windows[0].remainingPercent < atRisk }]
      : [];
  });
}

/** Informational family summary shared by CLI, launch advice and worker models. */
export function limitSummary(model: LimitModel, readings: ProviderLimits[]): string {
  const provider = modelProvider(model);
  const reading = readings.find((r) => r.provider === provider);
  return `${model.family}: ${provider} ${reading ? reading.windows.map((w) => `${w.id}${w.model ? ` (${w.model})` : ""} ${w.remainingPercent}%${w.resetsAt ? ` resets ${w.resetsAt}` : ""}${w.slack === undefined ? "" : ` slack ${w.slack >= 0 ? "+" : ""}${w.slack.toFixed(1)}${w.slack > 0 ? " (expiring unused)" : ""}`}`).join("; ") + (reading.atRisk ? "; at risk" : "") : "unknown"}${model.gate === "owner" ? "; owner-gated" : ""}`;
}

/** Emit each observed risk transition once; unknown readings never invent recovery. */
export class QuotaCrossings {
  private readonly risky: Set<string>;
  constructor(risky: readonly string[] = []) {
    this.risky = new Set(risky);
  }
  update(
    readings: ProviderLimits[],
    workers: { pr: number; family: string; provider: string }[]
  ): string[] {
    const lines: string[] = [];
    for (const reading of readings) {
      const affected = workers.filter((w) => w.provider === reading.provider);
      if (!affected.length && !this.risky.has(reading.provider)) {
        continue;
      }
      const window = reading.windows[0];
      if (reading.atRisk && !this.risky.has(reading.provider) && affected.length) {
        this.risky.add(reading.provider);
        lines.push(
          `QUOTA ${reading.provider} ${window.id} ${window.remainingPercent}% left (resets ${window.resetsAt ?? "unknown"}); at risk: ${affected.map((w) => `#${w.pr} (${w.family})`).join(", ")}`
        );
      } else if (!reading.atRisk && this.risky.delete(reading.provider)) {
        lines.push(
          `QUOTA ${reading.provider} recovered (${window.id} ${window.remainingPercent}%)`
        );
      }
    }
    return lines;
  }
  /** Persist observed crossings across watcher restarts. */
  snapshot(): string[] {
    return [...this.risky];
  }
}
