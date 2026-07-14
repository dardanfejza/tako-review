import { vi } from 'vitest';
import {
  AllChunksFailedError,
  CodeTooLargeError,
  MAX_CODE_BYTES,
  codeTextBytes,
  runReview,
} from './reviewPipeline';
import { createMockEngineClient } from './mockEngineClient';
import { sha256Hex } from '../lib/hash';
import { MODEL_VERSION, PROMPT_VERSION } from '../config/versions';
import type {
  CancelSignal,
  ChatMessage,
  EngineClient,
  GenOptions,
  GenResult,
  LoadProgress,
} from './types';
import type { WebLLMUsage } from '../lib/telemetry';

/** Big enough to force the chunked map/reduce path (> CONTEXT_BUDGET_TOKENS once line-numbered). */
const bigInput = () => Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');

/**
 * Minimal EngineClient whose `generate` is a per-call function — lets a test fail/succeed specific
 * chunks (the shared mock fails ALL or NONE). Only `generate` is exercised by runReview.
 */
function makeClient(
  gen: (
    messages: ChatMessage[],
    opts: GenOptions,
    onToken: (delta: string) => void,
    signal: CancelSignal,
  ) => GenResult | Promise<GenResult>,
): EngineClient {
  return {
    load: async (onProgress: (p: LoadProgress) => void) => onProgress({ progress: 1, text: 'ok' }),
    generate: async (messages, opts, onToken, signal) => gen(messages, opts, onToken, signal),
    isLoaded: () => true,
    dispose: () => {},
  };
}

