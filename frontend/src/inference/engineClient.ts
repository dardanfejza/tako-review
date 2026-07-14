import {
  CreateWebWorkerMLCEngine,
  hasModelInCache,
  type InitProgressReport,
  type ChatCompletionMessageParam,
  type WebWorkerMLCEngine,
} from '@mlc-ai/web-llm';
import { appConfig, MODEL_ID } from '../config/appConfig';
import type { EngineClient, GenResult } from './types';
import { consumeCancellableStream, type StreamChunk } from './streamConsume';

/**
 * Soft cache probe (no download, no worker): are the model weights already in this origin's
 * WebLLM cache? Used to auto-load on page load when the ~1 GB model is present, while still
 * gating a first-time download behind an explicit click.
 */
export function isModelCached(): Promise<boolean> {
  return hasModelInCache(MODEL_ID, appConfig);
}

/**
 * The real worker-backed EngineClient (FE §4.1/§5). Loaded via dynamic import by EngineProvider
 * so @mlc-ai/web-llm + the worker never enter the CI/test graph — tests inject the mock instead.
 * Cancellation is cooperative: on `signal.cancelled` we call interruptGenerate() and DRAIN the
 * stream to its end (FE §5.1) — see consumeCancellableStream for why breaking would leak web-llm's
 * per-model lock and soft-lock the app. We only ever interrupt on the streaming path (WebLLM #447).
 */
export function createEngineClient(): EngineClient {
  let engine: WebWorkerMLCEngine | null = null;
  let worker: Worker | null = null;

  // web-llm emits this phrasing in the InitProgressReport text when the weights are served from the
  // origin's Cache API instead of the network. Detecting a *real* cache hit from the report text (or
  // an isModelCached() probe captured before load) is the only correct signal — `progress >= 1` is
  // true at the END of every load, cold downloads included, so it can't distinguish the two (LOW B3).
  const CACHE_HIT_RE = /from cache|cache hit|loading model from cache/i;

  return {
    async load(onProgress): Promise<void> {
      // Idempotent (HIGH #3): a second load() must NOT spawn a second Worker + ~1 GB GPU
      // allocation while orphaning the first. If the engine is already fully loaded, no-op; if a
      // half-built worker survives a prior failed load, tear it down before building a fresh one.
      if (engine && worker) return;
      if (worker) await this.dispose();

      // Probe the cache BEFORE creating the worker: a true cache hit is known up front, independent
      // of the noisy per-tick progress text. We OR it with the report-text signal below so either
      // path flags a warm load.
      let cachedAtStart = false;
      try {
        cachedAtStart = await hasModelInCache(MODEL_ID, appConfig);
      } catch {
        // probe failure is non-fatal — fall back to report-text detection only.
      }

      // Latch the cache-hit signal: once any report (or the up-front probe) flags a warm load, keep
      // it set for the rest of the load. Otherwise a later progress=1 tick (whose text lacks the
      // "from cache" phrasing) would reset cacheHit back to false on the final report the provider reads.
      let cacheHit = cachedAtStart;
      const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
      worker = w;
      try {
        engine = await CreateWebWorkerMLCEngine(w, MODEL_ID, {
          appConfig,
          initProgressCallback: (r: InitProgressReport) => {
            if (CACHE_HIT_RE.test(r.text)) cacheHit = true;
            onProgress({ progress: r.progress, text: r.text, cacheHit });
          },
        });
      } catch (e) {
        // The CreateWebWorkerMLCEngine factory left a live worker behind on failure — terminate it
        // so a retry's fresh load() doesn't leak this one (idempotency depends on isLoaded()===false
        // tearing down before rebuild). Clear the handle and re-throw for the provider to classify.
        if (worker === w) {
          worker = null;
          w.terminate();
        }
        throw e;
      }
    },

    async generate(messages, opts, onToken, signal): Promise<GenResult> {
      if (!engine) throw new Error('Engine not loaded');
      const eng = engine; // narrow + capture: dispose() could null `engine` during the stream
      const completion = await eng.chat.completions.create({
        stream: true,
        stream_options: { include_usage: true },
        messages: messages as ChatCompletionMessageParam[],
        temperature: opts.temperature,
        top_p: opts.top_p,
        repetition_penalty: opts.repetition_penalty,
        frequency_penalty: opts.frequency_penalty,
        logit_bias: opts.logit_bias,
        seed: opts.seed,
      });
      // The cancel path (interrupt + DRAIN, never break) lives in consumeCancellableStream so it is
      // unit-testable without web-llm; breaking here would leak web-llm's per-model lock (see there).
      // `usage` typing differs from our WebLLMUsage so adapt the iterable at this boundary.
      return consumeCancellableStream(
        completion as unknown as AsyncIterable<StreamChunk>,
        () => eng.interruptGenerate(),
        onToken,
        signal,
      );
    },

    isLoaded: () => engine !== null,
    async dispose(): Promise<void> {
      // Real teardown: unload() frees the GPU buffers inside the worker; terminate() kills the
      // worker thread itself. Previously this only nulled the handle — leaking both (~1 GB) since
      // the worker kept the model resident in GPU memory.
      const e = engine;
      const w = worker;
      engine = null;
      worker = null;
      try {
        await e?.unload();
      } finally {
        w?.terminate();
      }
    },
  };
}
