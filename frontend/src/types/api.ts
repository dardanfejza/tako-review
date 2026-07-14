/**
 * Wire DTOs — the single front-end mirror of `docs/architecture/api-contract.md` §5.
 * snake_case to match the JSON on the wire. Do not add fields the contract does not define
 * (the backend uses Pydantic `extra='forbid'`).
 */

export type ReviewMode = 'explain' | 'bugs' | 'security' | 'style';
export type Rating = 'up' | 'down';
export type ReasonTag = 'inaccurate' | 'too_vague' | 'wrong_language' | 'hallucinated';
export type UiLanguage = 'en' | 'ja';
export type TelemetryEvent = 'model_load' | 'generation' | 'webgpu_probe' | 'funnel_stage' | 'error';
/** Mirror of backend `ErrorKind` (schemas/telemetry.py). `cdn`/`quota`/`other` classify model_load
 *  failures (metrics gap #1: the cause was UI-only); `cancelled` marks user cancels — a cancel is
 *  NOT an error and is excluded from failure ratios server-side. */
export type ErrorKind =
  | 'no_webgpu'
  | 'no_adapter'
  | 'device_lost'
  | 'oom'
  | 'generation'
  | 'cdn'
  | 'quota'
  | 'other'
  | 'cancelled';

/** The closed whitelist of feedback reason tags (API §5.4). */
export const REASON_TAGS: readonly ReasonTag[] = [
  'inaccurate',
  'too_vague',
  'wrong_language',
  'hallucinated',
];

/**
 * Wire timing object — milliseconds, produced by `mapUsage()` from WebLLM seconds (FE §4.7).
 * `ttft_ms`, `total_ms` and `tok_per_sec` are OPTIONAL: when WebLLM reports no `usage` for a
 * generation, `mapUsage` OMITS them rather than fabricating `0`, so a missing measurement stays
 * distinguishable from a genuine instant one. The backend `_inference` aggregation skips absent
 * (`IS NULL`) fields per-field, keeping zero-latency phantom rows out of the p50/p95/p99
 * percentiles (metrics §; review §4 "missing timing encoded as 0"). `load_ms` is always present
 * (measured separately around engine creation; `0` on a warm/cached engine). Display consumers
 * (TimingBadge) must tolerate `undefined` (coalesce to 0).
 */
export interface Timing {
  load_ms: number;
  ttft_ms?: number;
  total_ms?: number;
  tokens_prompt: number;
  tokens_completion: number;
  tok_per_sec?: number;
}

/** GET /api/auth/me, POST /api/auth/guest, PATCH /api/auth/me responses. */
export interface MeResponse {
  id: string;
  is_guest: boolean;
  display_name: string;
  email: string | null;
  ui_language: UiLanguage | null;
  /** Server-side MIRROR of the localStorage opt-out (`tako.telemetry_opt_out`) for signed-in
   *  users. Enforcement stays the synchronous localStorage read (lib/telemetry.ts); on login the
   *  server value is reconciled INTO localStorage (server wins). Optional so payloads/fixtures
   *  predating the field stay valid — absent means "nothing to reconcile". */
  telemetry_opt_out?: boolean;
}

/** PATCH /api/auth/me body — PARTIAL profile update: send only the field(s) being changed. */
export interface ProfileUpdate {
  ui_language?: UiLanguage | null;
  telemetry_opt_out?: boolean;
}

/** POST /api/reviews request body (API §5.3). */
export interface ReviewCreate {
  code_text: string;
  filename?: string | null;
  language: string;
  review_mode: ReviewMode;
  model_version: string;
  prompt_version: string;
  code_hash: string;
  review_output: string;
  timing: Timing;
  client_id?: string | null;
  device_class?: string | null;
}

export interface ReviewFeedback {
  rating: Rating;
  reason_tags: ReasonTag[];
}

/** Full record returned by GET/POST /api/reviews{,/:id} (API §5.3). */
export interface ReviewDetail {
  id: string;
  user_id: string;
  created_at: string;
  title: string;
  language: string;
  review_mode: ReviewMode;
  model_version: string;
  prompt_version: string;
  code_text: string;
  code_hash: string;
  review_output: string;
  timing: Timing;
  client_id: string | null;
  device_class: string | null;
  feedback: ReviewFeedback | null;
}

/** Lightweight list projection (no code_text/review_output) (API §5.3). `title` is the code-derived
 *  header; `snippet`/`code_bytes`/`line_count` are derived server-side for the richer history row. */
export interface ReviewListItem {
  id: string;
  title: string;
  review_mode: ReviewMode;
  language: string;
  created_at: string;
  snippet: string;
  code_bytes: number;
  line_count: number;
}

export interface ReviewListPage {
  items: ReviewListItem[];
  next_cursor: string | null;
}

export interface FeedbackCreate {
  session_id: string;
  rating: Rating;
  reason_tags: ReasonTag[];
}

export interface FeedbackResponse {
  id: string;
  session_id: string;
  rating: Rating;
  created_at: string;
}

/** POST /api/telemetry beacon (API §5.5). NOTE: no model_version/prompt_version (extra='forbid'). */
export interface TelemetryBeacon {
  event: TelemetryEvent;
  client_id: string;
  code_hash: string | null;
  webgpu_supported: boolean;
  device_class: string | null;
  browser: string | null;
  metrics: {
    load_ms?: number;
    ttft_ms?: number;
    tok_per_sec?: number;
    total_ms?: number;
    /** model_load only: whether the load resolved from the cached weights (no cold download). */
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

/** RFC 9457 application/problem+json error body (API §3). */
export interface ProblemDetail {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  instance?: string;
  correlation_id?: string;
  errors?: { field: string; msg: string }[];
}
