import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { reduce, INITIAL_STATE, type ReviewEvent, type ReviewState } from '../reducers/reviewMachine';
import type { EngineClient, EngineClientFactory, LoadProgress, CancelSignal } from '../inference/types';
import { runReview, AllChunksFailedError, type ReviewDraft } from '../inference/reviewPipeline';
import type { ReviewMode, UiLanguage } from '../types/api';

/** Default factory: dynamic-import the real worker client so web-llm never enters the test graph. */
const defaultFactory: EngineClientFactory = async () => {
  const mod = await import('../inference/engineClient');
  return mod.createEngineClient();
};

/** Default cache probe: dynamic-import the real client's soft cache check (keeps web-llm out of
 *  the test graph — tests inject `cacheCheck`). */
const defaultCacheCheck = async (): Promise<boolean> => {
  const mod = await import('../inference/engineClient');
  return mod.isModelCached();
};

/** The classified kind of a model-load failure, surfaced so the overlay can give disk-full vs
 *  network guidance instead of one blanket "couldn't reach the host" message. */
export type DownloadErrorKind = 'cdn' | 'quota' | 'other';

/** Detail of the most recent generation FAILURE, exposed for the generation `ok:false` beacon.
 *  `chunksAttempted` is present only when the failure was {@link AllChunksFailedError} (a chunked
 *  run where EVERY chunk failed) — beaconed as `metrics.chunks` so the fleet view can tell "one
 *  doomed 8-chunk run" from 8 independent failures. */
export interface GenFailureDetail {
  chunksAttempted?: number;
}

/**
 * Classify a caught model-load error (CONTRACT C2): a quota/disk-full exception (DOMException or
 * Error named 'QuotaExceededError', or text mentioning quota/storage) -> 'quota'; a TypeError or
 * network/fetch failure (web-llm wraps CDN failures as TypeError 'Failed to fetch') -> 'cdn';
 * anything else -> 'other'. The DownloadOverlay maps quota->download.quotaError, cdn->the existing
 * connection message, other->a generic failure message.
 */
export function classifyDownloadError(e: unknown): DownloadErrorKind {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (name === 'QuotaExceededError' || /quota|storage full|disk|exceeded the storage/i.test(msg)) {
    return 'quota';
  }
  if (name === 'TypeError' || /failed to fetch|network|fetch|load failed|cdn/i.test(msg)) {
    return 'cdn';
  }
  return 'other';
}

/**
 * Whether a caught GENERATION error is a WebGPU device loss / OOM rather than a content failure.
 * The only `device.lost` listener is on the capability-probe device, not the inference worker's
 * device (FE §7), so a device that dies mid-decode surfaces here as a rejected `generate()`. When
 * it does, route to the DEVICE_LOST recovery flow (dispose the dead worker + re-probe) instead of
 * the generic generation-error state. Conservative on purpose: only well-known device-loss/OOM
 * markers match; everything else stays a normal generation error.
 */
export function isDeviceLostError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return (
    name === 'GPUDeviceLostInfo' ||
    /device.{0,4}lost|lost the device|device is lost|device was destroyed|out of memory|\boom\b|failed to allocate/i.test(
      msg,
    )
  );
}

export interface RunArgs {
  code: string;
  mode: ReviewMode;
  locale: UiLanguage;
  language: string;
  onToken?: (buffer: string) => void;
  onChunk?: (progress: { index: number; total: number }) => void;
}

interface EngineContextValue {
  state: ReviewState;
  loadProgress: LoadProgress | null;
  /** Measured model-load time (ms); set on LOAD_COMPLETE, exposed for the model_load beacon. */
  loadMs: number;
  /** Whether the last completed load was served from the WebLLM cache (warm) vs a cold download.
   *  Set with LOAD_COMPLETE alongside loadMs; carried on the model_load beacon as `cache_hit` so
   *  load_ms percentiles can be split cache-hit vs cold. */
  cacheHit: boolean;
  /** Classified kind of the most recent load failure: quota/disk-full, CDN/network, or other.
   *  null while not in an error. The DownloadOverlay maps it to the right guidance. */
  downloadErrorKind: DownloadErrorKind | null;
  /** Detail of the most recent generation failure (set with GEN_ERROR, cleared as a run starts);
   *  carries `chunksAttempted` when the failure was all-chunks-failed. For the failure beacon. */
  lastGenFailure: GenFailureDetail | null;
  /** Chunks attempted by the most recent SUCCESSFUL chunked (map/reduce) run; null for single-shot
   *  runs and while idle. Set with GEN_COMPLETE; carried as `metrics.chunks` on the ok beacon. */
  lastGenChunks: number | null;
  dispatch: (event: ReviewEvent) => void;
  load: () => Promise<void>;
  run: (args: RunArgs) => Promise<ReviewDraft | null>;
  cancel: () => void;
  /** Soft cache probe (no download) for the auto-load-on-page-load path. Never rejects. */
  isCached: () => Promise<boolean>;
  /** Auto-load: probes the cache and, only when the weights are present, loads through.
   *  Single-flight with load(). Never rejects. */
  autoLoad: () => Promise<void>;
}