describe('runReview (orchestration — FE §4.5)', () => {
  it('assembles a ReviewCreate-ready draft from a single-shot review', async () => {
    const client = createMockEngineClient({
      tokens: ['## Summary\n', 'ok'],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        extra: { e2e_latency_s: 1, time_to_first_token_s: 0.1, decode_tokens_per_s: 20 },
      },
    });
    const draft = await runReview({
      code: 'print(1)',
      mode: 'bugs',
      locale: 'en',
      language: 'python',
      client,
      signal: { cancelled: false },
      loadMs: 500,
    });

    expect(draft.review_output).toBe('## Summary\nok');
    expect(draft.code_text).toBe('1  print(1)');
    expect(draft.code_hash).toBe(await sha256Hex('1  print(1)'));
    expect(draft.review_mode).toBe('bugs');
    expect(draft.language).toBe('python');
    expect(draft.model_version).toBe(MODEL_VERSION);
    expect(draft.prompt_version).toBe(PROMPT_VERSION);
    expect(draft.timing).toEqual({
      load_ms: 500,
      ttft_ms: 100,
      total_ms: 1000,
      tokens_prompt: 5,
      tokens_completion: 2,
      tok_per_sec: 20,
    });
  });

  it('returns the partial buffer when cancelled mid-stream', async () => {
    const signal: CancelSignal = { cancelled: false };
    const client = createMockEngineClient({ tokens: ['a', 'b', 'c', 'd'] });
    let count = 0;
    const draft = await runReview({
      code: 'x',
      mode: 'explain',
      locale: 'en',
      language: 'text',
      client,
      signal,
      onToken: () => {
        count += 1;
        if (count === 2) signal.cancelled = true;
      },
    });
    expect(draft.review_output).toBe('ab');
  });

  it('chunks oversized input, firing onChunk per chunk and reconstructing sections', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const events: Array<{ index: number; total: number }> = [];
    const client = createMockEngineClient({ tokens: ['ok'] });
    const draft = await runReview({
      code: big,
      mode: 'bugs',
      locale: 'en',
      language: 'text',
      client,
      signal: { cancelled: false },
      onChunk: (p) => events.push(p),
    });
    expect(events.length).toBeGreaterThan(1);
    expect(events[0]!.index).toBe(1);
    expect(events[0]!.total).toBe(events.length);
    expect(draft.review_output).toContain('Section 1');
  });

  it('sums usage across chunks (timing reflects the whole run, not just the last chunk)', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const events: Array<{ index: number; total: number }> = [];
    const client = createMockEngineClient({
      tokens: ['ok'],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        extra: { e2e_latency_s: 1, time_to_first_token_s: 0.1, decode_tokens_per_s: 20 },
      },
    });
    const draft = await runReview({
      code: big,
      mode: 'bugs',
      locale: 'en',
      language: 'text',
      client,
      signal: { cancelled: false },
      onChunk: (p) => events.push(p),
    });
    const chunks = events.length;
    expect(chunks).toBeGreaterThan(1);
    // The bug: CURRENT kept only the last chunk's usage (would be 2 / 5). Fixed: summed.
    expect(draft.timing.tokens_completion).toBe(2 * chunks);
    expect(draft.timing.tokens_prompt).toBe(5 * chunks);
  });

  it('rejects oversized code with CodeTooLargeError before calling the engine', async () => {
    const generate = vi.fn();
    const client = { generate } as unknown as EngineClient;
    const code = 'a'.repeat(300_000); // line-numbered bytes exceed the 256 KB server cap
    expect(codeTextBytes(code)).toBeGreaterThan(MAX_CODE_BYTES);
    await expect(
      runReview({
        code,
        mode: 'bugs',
        locale: 'en',
        language: 'python',
        client,
        signal: { cancelled: false },
      }),
    ).rejects.toBeInstanceOf(CodeTooLargeError);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects empty code with CodeTooLargeError before calling the engine', async () => {
    const generate = vi.fn();
    const client = { generate } as unknown as EngineClient;
    await expect(
      runReview({
        code: '',
        mode: 'bugs',
        locale: 'en',
        language: 'python',
        client,
        signal: { cancelled: false },
      }),
    ).rejects.toBeInstanceOf(CodeTooLargeError);
    expect(generate).not.toHaveBeenCalled();
  });

  it('throws AllChunksFailedError when EVERY chunk fails — never resolves a junk success (review §4)', async () => {
    // Regression: a chunked run whose every generate() threw still RESOLVED with placeholder
    // sections + zeroed timing, so the caller beaconed `ok:true` and saved a zero-latency record.
    // Now it throws so the caller fires GEN_ERROR / `ok:false` and skips the save.
    const client = createMockEngineClient({ failOnGenerate: new Error('device lost') });
    await expect(
      runReview({
        code: bigInput(),
        mode: 'bugs',
        locale: 'en',
        language: 'text',
        client,
        signal: { cancelled: false },
      }),
    ).rejects.toBeInstanceOf(AllChunksFailedError);
  });

  it('still resolves a PARTIAL result when only SOME chunks fail (partial-tolerant §4.6)', async () => {
    // Fail only the first generate() call, succeed on the rest → run resolves with one
    // "_Review failed_" placeholder section and real review for the others.
    let calls = 0;
    const client = makeClient((_messages, _opts, onToken, signal) => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      let text = '';
      for (const tok of ['ok ', 'section']) {
        if (signal.cancelled) break;
        text += tok;
        onToken(tok);
      }
      return { text };
    });
    const draft = await runReview({
      code: bigInput(),
      mode: 'bugs',
      locale: 'en',
      language: 'text',
      client,
      signal: { cancelled: false },
    });
    expect(draft.review_output).toContain('_Review failed for this section._');
    expect(draft.review_output).toContain('ok section');
  });

  it('reports TTFT from the FIRST chunk only, not summed across chunks (review §4)', async () => {
    // Regression: combineUsage summed time_to_first_token_s across chunks, so an N-chunk run
    // reported N× the real TTFT. TTFT is a single first-token event — keep chunk 1's only — while
    // the decode-rate denominator still uses the SUMMED per-chunk prefill time.
    const events: Array<{ index: number; total: number }> = [];
    const usage: WebLLMUsage = {
      prompt_tokens: 5,
      completion_tokens: 2,
      extra: { e2e_latency_s: 1, time_to_first_token_s: 0.1, decode_tokens_per_s: 20 },
    };
    const client = createMockEngineClient({ tokens: ['ok'], usage });
    const draft = await runReview({
      code: bigInput(),
      mode: 'bugs',
      locale: 'en',
      language: 'text',
      client,
      signal: { cancelled: false },
      onChunk: (p) => events.push(p),
    });
    const chunks = events.length;
    expect(chunks).toBeGreaterThan(1);
    // ttft is chunk 1's 0.1 s = 100 ms — NOT 100 * chunks (the old summed-across bug).
    expect(draft.timing.ttft_ms).toBe(100);
    // total_ms (e2e) still sums across the whole run.
    expect(draft.timing.total_ms).toBe(1000 * chunks);
    // Decode rate uses Σe2e − Σ(per-chunk ttft) as the denominator: completion=2N over
    // (N - 0.1N)=0.9N seconds ⇒ 2N / 0.9N ≈ 2.2 tok/s (independent of chunk count).
    expect(draft.timing.tok_per_sec).toBeCloseTo(2.2, 1);
  });
});
