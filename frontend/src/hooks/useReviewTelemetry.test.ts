import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReviewTelemetry } from './useReviewTelemetry';
import { VISIT_BEACON_KEY } from './useTelemetry';
import { sendTelemetryBeacon } from '../lib/telemetry';
import type { ReviewState } from '../reducers/reviewMachine';
import type { ReviewDraft } from '../inference/reviewPipeline';
import type { DownloadErrorKind, GenFailureDetail } from '../providers/EngineProvider';

vi.mock('../lib/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry')>();
  return { ...actual, sendTelemetryBeacon: vi.fn(() => true) };
});

const sent = vi.mocked(sendTelemetryBeacon);

const DRAFT = {
  code_hash: 'hash-abc',
  timing: { load_ms: 11, ttft_ms: 22, total_ms: 44, tokens_prompt: 5, tokens_completion: 6, tok_per_sec: 33 },
} as ReviewDraft;

type Props = {
  state: ReviewState;
  draft: ReviewDraft | null;
  loadMs?: number;
  cacheHit?: boolean;
  downloadErrorKind?: DownloadErrorKind | null;
  lastGenFailure?: GenFailureDetail | null;
  lastGenChunks?: number | null;
};

function renderWith(initial: Props) {
  return renderHook(
    (p: Props) => useReviewTelemetry({ deviceClass: 'dc', webgpuSupported: true, loadMs: 0, ...p }),
    { initialProps: initial },
  );
}

// Full-prop variant: identity (deviceClass/webgpuSupported) can be supplied per render so we can
// model the probe resolving in the SAME commit that flips the state to READY.
type FullProps = Props & {
  deviceClass: string | null;
  webgpuSupported: boolean;
};

function renderWithFull(initial: FullProps) {
  return renderHook((p: FullProps) => useReviewTelemetry({ loadMs: 0, ...p }), {
    initialProps: initial,
  });
}

