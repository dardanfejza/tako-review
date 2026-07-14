import type { Timing, TelemetryBeacon, TelemetryEvent, ErrorKind } from '../types/api';

/**
 * Shape of WebLLM's `usage` on the final streamed chunk (with `stream_options.include_usage`).
 * Timing fields live under `.extra` in SECONDS (FE §4.7). Exact key names are verified against
 * the pinned web-llm@0.2.84 build (manual checklist) — mapUsage is defensive about absence.
 */
export interface WebLLMUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  extra?: {
    e2e_latency_s?: number;
    time_to_first_token_s?: number;
    decode_tokens_per_s?: number;
    prefill_tokens_per_s?: number;
    time_per_output_token_s?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Seconds→milliseconds converter that PRESERVES absence: an absent seconds value maps to
 * `undefined`, NOT `0`. Encoding "unknown" as `0` would beacon a missing measurement as a
 * zero-latency success, polluting the inference percentiles — `_inference` filters `IS NULL`
 * but not `> 0` (review §4 "missing timing encoded as 0"). Returning `undefined` lets `mapUsage`
 * OMIT the field so the wire JSON carries no key and the backend skips it.
 */
const toMs = (seconds: number | undefined): number | undefined =>
  seconds === undefined ? undefined : Math.round(seconds * 1000);

/**
 * The single seconds→milliseconds converter (FE §4.7) — the badge display and the telemetry
 * beacon both go through this so they never drift. `load_ms` is measured separately (wrapped
 * around engine creation) and is 0 on a warm/cached engine. Timing fields WebLLM did not report
 * are omitted (not zeroed) so a missing measurement is distinguishable from an instant one.
 */
export function mapUsage(usage: WebLLMUsage | undefined, loadMs: number): Timing {
  const extra = usage?.extra ?? {};
  const ttft_ms = toMs(extra.time_to_first_token_s);
  const total_ms = toMs(extra.e2e_latency_s);
  // tok/s is reported per-second already; round to 1 decimal for display stability. Absent →
  // omit (an unknown decode rate must not enter the percentiles as 0).
  const tok_per_sec =
    extra.decode_tokens_per_s === undefined
      ? undefined
      : Math.round(extra.decode_tokens_per_s * 10) / 10;
  return {
    load_ms: Math.round(loadMs),
    ...(ttft_ms !== undefined ? { ttft_ms } : {}),
    ...(total_ms !== undefined ? { total_ms } : {}),
    tokens_prompt: usage?.prompt_tokens ?? extra.prompt_tokens ?? 0,
    tokens_completion: usage?.completion_tokens ?? extra.completion_tokens ?? 0,
    ...(tok_per_sec !== undefined ? { tok_per_sec } : {}),
  };
}

export interface BeaconInput {
  event: TelemetryEvent;
  client_id: string;
  code_hash?: string | null;
  webgpu_supported: boolean;
  device_class?: string | null;
  browser?: string | null;
  metrics: {
    load_ms?: number;
    ttft_ms?: number;
    tok_per_sec?: number;
    total_ms?: number;
    cache_hit?: boolean;
    /** generation only: chunks attempted on a CHUNKED (map/reduce) run — success or all-failed. */
    chunks?: number;
    /** funnel_stage only: which funnel stage this beacon marks (backend allowlist: 'visit'). */
    stage?: 'visit';
    ok: boolean;
  };
  error_kind?: ErrorKind | null;
  ts?: string;
}

/**
 * Build a wire TelemetryBeacon from whitelisted fields ONLY (API §5.5 / §6 invariant #2/#3):
 * model_version/prompt_version are excluded (would trip extra='forbid'), and raw code never
 * appears — only the opaque `code_hash`. Constructing explicitly is the structural guarantee.
 */
export function buildBeacon(input: BeaconInput): TelemetryBeacon {
  return {
    event: input.event,
    client_id: input.client_id,
    code_hash: input.code_hash ?? null,
    webgpu_supported: input.webgpu_supported,
    device_class: input.device_class ?? null,
    browser: input.browser ?? null,
    metrics: input.metrics,
    error_kind: input.error_kind ?? null,
    ts: input.ts,
  };
}

/** localStorage pref — when set, the collector emits nothing (FE §12). */
export const TELEMETRY_OPT_OUT_KEY = 'tako.telemetry_opt_out';

export function isTelemetryOptedOut(): boolean {
  try {
    return localStorage.getItem(TELEMETRY_OPT_OUT_KEY) === 'true';
  } catch {
    // Storage unavailable (Safari Private Browsing) → treat as not opted out; the beacon still
    // honors the absent flag and stays fire-and-forget. Never let a storage error break the app.
    return false;
  }
}

/**
 * Fire-and-forget beacon to POST /api/telemetry via navigator.sendBeacon (auth='none', API §5.5).
 * Honors the opt-out, swallows all errors (telemetry must never break the app), and never
 * establishes a guest session just to beacon (FE §8.D). Returns whether a beacon was queued.
 */
export function sendTelemetryBeacon(beacon: TelemetryBeacon): boolean {
  if (isTelemetryOptedOut()) return false;
  try {
    const blob = new Blob([JSON.stringify(beacon)], { type: 'application/json' });
    return navigator.sendBeacon('/api/telemetry', blob);
  } catch {
    return false;
  }
}
