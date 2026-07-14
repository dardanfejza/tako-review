/**
 * Stamped onto every history + telemetry review record (API §5.3, FE §4.2) — the OODA / A-B
 * substrate. Required on POST /api/reviews; EXCLUDED from the telemetry beacon (extra='forbid').
 * MODEL_VERSION is a provenance stamp only — recorded on each review (reviewPipeline.ts); it does
 * not itself drive any re-download or cache-invalidation UX.
 */
export const MODEL_VERSION = 'Qwen2.5-Coder-1.5B@q4f32_1-MLC';
export const PROMPT_VERSION = 'review-v2';