describe('useReviewTelemetry (model_load + generation beacons — FE §12)', () => {
  beforeEach(() => {
    sent.mockClear();
    // Suppress the once-per-session visit producer (tested in useTelemetry.test.ts) so these
    // assertions see ONLY the state-machine beacons.
    sessionStorage.setItem(VISIT_BEACON_KEY, 'true');
  });

  it('beacons model_load ok with load_ms on DOWNLOADING→READY (cache_hit OMITTED when unknown)', () => {
    const { rerender } = renderWith({ state: 'DOWNLOADING', draft: null, loadMs: 1234 });
    expect(sent).not.toHaveBeenCalled();
    rerender({ state: 'READY', draft: null, loadMs: 1234 });
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0]).toMatchObject({
      event: 'model_load',
      metrics: { ok: true, load_ms: 1234 },
    });
    // Unknown cache state must be OMITTED, never coerced to false (true/false/unknown).
    expect(sent.mock.calls[0]![0].metrics).not.toHaveProperty('cache_hit');
  });

  it.each([true, false] as const)(
    'model_load ok carries cache_hit=%s when the load reported a cache signal',
    (hit) => {
      const { rerender } = renderWith({ state: 'DOWNLOADING', draft: null, loadMs: 50, cacheHit: hit });
      rerender({ state: 'READY', draft: null, loadMs: 50, cacheHit: hit });
      expect(sent).toHaveBeenCalledOnce();
      expect(sent.mock.calls[0]![0].metrics).toMatchObject({ ok: true, load_ms: 50, cache_hit: hit });
    },
  );

  it('beacons generation ok on REVIEWING→RESULT with timing + opaque code_hash (no raw code)', () => {
    const { rerender } = renderWith({ state: 'REVIEWING', draft: null });
    rerender({ state: 'RESULT', draft: DRAFT });
    expect(sent).toHaveBeenCalledOnce();
    const b = sent.mock.calls[0]![0];
    expect(b).toMatchObject({
      event: 'generation',
      code_hash: 'hash-abc',
      metrics: { ok: true, load_ms: 11, ttft_ms: 22, tok_per_sec: 33, total_ms: 44 },
    });
    expect(JSON.stringify(b)).not.toContain('code_text');
    // Single-shot run (no lastGenChunks) → no chunks key on the success beacon.
    expect(b.metrics).not.toHaveProperty('chunks');
  });

  it('generation ok carries metrics.chunks on a CHUNKED run (lastGenChunks from EngineProvider)', () => {
    const { rerender } = renderWith({ state: 'REVIEWING', draft: null, lastGenChunks: null });
    rerender({ state: 'RESULT', draft: DRAFT, lastGenChunks: 4 });
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0].metrics).toMatchObject({ ok: true, chunks: 4 });
  });

  it('beacons generation failure on REVIEWING→REVIEW_ERROR (no chunks for a non-chunked failure)', () => {
    const { rerender } = renderWith({ state: 'REVIEWING', draft: null, lastGenFailure: null });
    rerender({ state: 'REVIEW_ERROR', draft: null, lastGenFailure: {} });
    expect(sent.mock.calls[0]![0]).toMatchObject({
      event: 'generation',
      metrics: { ok: false },
      error_kind: 'generation',
    });
    expect(sent.mock.calls[0]![0].metrics).not.toHaveProperty('chunks');
  });

  it('generation failure carries metrics.chunks when EVERY chunk failed (AllChunksFailedError)', () => {
    const { rerender } = renderWith({ state: 'REVIEWING', draft: null, lastGenFailure: null });
    rerender({ state: 'REVIEW_ERROR', draft: null, lastGenFailure: { chunksAttempted: 8 } });
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0]).toMatchObject({
      event: 'generation',
      metrics: { ok: false, chunks: 8 },
      error_kind: 'generation',
    });
  });

  it.each([
    ['cdn', 'cdn'],
    ['quota', 'quota'],
    ['other', 'other'],
    [null, 'other'], // unclassified → 'other', never a missing cause again (gap #1)
  ] as const)(
    'model_load failure beacons error_kind=%s→%s on DOWNLOADING→DOWNLOAD_ERROR',
    (kind, expected) => {
      const { rerender } = renderWith({ state: 'DOWNLOADING', draft: null, downloadErrorKind: kind });
      rerender({ state: 'DOWNLOAD_ERROR', draft: null, downloadErrorKind: kind });
      expect(sent).toHaveBeenCalledOnce();
      expect(sent.mock.calls[0]![0]).toMatchObject({
        event: 'model_load',
        metrics: { ok: false },
        error_kind: expected,
      });
    },
  );

  it('beacons model_load error_kind=cancelled on DOWNLOADING→DL_CANCELLED (a cancel is NOT an error)', () => {
    const { rerender } = renderWith({ state: 'DOWNLOADING', draft: null, downloadErrorKind: null });
    rerender({ state: 'DL_CANCELLED', draft: null, downloadErrorKind: null });
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0]).toMatchObject({
      event: 'model_load',
      metrics: { ok: false },
      error_kind: 'cancelled', // backend EXCLUDES 'cancelled' from failure counts/ratios
    });
  });

  it('beacons generation error_kind=cancelled with NO timings on REVIEWING→REVIEW_CANCELLED', () => {
    const { rerender } = renderWith({ state: 'REVIEWING', draft: null });
    rerender({ state: 'REVIEW_CANCELLED', draft: null });
    expect(sent).toHaveBeenCalledOnce();
    const b = sent.mock.calls[0]![0];
    expect(b).toMatchObject({ event: 'generation', metrics: { ok: false }, error_kind: 'cancelled' });
    // A cancelled partial run's numbers must never enter the inference percentiles.
    expect(b.metrics).not.toHaveProperty('ttft_ms');
    expect(b.metrics).not.toHaveProperty('total_ms');
    expect(b.metrics).not.toHaveProperty('tok_per_sec');
    expect(b.metrics).not.toHaveProperty('load_ms');
  });

  it('does NOT re-beacon model_load when READY is re-entered via NEW_REVIEW (RESULT→READY)', () => {
    const { rerender } = renderWith({ state: 'RESULT', draft: DRAFT });
    rerender({ state: 'READY', draft: null });
    expect(sent).not.toHaveBeenCalled();
  });

  it('model_load carries the LIVE identity when the probe resolves in the READY commit', () => {
    // Production ordering: the capability probe (deviceClass / webgpuSupported) can resolve in the
    // SAME render that flips DOWNLOADING→READY. A beacon that read identity from a stale closure
    // would fire with the prior null/false values; it must read the live identity.
    const { rerender } = renderWithFull({
      state: 'DOWNLOADING',
      draft: null,
      deviceClass: null,
      webgpuSupported: false,
      loadMs: 1234,
    });
    expect(sent).not.toHaveBeenCalled();
    rerender({
      state: 'READY',
      draft: null,
      deviceClass: 'webgpu;chrome',
      webgpuSupported: true,
      loadMs: 1234,
    });
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0]).toMatchObject({
      event: 'model_load',
      device_class: 'webgpu;chrome',
      webgpu_supported: true,
      metrics: { ok: true, load_ms: 1234 },
    });
  });

  it('beacons generation ok when the draft ARRIVES (one render after RESULT), never empty', () => {
    // Production ordering: EngineProvider dispatches GEN_COMPLETE (→RESULT) one render BEFORE
    // ReviewWorkspace's setDraft(d) runs. A beacon keyed on the bare REVIEWING→RESULT transition
    // would fire here with code_hash=null + undefined timing — gutting the perf signal. It must
    // instead fire on draft arrival, carrying the real payload.
    const { rerender } = renderWith({ state: 'REVIEWING', draft: null });
    rerender({ state: 'RESULT', draft: null }); // state flips first; draft still null
    expect(sent).not.toHaveBeenCalled(); // no empty generation beacon
    rerender({ state: 'RESULT', draft: DRAFT }); // draft lands one render later
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0]).toMatchObject({
      event: 'generation',
      code_hash: 'hash-abc',
      metrics: { ok: true, load_ms: 11, ttft_ms: 22, tok_per_sec: 33, total_ms: 44 },
    });
  });

  it('fires the visit beacon on mount when the session guard is unset (producer wired here)', () => {
    // The visit producer itself is unit-tested in useTelemetry.test.ts; this asserts the wiring:
    // mounting the workspace telemetry hook IS the unconditional page-level mount point.
    sessionStorage.removeItem(VISIT_BEACON_KEY);
    renderWith({ state: 'PREFLIGHT', draft: null });
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0]).toMatchObject({
      event: 'funnel_stage',
      metrics: { ok: true, stage: 'visit' },
    });
  });
});