const EngineContext = createContext<EngineContextValue | null>(null);

/**
 * Owns the WebLLM engine handle in a useRef (NEVER React state — FE §4.1/§6) and the review
 * state machine via useReducer. Exposes the full EngineContextValue — the review `state` and
 * `dispatch`, the `load`/`run`/`cancel`/`autoLoad`/`isCached` controls, and the load/cache
 * telemetry fields (`loadProgress`, `loadMs`, `cacheHit`, `downloadErrorKind`, `lastGenFailure`,
 * `lastGenChunks`).
 * `clientFactory` is the test seam — tests inject a mock; production loads the real worker client.
 */
export function EngineProvider({
  children,
  clientFactory = defaultFactory,
  cacheCheck = defaultCacheCheck,
}: {
  children: ReactNode;
  clientFactory?: EngineClientFactory;
  cacheCheck?: () => Promise<boolean>;
}) {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);
  // load time is first-class state, set in the SAME commit as the LOAD_COMPLETE dispatch, so
  // the model_load beacon (which reads engine.loadMs off the context) sees it deterministically —
  // not via a render-ordering-dependent ref read. loadMsRef below stays for run()'s per-review
  // warm-reset accounting (load_ms 0 on the warm engine), which must NOT churn this state mid-run.
  const [loadMs, setLoadMs] = useState<number>(0);
  // Cache-hit of the last completed load: carried on the model_load beacon as
  // `cache_hit` so load_ms percentiles split warm vs cold. Set with LOAD_COMPLETE, like loadMs.
  const [cacheHit, setCacheHit] = useState<boolean>(false);
  // Classified load-failure kind: set with DL_ERROR, cleared when a new load starts.
  const [downloadErrorKind, setDownloadErrorKind] = useState<DownloadErrorKind | null>(null);
  // Generation telemetry detail (metrics §6 item 21): failure detail set with GEN_ERROR (the
  // all-chunks-failed case carries the attempted count), chunked-success count set with
  // GEN_COMPLETE. Both cleared as a run starts so a prior run's detail can't leak onto the next
  // beacon. State (not refs) so the beacon hook reads them deterministically off the context.
  const [lastGenFailure, setLastGenFailure] = useState<GenFailureDetail | null>(null);
  const [lastGenChunks, setLastGenChunks] = useState<number | null>(null);
  const engineRef = useRef<EngineClient | null>(null);
  const signalRef = useRef<CancelSignal>({ cancelled: false });
  const loadMsRef = useRef<number>(0);
  // Single-flight: the in-flight load() promise. A second load()/autoLoad() call
  // awaits this one instead of building a second client or disposing a mid-download worker. Bumped
  // `loadEpoch` tags each load attempt so a SUPERSEDED load (its worker disposed by cancel) can't
  // drive the machine to READY/DOWNLOAD_ERROR after a newer attempt or a cancel took over.
  const inFlightRef = useRef<Promise<void> | null>(null);
  const loadEpochRef = useRef<number>(0);

  // Free the worker + GPU when the provider unmounts. dispose() was previously never called, so
  // the ~1 GB worker/GPU allocation leaked for the page lifetime.
  useEffect(() => {
    return () => {
      void engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // A mid-session GPU loss kills the worker's device, and web-llm cannot revive it. Free the dead
  // worker and clear the ref so the recovery path's next load() builds a FRESH client instead of
  // reusing the lost one. The reducer holds DEVICE_LOST until the workspace re-probes.
  useEffect(() => {
    if (state !== 'DEVICE_LOST') return;
    void engineRef.current?.dispose();
    engineRef.current = null;
  }, [state]);

  // The actual load body, run under the single-flight guard in `load`. `epoch` tags this attempt so
  // its terminal dispatch is suppressed if cancel()/a newer load superseded it (loadEpochRef moved on).
  const runLoad = useCallback(
    async (epoch: number) => {
      try {
        // N-6: a prior load() that threw AFTER clientFactory() ran leaves a half-built, not-loaded
        // client in the ref (its worker + GPU context already allocated). On a RETRY/RESUME we must
        // dispose that stale client before building a fresh one, or each retry leaks a worker. A
        // FULLY-loaded engine is kept (warm reuse); DEVICE_LOST already null-clears the ref via its
        // own effect, so the next load() there builds fresh anyway.
        const existing = engineRef.current;
        if (existing && !existing.isLoaded()) {
          engineRef.current = null;
          await existing.dispose();
        }
        if (!engineRef.current) engineRef.current = await clientFactory();
        const start = performance.now();
        let lastProgress: LoadProgress | null = null;
        await engineRef.current.load((p) => {
          lastProgress = p;
          setLoadProgress(p);
        });
        // Superseded mid-download (cancel disposed the worker, or a newer load took over): swallow
        // the terminal transition so a stale LOAD_COMPLETE can't strand the UI on a finished engine
        // the state machine already moved past (e.g. DL_CANCELLED).
        if (epoch !== loadEpochRef.current) return;
        const ms = Math.round(performance.now() - start);
        loadMsRef.current = ms; // run()'s per-review accounting (warm-reset to 0 after first review)
        setLoadMs(ms); // first-class state for the model_load beacon, set with LOAD_COMPLETE
        setCacheHit((lastProgress as LoadProgress | null)?.cacheHit ?? false);
        dispatch({ type: 'LOAD_COMPLETE' });
      } catch (e) {
        if (epoch !== loadEpochRef.current) return; // superseded → its DL_ERROR must not drive the machine
        // Surface the real cause: the UI funnels every load failure into one generic "couldn't
        // reach the model host" message, which hides wasm/config/WebGPU/OOM errors. Classify the
        // error so the overlay can give disk-full vs network guidance, and log the real cause.
        console.error('[engine] model load failed:', e);
        setDownloadErrorKind(classifyDownloadError(e));
        dispatch({ type: 'DL_ERROR' });
      }
    },
    [clientFactory],
  );

  const load = useCallback(async () => {
    // Single-flight: a concurrent load()/autoLoad() awaits the in-flight one instead of starting a
    // second (which would double-create clients or dispose a mid-download worker).
    if (inFlightRef.current) return inFlightRef.current;
    const epoch = ++loadEpochRef.current;
    setDownloadErrorKind(null); // clear any prior failure as a new attempt starts
    dispatch({ type: 'LOAD_MODEL' });
    const p = runLoad(epoch).finally(() => {
      if (inFlightRef.current === p) inFlightRef.current = null;
    });
    inFlightRef.current = p;
    return p;
  }, [runLoad]);

  const run = useCallback(async (args: RunArgs): Promise<ReviewDraft | null> => {
    const engine = engineRef.current;
    if (!engine) return null;
    signalRef.current = { cancelled: false };
    setLastGenFailure(null); // a fresh run owns the failure/chunk detail — clear the prior run's
    setLastGenChunks(null);
    // Observe the pipeline's chunk progress to learn how many chunks a CHUNKED run attempted
    // (total > 1 only — single-shot runs report {1,1} and must NOT beacon `chunks: 1`).
    let chunkedAttempts = 0;
    const callerOnChunk = args.onChunk;
    dispatch({ type: 'RUN_REVIEW' });
    try {
      const draft = await runReview({
        ...args,
        onChunk: (p) => {
          if (p.total > 1) chunkedAttempts = p.index;
          callerOnChunk?.(p);
        },
        client: engine,
        signal: signalRef.current,
        loadMs: loadMsRef.current,
      });
      if (signalRef.current.cancelled) {
        dispatch({ type: 'GEN_CANCEL' });
        return null; // cancelled → the partial draft is discarded, never persisted (FE §5.1)
      }
      // Consume the cold-load attribution only once a run actually completes (its draft already
      // carried loadMsRef.current into runReview above). A cancelled/failed first run leaves it
      // intact so the first SUCCESSFUL review still beacons the real cold-load time, not 0.
      loadMsRef.current = 0; // subsequent reviews run on the warm engine (load_ms 0)
      if (chunkedAttempts > 0) setLastGenChunks(chunkedAttempts);
      dispatch({ type: 'GEN_COMPLETE' });
      return draft;
    } catch (e) {
      console.error('[engine] generation failed:', e);
      // A mid-generation WebGPU device loss / OOM is not a content failure: route it to the
      // DEVICE_LOST recovery flow (the provider's DEVICE_LOST effect disposes the dead worker and
      // the workspace re-probes; a healthy adapter returns to CAPABLE) rather than REVIEW_ERROR.
      if (isDeviceLostError(e)) {
        dispatch({ type: 'DEVICE_LOST' });
        return null;
      }
      // All-chunks-failed carries its attempted count for the `ok:false` beacon's `chunks`;
      // any other failure exposes an empty detail (the beacon then omits `chunks`).
      setLastGenFailure(e instanceof AllChunksFailedError ? { chunksAttempted: e.attempted } : {});
      dispatch({ type: 'GEN_ERROR' });
      return null;
    }
  }, []);

  const cancel = useCallback(() => {
    signalRef.current.cancelled = true;
    // A download cancel must ACTUALLY stop the ~1 GB transfer, not just flip the UI: dispose the
    // in-flight client (terminates the worker), null the ref, and bump the epoch so the superseded
    // runLoad's terminal LOAD_COMPLETE/DL_ERROR is swallowed (it can't fight DL_CANCELLED). Only do
    // this while a load is actually in flight; a generation cancel resolves cooperatively in run().
    if (inFlightRef.current) {
      loadEpochRef.current += 1; // supersede the in-flight runLoad
      inFlightRef.current = null;
      const client = engineRef.current;
      engineRef.current = null;
      void client?.dispose();
    }
    dispatch({ type: 'DL_CANCEL' }); // no-op unless DOWNLOADING; generation cancel resolves in run()
  }, []);

  // Soft cache probe for the auto-load-on-page-load path (ReviewWorkspace). Never throws — a failed
  // probe degrades to "not cached" so the manual Load-model button still appears.
  const isCached = useCallback(async (): Promise<boolean> => {
    try {
      return await cacheCheck();
    } catch (e) {
      console.warn('[engine] cache probe failed:', e);
      return false;
    }
  }, [cacheCheck]);

  // Auto-load when the weights are already cached: load straight through (single-flight via
  // inFlightRef so the probe can't race the manual Load button into a double-create). A previous
  // cross-tab web-lock gate here regressed the common single-tab case — the held lock
  // made auto-load skip on any re-invocation (StrictMode / remount) — so it was removed. Multi-tab
  // reverts to "wasteful but safe": each tab loads its own engine (Cache API writes are atomic).
  const autoLoad = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return; // a manual Load already in flight — don't double-load
    let cached = false;
    try {
      cached = await cacheCheck();
    } catch (e) {
      console.warn('[engine] cache probe failed:', e);
      return; // not cached / probe failed → leave the manual Load-model button to the user
    }
    if (!cached) return;
    await load();
  }, [cacheCheck, load]);

  // N-9/N-10: memoize the context so a fresh object literal each render does not re-render every
  // useEngine() consumer on every setLoadProgress tick during the ~1 GB download. `loadMs` is
  // state (not a ref read), so it is a real dependency and the model_load beacon reads it
  // deterministically. dispatch is stable (useReducer); load/run/cancel are useCallback-stable.
  const value = useMemo<EngineContextValue>(
    () => ({
      state,
      loadProgress,
      loadMs,
      cacheHit,
      downloadErrorKind,
      lastGenFailure,
      lastGenChunks,
      dispatch,
      load,
      run,
      cancel,
      isCached,
      autoLoad,
    }),
    [
      state,
      loadProgress,
      loadMs,
      cacheHit,
      downloadErrorKind,
      lastGenFailure,
      lastGenChunks,
      load,
      run,
      cancel,
      isCached,
      autoLoad,
    ],
  );
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngine(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error('useEngine must be used within an EngineProvider');
  return ctx;
}
