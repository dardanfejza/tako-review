import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import type { ReactNode } from 'react';
import { EngineProvider, useEngine, classifyDownloadError, isDeviceLostError } from './EngineProvider';
import { createMockEngineClient } from '../inference/mockEngineClient';
import type { EngineClient, EngineClientFactory, LoadProgress } from '../inference/types';
import type { ReviewDraft } from '../inference/reviewPipeline';

function wrapperWith(factory: EngineClientFactory, cacheCheck?: () => Promise<boolean>) {
  return ({ children }: { children: ReactNode }) => (
    <EngineProvider clientFactory={factory} cacheCheck={cacheCheck}>
      {children}
    </EngineProvider>
  );
}

/** A controllable promise so a test can hold load() mid-download and observe the in-flight state. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('EngineProvider', () => {
  it('load() drives PREFLIGHT→CAPABLE→DOWNLOADING→READY and surfaces progress', async () => {
    const client = createMockEngineClient({
      loadReports: [
        { progress: 0.5, text: 'half' },
        { progress: 1, text: 'done' },
      ],
    });
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });

    expect(result.current.state).toBe('PREFLIGHT');
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    expect(result.current.state).toBe('CAPABLE');

    await act(async () => {
      await result.current.load();
    });
    expect(result.current.state).toBe('READY');
    expect(result.current.loadProgress?.progress).toBe(1);
  });

  it('run() transitions REVIEWING→RESULT and returns the assembled draft', async () => {
    const client = createMockEngineClient({ tokens: ['hi ', 'there'] });
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });

    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });

    const holder: { draft: ReviewDraft | null } = { draft: null };
    await act(async () => {
      holder.draft = await result.current.run({ code: 'x', mode: 'bugs', locale: 'en', language: 'text' });
    });
    expect(result.current.state).toBe('RESULT');
    expect(holder.draft?.review_output).toBe('hi there');
  });

  it('a generation failure transitions to REVIEW_ERROR', async () => {
    const client = createMockEngineClient({ failOnGenerate: new Error('boom') });
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    await act(async () => {
      await result.current.run({ code: 'x', mode: 'bugs', locale: 'en', language: 'text' });
    });
    expect(result.current.state).toBe('REVIEW_ERROR');
  });

  it('routes a mid-generation device loss to DEVICE_LOST (recovery), not REVIEW_ERROR', async () => {
    // A WebGPU device that dies during decode surfaces as a rejected generate() (the only
    // device.lost listener is on the idle probe device). It must enter the DEVICE_LOST recovery
    // flow (re-probe → reload), not the generic generation-error state.
    const client = createMockEngineClient({ failOnGenerate: new Error('WebGPU device is lost') });
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    await act(async () => {
      await result.current.run({ code: 'x', mode: 'bugs', locale: 'en', language: 'text' });
    });
    expect(result.current.state).toBe('DEVICE_LOST');
  });

  it('isDeviceLostError matches device-loss / OOM markers and nothing else', () => {
    expect(isDeviceLostError(new Error('WebGPU device is lost'))).toBe(true);
    expect(isDeviceLostError(new Error('GPUDevice was destroyed'))).toBe(true);
    expect(isDeviceLostError(new Error('Out of memory while allocating'))).toBe(true);
    expect(isDeviceLostError(new Error('failed to allocate buffer'))).toBe(true);
    const lost = new Error('lost'); lost.name = 'GPUDeviceLostInfo';
    expect(isDeviceLostError(lost)).toBe(true);
    // ordinary failures are NOT device losses → stay a normal generation error
    expect(isDeviceLostError(new Error('boom'))).toBe(false);
    expect(isDeviceLostError('all 8 review chunk(s) failed')).toBe(false);
    expect(isDeviceLostError(undefined)).toBe(false);
  });

  it('run() returns null on cancel so the caller never persists a cancelled review', async () => {
    const holder: { draft: ReviewDraft | null } = { draft: null };
    const { result } = renderHook(() => useEngine(), {
      wrapper: wrapperWith(() =>
        createMockEngineClient({
          tokens: ['a', 'b', 'c', 'd'],
          onBeforeToken: (i) => {
            if (i === 1) result.current.cancel();
          },
        }),
      ),
    });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    await act(async () => {
      holder.draft = await result.current.run({ code: 'x', mode: 'bugs', locale: 'en', language: 'text' });
    });
    expect(result.current.state).toBe('REVIEW_CANCELLED');
    expect(holder.draft).toBeNull(); // partial draft discarded → ReviewWorkspace's `if (!d) return` skips save
  });

  it('disposes the engine on unmount so the worker/GPU is freed, not leaked', async () => {
    const dispose = vi.fn();
    const client: EngineClient = { ...createMockEngineClient({ tokens: ['hi'] }), dispose };
    const { result, unmount } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    expect(dispose).not.toHaveBeenCalled();
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('a failed load then a retry builds exactly one live client (no half-built leak — N-6)', async () => {
    // First build's load() rejects AFTER the worker exists (the GPU context is already allocated),
    // leaving a half-built, not-loaded client in the ref. A retry must dispose that stale client
    // and build a fresh one — so repeated retries never leak a worker + GPU context.
    const disposes: number[] = [];
    let builds = 0;
    const factory: EngineClientFactory = () => {
      const n = builds++;
      let loaded = false;
      const client: EngineClient = {
        load: async () => {
          if (n === 0) throw new Error('CDN flake'); // half-built: worker exists, never loaded
          loaded = true;
        },
        generate: async () => ({ text: '', usage: undefined }),
        isLoaded: () => loaded,
        dispose: () => {
          disposes.push(n);
        },
      };
      return client;
    };
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(factory) });

    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.state).toBe('DOWNLOAD_ERROR'); // first load failed
    expect(builds).toBe(1);
    expect(disposes).toEqual([]); // not disposed yet — disposal happens on the retry

    await act(async () => {
      await result.current.load(); // retry path
    });
    expect(result.current.state).toBe('READY');
    expect(builds).toBe(2); // a fresh client was built
    expect(disposes).toEqual([0]); // the stale half-built client #0 was disposed exactly once
  });

  it('disposes and rebuilds the engine on DEVICE_LOST so a recovered GPU gets a fresh worker', async () => {
    const dispose = vi.fn();
    let builds = 0;
    const factory: EngineClientFactory = () => {
      builds += 1;
      return { ...createMockEngineClient({ tokens: ['hi'] }), dispose };
    };
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(factory) });

    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    expect(builds).toBe(1);
    expect(dispose).not.toHaveBeenCalled();

    // GPU lost mid-session: the dead worker must be freed, not reused.
    act(() => result.current.dispatch({ type: 'DEVICE_LOST' }));
    expect(dispose).toHaveBeenCalledOnce();

    // Recover → CAPABLE → load again must rebuild (web-llm cannot revive a lost GPU device).
    act(() => result.current.dispatch({ type: 'REPROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    expect(builds).toBe(2);
    expect(result.current.state).toBe('READY');
  });

  it('exposes cacheHit on the context from the final load report (B3 — not progress>=1)', async () => {
    // A COLD download whose final report (progress 1) carries no cache-hit signal → cacheHit false,
    // even though progress reached 1 (the old bug reported every completed load as a cache hit).
    const cold = createMockEngineClient({
      loadReports: [
        { progress: 0.5, text: 'Fetching param cache[1/2]', cacheHit: false },
        { progress: 1, text: 'Finished loading on WebGPU', cacheHit: false },
      ],
    });
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => cold) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.state).toBe('READY');
    expect(result.current.cacheHit).toBe(false);
  });

  it('carries cacheHit=true through to the context on a warm (cache-served) load', async () => {
    const warm = createMockEngineClient({
      loadReports: [{ progress: 1, text: 'Loading model from cache[1/1]', cacheHit: true }],
    });
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => warm) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.cacheHit).toBe(true);
  });

  it('classifies a load failure and exposes downloadErrorKind', async () => {
    const quotaErr = new Error('The quota has been exceeded');
    quotaErr.name = 'QuotaExceededError';
    const factory: EngineClientFactory = () => ({
      load: async () => {
        throw quotaErr;
      },
      generate: async () => ({ text: '', usage: undefined }),
      isLoaded: () => false,
      dispose: () => {},
    });
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(factory) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.state).toBe('DOWNLOAD_ERROR');
    expect(result.current.downloadErrorKind).toBe('quota');
  });

  it('clears downloadErrorKind when a fresh load starts (retry after a CDN failure)', async () => {
    let builds = 0;
    const factory: EngineClientFactory = () => {
      const n = builds++;
      let loaded = false;
      return {
        load: async () => {
          if (n === 0) throw new TypeError('Failed to fetch'); // CDN failure
          loaded = true;
        },
        generate: async () => ({ text: '', usage: undefined }),
        isLoaded: () => loaded,
        dispose: () => {},
      };
    };
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(factory) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.downloadErrorKind).toBe('cdn');

    await act(async () => {
      await result.current.load(); // retry
    });
    expect(result.current.state).toBe('READY');
    expect(result.current.downloadErrorKind).toBeNull();
  });

  it('serializes concurrent load() calls — single-flight builds exactly one client', async () => {
    const gate = deferred();
    let builds = 0;
    const factory: EngineClientFactory = () => {
      builds += 1;
      return {
        load: async (onProgress: (p: LoadProgress) => void) => {
          onProgress({ progress: 0.1, text: 'start', cacheHit: false });
          await gate.promise; // hold the load open so a second call overlaps
        },
        generate: async () => ({ text: '', usage: undefined }),
        isLoaded: () => true,
        dispose: () => {},
      };
    };
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(factory) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));

    await act(async () => {
      const a = result.current.load();
      const b = result.current.load(); // second call must JOIN the in-flight one, not start a new build
      gate.resolve();
      await Promise.all([a, b]);
    });
    expect(builds).toBe(1); // single-flight: no double-create
    expect(result.current.state).toBe('READY');
  });

  it('cancel during download disposes the in-flight worker and the stale LOAD_COMPLETE is swallowed', async () => {
    const gate = deferred();
    const dispose = vi.fn();
    const factory: EngineClientFactory = () => ({
      load: async (onProgress: (p: LoadProgress) => void) => {
        onProgress({ progress: 0.3, text: 'downloading', cacheHit: false });
        await gate.promise; // mid-download
      },
      generate: async () => ({ text: '', usage: undefined }),
      isLoaded: () => true,
      dispose,
    });
    const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(factory) });
    act(() => result.current.dispatch({ type: 'PROBE_OK' }));

    let loadPromise!: Promise<void>;
    await act(async () => {
      loadPromise = result.current.load();
      // Flush the microtasks that build the client + start its (gated) load, so the worker exists
      // and the first progress report lands before we cancel.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state).toBe('DOWNLOADING');

    // Cancel mid-download: the worker must be disposed (download actually stops), state → DL_CANCELLED.
    act(() => result.current.cancel());
    expect(dispose).toHaveBeenCalledOnce();
    expect(result.current.state).toBe('DL_CANCELLED');

    // The superseded load now finishes — its LOAD_COMPLETE must NOT drive the machine back to READY.
    await act(async () => {
      gate.resolve();
      await loadPromise;
    });
    expect(result.current.state).toBe('DL_CANCELLED');
  });

  describe('autoLoad (loads straight through when cached)', () => {
    it('auto-loads when the model is cached', async () => {
      const client = createMockEngineClient({ tokens: ['hi'] });
      const { result } = renderHook(() => useEngine(), {
        wrapper: wrapperWith(() => client, async () => true),
      });
      act(() => result.current.dispatch({ type: 'PROBE_OK' }));
      await act(async () => {
        await result.current.autoLoad();
      });
      expect(result.current.state).toBe('READY');
    });

    it('does NOT auto-load when the model is not cached', async () => {
      let builds = 0;
      const factory: EngineClientFactory = () => {
        builds += 1;
        return createMockEngineClient({ tokens: ['hi'] });
      };
      const { result } = renderHook(() => useEngine(), {
        wrapper: wrapperWith(factory, async () => false), // not cached
      });
      act(() => result.current.dispatch({ type: 'PROBE_OK' }));
      await act(async () => {
        await result.current.autoLoad();
      });
      expect(builds).toBe(0);
      expect(result.current.state).toBe('CAPABLE');
    });

    it('does NOT auto-load (and never throws) when the cache probe rejects', async () => {
      let builds = 0;
      const factory: EngineClientFactory = () => {
        builds += 1;
        return createMockEngineClient({ tokens: ['hi'] });
      };
      const { result } = renderHook(() => useEngine(), {
        wrapper: wrapperWith(factory, async () => {
          throw new Error('cache probe blew up');
        }),
      });
      act(() => result.current.dispatch({ type: 'PROBE_OK' }));
      await act(async () => {
        await result.current.autoLoad(); // must resolve, not reject
      });
      expect(builds).toBe(0);
      expect(result.current.state).toBe('CAPABLE');
    });
  });

  describe('generation telemetry detail (lastGenFailure / lastGenChunks — metrics §6 item 21)', () => {
    // Large enough that withLineNumbers(code) exceeds the 3500-token (~14k char) budget → chunked.
    const CHUNKED_CODE = Array.from({ length: 300 }, (_, i) => `# line ${i} ${'x'.repeat(60)}`).join(
      '\n',
    );
    const RUN = { mode: 'bugs' as const, locale: 'en' as const, language: 'text' };

    it('exposes lastGenFailure.chunksAttempted when EVERY chunk of a chunked run fails', async () => {
      const client = createMockEngineClient({ failOnGenerate: new Error('boom') });
      const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });
      act(() => result.current.dispatch({ type: 'PROBE_OK' }));
      await act(async () => {
        await result.current.load();
      });
      expect(result.current.lastGenFailure).toBeNull(); // idle → no detail
      await act(async () => {
        await result.current.run({ code: CHUNKED_CODE, ...RUN });
      });
      expect(result.current.state).toBe('REVIEW_ERROR');
      // AllChunksFailedError.attempted flows onto the context for the failure beacon's `chunks`.
      expect(result.current.lastGenFailure?.chunksAttempted).toBeGreaterThanOrEqual(2);
      expect(result.current.lastGenChunks).toBeNull(); // no successful chunked run
    });

    it('exposes an EMPTY failure detail (no chunksAttempted) for a non-chunked failure', async () => {
      const client = createMockEngineClient({ failOnGenerate: new Error('boom') });
      const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });
      act(() => result.current.dispatch({ type: 'PROBE_OK' }));
      await act(async () => {
        await result.current.load();
      });
      await act(async () => {
        await result.current.run({ code: 'x', ...RUN }); // single-shot, generate throws
      });
      expect(result.current.state).toBe('REVIEW_ERROR');
      expect(result.current.lastGenFailure).toEqual({}); // failure detail set, but no chunk count
      expect(result.current.lastGenFailure?.chunksAttempted).toBeUndefined();
    });

    it('exposes lastGenChunks on a SUCCESSFUL chunked run and still forwards onChunk to the caller', async () => {
      const client = createMockEngineClient({ tokens: ['ok'] });
      const onChunk = vi.fn();
      const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });
      act(() => result.current.dispatch({ type: 'PROBE_OK' }));
      await act(async () => {
        await result.current.load();
      });
      await act(async () => {
        await result.current.run({ code: CHUNKED_CODE, ...RUN, onChunk });
      });
      expect(result.current.state).toBe('RESULT');
      expect(result.current.lastGenChunks).toBeGreaterThanOrEqual(2);
      // The chunk-counting interceptor must not swallow the caller's progress callback.
      expect(onChunk).toHaveBeenCalled();
      expect(onChunk.mock.calls.at(-1)![0].index).toBe(result.current.lastGenChunks);
    });

    it('keeps lastGenChunks null on a single-shot success (no `chunks:1` noise)', async () => {
      const client = createMockEngineClient({ tokens: ['ok'] });
      const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });
      act(() => result.current.dispatch({ type: 'PROBE_OK' }));
      await act(async () => {
        await result.current.load();
      });
      await act(async () => {
        await result.current.run({ code: 'x', ...RUN });
      });
      expect(result.current.state).toBe('RESULT');
      expect(result.current.lastGenChunks).toBeNull();
    });

    it('clears the prior run detail when a new run starts (failure → success leaves no stale detail)', async () => {
      let calls = 0;
      const client: EngineClient = {
        load: async () => {},
        generate: async (_m, _o, onToken) => {
          calls += 1;
          if (calls === 1) throw new Error('boom'); // first run fails
          onToken('ok');
          return { text: 'ok', usage: undefined };
        },
        isLoaded: () => true,
        dispose: () => {},
      };
      const { result } = renderHook(() => useEngine(), { wrapper: wrapperWith(() => client) });
      act(() => result.current.dispatch({ type: 'PROBE_OK' }));
      await act(async () => {
        await result.current.load();
      });
      await act(async () => {
        await result.current.run({ code: 'x', ...RUN });
      });
      expect(result.current.state).toBe('REVIEW_ERROR');
      expect(result.current.lastGenFailure).toEqual({});

      await act(async () => {
        await result.current.run({ code: 'x', ...RUN }); // REVIEW_ERROR → REVIEWING → RESULT
      });
      expect(result.current.state).toBe('RESULT');
      expect(result.current.lastGenFailure).toBeNull(); // the failed run's detail did not leak
    });
  });

  it('isCached() degrades a rejecting probe to false instead of throwing', async () => {
    const client = createMockEngineClient({ tokens: ['hi'] });
    const { result } = renderHook(() => useEngine(), {
      wrapper: wrapperWith(
        () => client,
        async () => {
          throw new Error('probe failed');
        },
      ),
    });
    let cached = true;
    await act(async () => {
      cached = await result.current.isCached();
    });
    expect(cached).toBe(false);
  });
});

describe('classifyDownloadError', () => {
  it('maps QuotaExceededError / disk-full text to "quota"', () => {
    const q = new Error('Storage quota exceeded');
    q.name = 'QuotaExceededError';
    expect(classifyDownloadError(q)).toBe('quota');
    expect(classifyDownloadError(new Error('disk is full'))).toBe('quota');
  });

  it('maps TypeError / fetch failures to "cdn"', () => {
    expect(classifyDownloadError(new TypeError('Failed to fetch'))).toBe('cdn');
    expect(classifyDownloadError(new Error('network error while fetching'))).toBe('cdn');
  });

  it('maps anything else to "other"', () => {
    expect(classifyDownloadError(new Error('WebGPU device creation failed'))).toBe('other');
    expect(classifyDownloadError('plain string')).toBe('other');
    expect(classifyDownloadError(null)).toBe('other');
  });
});
