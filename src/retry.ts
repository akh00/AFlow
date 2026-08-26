/**
 * §11 retry resolution.
 *
 * `inline` retries happen within the evaluation. `offline` retries are not
 * scheduled by the engine — an effect that resolves to `offline` parks the
 * evaluation as `suspended` with a `next_retry_at`, which is the contract the
 * OpenAPI `Suspension` describes.
 */

import { WorkflowDefinitionError, type WorkflowError } from "./runtime.js";
import type { RetryConfig, RetryTier } from "./types.js";

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse `"5m"`, `"500ms"`, `"1h"`, or a bare number of milliseconds. */
export function parseDuration(v: string | number | undefined): number {
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(v);
  if (!m) throw new WorkflowDefinitionError(`unparseable duration: ${v}`);
  return Number(m[1]) * UNITS[m[2] ?? "ms"];
}

export type RetryDecision =
  | { kind: "give_up" }
  | { kind: "inline"; delayMs: number }
  | { kind: "offline"; delayMs: number };

function tierAllows(tier: RetryTier | undefined, attempts: number): boolean {
  return (tier?.max_count ?? 0) > attempts;
}

/**
 * Reduce the retry type an effect requested to a basic decision, given the
 * task config and how many attempts of each tier have already been made.
 */
export function resolveRetry(
  requested: WorkflowError["retry_type"] | undefined,
  config: RetryConfig | undefined,
  attempts: { inline: number; offline: number },
): RetryDecision {
  if (!requested || !config) return { kind: "give_up" };

  const wantsInline = requested === "inline" || requested === "inline_then_offline";
  const wantsOffline = requested === "offline" || requested === "inline_then_offline";

  if (wantsInline && tierAllows(config.inline, attempts.inline)) {
    return { kind: "inline", delayMs: parseDuration(config.inline?.interval) };
  }
  if (wantsOffline && tierAllows(config.offline, attempts.offline)) {
    const base = parseDuration(config.offline?.interval) || 1_000;
    const max = parseDuration(config.offline?.max_interval) || base * 64;
    // Exponential growth up to max_interval (§11).
    return {
      kind: "offline",
      delayMs: Math.min(base * 2 ** attempts.offline, max),
    };
  }
  return { kind: "give_up" };
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
