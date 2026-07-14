import { useEffect, useRef } from 'react';
import { useTelemetry, useVisitBeacon } from './useTelemetry';
import type { ReviewState } from '../reducers/reviewMachine';
import type { ReviewDraft } from '../inference/reviewPipeline';
import type { DownloadErrorKind, GenFailureDetail } from '../providers/EngineProvider';

/**
 * Emits the `model_load` + `generation` telemetry beacons (FE §12) off the review state machine —
 * completing the funnel signal (CURRENT previously beaconed only `webgpu_probe`). The
 * `model_load` (ok/fail/cancel) and generation failure/cancel beacons are keyed on the PREVIOUS
 * state, so re-entering READY via NEW_REVIEW (RESULT→READY) never re-beacons a model load.
 *
 * Cancel semantics (metrics F4): a user cancel (DL_CANCELLED / REVIEW_CANCELLED) beacons
 * `ok:false` with `error_kind:'cancelled'` — the backend EXCLUDES 'cancelled' from failure
 * counts/ratios, so a cancel is observable without ever reading as an error.
 *
 * The generation-SUCCESS beacon is keyed on the DRAFT arriving (null→set while in RESULT), NOT on
 * the REVIEWING→RESULT transition: EngineProvider dispatches GEN_COMPLETE (→RESULT) one render
 * BEFORE the workspace sets `draft`, so a transition-keyed beacon would fire with a null code_hash
 * and undefined timing. Keying on arrival guarantees the real perf payload. It still carries
 * the opaque `code_hash` only — never raw code (the no-raw-code invariant, API §5.5 / backend.md §10.6).
 */
export function useReviewTelemetry(params: {
  state: ReviewState;
  draft: ReviewDraft | null;
  deviceClass: string | null;
  webgpuSupported: boolean;
  /** Measured model-load time (ms) from EngineProvider; carried on the model_load ok beacon. */
  loadMs: number;
  /** Whether the completed load was cache-served (engine.loadProgress?.cacheHit). `undefined`
   *  (unknown — the loader reported no cache signal) is OMITTED from the beacon, NEVER coerced
   *  to false, so the warm/cold split stays honest (metrics F1: cache_hit ∈ true/false/unknown). */
  cacheHit?: boolean;
  /** Classified cause of the most recent load failure (engine.downloadErrorKind). Beaconed as
   *  error_kind on the model_load failure beacon; null (unclassified) maps to 'other'. */
  downloadErrorKind?: DownloadErrorKind | null;
  /** Failure detail from EngineProvider: `chunksAttempted` present only when EVERY chunk of a
   *  chunked run failed — beaconed as `metrics.chunks` on the generation failure beacon. */
  lastGenFailure?: GenFailureDetail | null;
  /** Chunks attempted by the most recent successful CHUNKED run (engine.lastGenChunks); null for
   *  single-shot runs → `metrics.chunks` omitted on the success beacon. */
  lastGenChunks?: number | null;
}): void {
  const { state, draft, deviceClass, webgpuSupported, loadMs } = params;
  const { cacheHit, downloadErrorKind, lastGenFailure, lastGenChunks } = params;
  const beacon = useTelemetry();
  // The visit funnel producer lives here because this hook's mount is unconditional on the
  // workspace page — it counts visitors who bounce before the probe resolves (metrics F2 'visit').
  useVisitBeacon();
  const prevStateRef = useRef<ReviewState>(state);
  const prevDraftRef = useRef<ReviewDraft | null>(draft);

  // Identity (webgpu_supported / device_class / load_ms / cache_hit / failure detail) refreshed
  // every render. The transition effect below intentionally lists only `[state]` (exhaustive-deps
  // disabled) so it fires once per state change — but that means its CLOSURE can lag the live
  // identity if the probe resolves in a commit where `state` didn't change. Reading identity from
  // this ref at fire time decouples the beacon payload from the effect's stale closure.
  const idRef = useRef({
    webgpuSupported,
    deviceClass,
    loadMs,
    cacheHit,
    downloadErrorKind,
    lastGenFailure,
    lastGenChunks,
  });
  idRef.current = {
    webgpuSupported,
    deviceClass,
    loadMs,
    cacheHit,
    downloadErrorKind,
    lastGenFailure,
    lastGenChunks,
  };

  // State-transition beacons: model_load ok/fail/cancel + generation failure/cancel (no draft).
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (prev === state) return;
    const { webgpuSupported: sup, deviceClass: dc, loadMs: ms } = idRef.current;
    const { cacheHit: hit, downloadErrorKind: cause, lastGenFailure: fail } = idRef.current;
    const id = { webgpu_supported: sup, device_class: dc };

    if (prev === 'DOWNLOADING' && state === 'READY') {
      // cache_hit: undefined means the loader reported no cache signal — omit (never false).
      beacon({
        event: 'model_load',
        ...id,
        metrics: { ok: true, load_ms: ms, ...(hit !== undefined ? { cache_hit: hit } : {}) },
      });
    } else if (prev === 'DOWNLOADING' && state === 'DOWNLOAD_ERROR') {
      // The classified cause (gap #1: previously `{ok:false}` with no cause at all).
      beacon({ event: 'model_load', ...id, metrics: { ok: false }, error_kind: cause ?? 'other' });
    } else if (prev === 'DOWNLOADING' && state === 'DL_CANCELLED') {
      // A user cancel is NOT an error — 'cancelled' is excluded from failure ratios.
      beacon({ event: 'model_load', ...id, metrics: { ok: false }, error_kind: 'cancelled' });
    } else if (prev === 'REVIEWING' && state === 'REVIEW_ERROR') {
      // All-chunks-failed runs carry the attempted chunk count; other failures omit `chunks`.
      const chunks = fail?.chunksAttempted;
      beacon({
        event: 'generation',
        ...id,
        metrics: { ok: false, ...(chunks !== undefined ? { chunks } : {}) },
        error_kind: 'generation',
      });
    } else if (prev === 'REVIEWING' && state === 'REVIEW_CANCELLED') {
      // Cancel beacon carries NO timings — a partial run's numbers must not enter the percentiles.
      beacon({ event: 'generation', ...id, metrics: { ok: false }, error_kind: 'cancelled' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on `state` change; identity from idRef
  }, [state]);

  // Generation-success beacon: fire when the draft arrives (null→set) in RESULT, so the payload
  // (code_hash + timing) is always present despite the draft lagging the RESULT transition.
  useEffect(() => {
    const prevDraft = prevDraftRef.current;
    prevDraftRef.current = draft;
    if (draft && !prevDraft && state === 'RESULT') {
      // Chunked runs additionally carry the attempted chunk count (single-shot → omitted).
      const chunks = idRef.current.lastGenChunks;
      beacon({
        event: 'generation',
        webgpu_supported: idRef.current.webgpuSupported,
        device_class: idRef.current.deviceClass,
        code_hash: draft.code_hash,
        metrics: {
          load_ms: draft.timing.load_ms,
          ttft_ms: draft.timing.ttft_ms,
          tok_per_sec: draft.timing.tok_per_sec,
          total_ms: draft.timing.total_ms,
          ...(chunks != null ? { chunks } : {}),
          ok: true,
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on draft arrival; read latest id
  }, [draft, state]);
}
