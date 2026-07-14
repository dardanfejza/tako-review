import { withLineNumbers } from '../lib/lineNumber';
import { needsChunking, splitIntoChunks } from '../lib/chunker';
import { sha256Hex } from '../lib/hash';
import { mapUsage, type WebLLMUsage } from '../lib/telemetry';
import { promptFor } from '../config/prompts';
import { CONTEXT_BUDGET_TOKENS } from '../config/appConfig';
import { DEFAULT_GEN_OPTIONS } from '../config/sampling';
import { MODEL_VERSION, PROMPT_VERSION } from '../config/versions';
import type { EngineClient, CancelSignal, ChatMessage } from './types';
import type { ReviewCreate, ReviewMode, UiLanguage } from '../types/api';

/** The review fields the pipeline computes locally; the UI adds client_id/device_class/filename. */
export type ReviewDraft = Omit<ReviewCreate, 'client_id' | 'device_class' | 'filename'>;

/**
 * The server caps `code_text` at 262144 BYTES (api-contract §). The stored value is the
 * LINE-NUMBERED text, so the client must measure `withLineNumbers(code)` — not the raw paste — to
 * match the server's check exactly and fail fast before a full on-device inference is wasted.
 */
export const MAX_CODE_BYTES = 262144;

/** UTF-8 byte length of the value actually stored as `code_text` (the line-numbered text). */
export function codeTextBytes(code: string): number {
  return new TextEncoder().encode(withLineNumbers(code)).length;
}

/** Thrown when the line-numbered code is empty or exceeds {@link MAX_CODE_BYTES}. */
export class CodeTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`code_text is ${bytes} bytes (limit ${MAX_CODE_BYTES})`);
    this.name = 'CodeTooLargeError';
    this.bytes = bytes;
  }
}

/**
 * Thrown when a chunked (map/reduce) review attempted ≥1 chunk and EVERY chunk's generate() failed
 * — i.e. the run produced no real review, only "_Review failed_" placeholders. Surfacing this as
 * an error (rather than resolving) lets the caller beacon `ok:false` and skip the history save, so
 * a fully-failed run is not recorded as a zero-latency success (review §4). When only SOME chunks
 * fail the run still resolves (partial result) — `partial` flags that case for callers that care.
 */
export class AllChunksFailedError extends Error {
  readonly attempted: number;
  constructor(attempted: number) {
    super(`all ${attempted} review chunk(s) failed`);
    this.name = 'AllChunksFailedError';
    this.attempted = attempted;
  }
}

export interface RunReviewArgs {
  code: string;
  mode: ReviewMode;
  locale: UiLanguage;
  /** Content/review language label stored on the record (distinct from the UI locale). */
  language: string;
  client: EngineClient;
  signal: CancelSignal;
  loadMs?: number;
  /** Optional RNG seed forwarded to GenOptions for reproducible eval outputs (eval §7). */
  seed?: number;
  onToken?: (buffer: string) => void;
  onChunk?: (progress: { index: number; total: number }) => void;
}

const msgs = (system: string, user: string): ChatMessage[] => [
  { role: 'system', content: system },
  { role: 'user', content: user },
];

/**
 * Per-chunk TTFT accumulator (review §4 "TTFT summed across chunks"). `time_to_first_token_s` is
 * a SINGLE-event measurement — the latency to the first decoded token — so it MUST come from chunk
 * 1 only; summing it across N chunks reports N× reality and skews the load-dependent p50/p95/p99.
 * But the decode-rate denominator still needs the *total* prefill time across chunks
 * (`decodeSeconds = Σe2e − Σper-chunk-ttft`). We therefore carry the summed per-chunk TTFT
 * separately, out of band of the reported `time_to_first_token_s`, so the existing correct decode
 * rate is preserved while the reported TTFT stays chunk 1's.
 */
const TTFT_SUM = Symbol('ttftSumS');
type UsageAccumulator = WebLLMUsage & { extra?: WebLLMUsage['extra'] & { [TTFT_SUM]?: number } };

/**
 * Fold two `usage` objects across chunks so the timing badge + telemetry reflect the WHOLE
 * multi-chunk run, not just the last chunk (FE §4.7). Token counts add; e2e seconds add. The
 * REPORTED `time_to_first_token_s` is kept from the FIRST chunk only (`a` is the accumulator, `b`
 * the new chunk); the per-chunk TTFTs are summed into a hidden accumulator used purely for the
 * decode-rate denominator. The decode rate is recomputed from total completion tokens ÷ total
 * decode seconds (falling back to a per-chunk rate when seconds are unavailable). Returns
 * undefined only if BOTH inputs are undefined. Fields are read defensively (`WebLLMUsage` is
 * all-optional).
 */
function combineUsage(
  a: UsageAccumulator | undefined,
  b: UsageAccumulator | undefined,
): UsageAccumulator | undefined {
  if (!a) return b;
  if (!b) return a;
  const prompt = (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0);
  const completion = (a.completion_tokens ?? 0) + (b.completion_tokens ?? 0);
  const e2e = (a.extra?.e2e_latency_s ?? 0) + (b.extra?.e2e_latency_s ?? 0);
  // Reported TTFT = chunk 1's only (the accumulator `a` already holds it on the 2nd+ fold).
  const reportedTtft = a.extra?.time_to_first_token_s ?? b.extra?.time_to_first_token_s;
  // Summed per-chunk TTFT — denominator only; `a` carries the running sum, `b` adds its own.
  const ttftSum =
    (a.extra?.[TTFT_SUM] ?? a.extra?.time_to_first_token_s ?? 0) +
    (b.extra?.time_to_first_token_s ?? 0);
  const decodeSeconds = e2e - ttftSum;
  const decodeRate =
    decodeSeconds > 0
      ? completion / decodeSeconds
      : (b.extra?.decode_tokens_per_s ?? a.extra?.decode_tokens_per_s ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    extra: {
      e2e_latency_s: e2e,
      time_to_first_token_s: reportedTtft,
      [TTFT_SUM]: ttftSum,
      decode_tokens_per_s: decodeRate,
      prefill_tokens_per_s: b.extra?.prefill_tokens_per_s ?? a.extra?.prefill_tokens_per_s,
      time_per_output_token_s: b.extra?.time_per_output_token_s ?? a.extra?.time_per_output_token_s,
    },
  };
}

/**
 * Orchestrates one review (FE §4.5): line-number the input, select the mode×locale prompt,
 * budget-check (single-shot vs map/reduce chunking), stream generation, then assemble the draft
 * with mapUsage timing + a client-computed code_hash. The finalized text IS the accumulated
 * streamed buffer (no getMessage() read-back), so a cancel mid-stream keeps the partial text.
 */
export async function runReview(args: RunReviewArgs): Promise<ReviewDraft> {
  const { code, mode, locale, language, client, signal, onToken, onChunk } = args;
  const genOptions = { ...DEFAULT_GEN_OPTIONS, seed: args.seed };
  const codeText = withLineNumbers(code);
  // Fail fast: the server rejects empty or >256 KB code_text with a 422, so refuse here —
  // BEFORE client.generate — rather than waste a full on-device inference on a doomed POST.
  const bytes = new TextEncoder().encode(codeText).length;
  if (bytes === 0 || bytes > MAX_CODE_BYTES) throw new CodeTooLargeError(bytes);
  const system = promptFor(mode, locale);
  let usage: WebLLMUsage | undefined;
  let output: string;

  if (!needsChunking(codeText, CONTEXT_BUDGET_TOKENS)) {
    onChunk?.({ index: 1, total: 1 });
    let buffer = '';
    const res = await client.generate(
      msgs(system, codeText),
      genOptions,
      (delta) => {
        buffer += delta;
        onToken?.(buffer);
      },
      signal,
    );
    usage = combineUsage(usage, res.usage);
    output = buffer; // accumulated buffer is the source of truth (§4.5); partial on cancel
  } else {
    const chunks = splitIntoChunks(codeText, { budgetTokens: CONTEXT_BUDGET_TOKENS });
    const sections: string[] = [];
    let succeeded = 0;
    let attempted = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (signal.cancelled) break;
      const chunk = chunks[i]!;
      attempted += 1;
      onChunk?.({ index: i + 1, total: chunks.length });
      const header = `### Section ${i + 1} of ${chunks.length} (lines ${chunk.startLine}-${chunk.endLine})`;
      // Build the already-finished sections ONCE per chunk, not once per token. The streaming
      // callback then only appends this chunk's header + live buffer, so per-token work is
      // O(buffer) rather than O(whole transcript). Re-joining `[...sections, …]` on every delta
      // made this path O(n²) over the output and partly defeated the 10 Hz UI throttle upstream.
      // (Emitted string is identical: prefix + header + buffer == [...sections, header+buffer].join.)
      const prefix = sections.length ? `${sections.join('\n\n')}\n\n` : '';
      let buffer = '';
      try {
        const res = await client.generate(
          msgs(system, chunk.text),
          genOptions,
          (delta) => {
            buffer += delta;
            onToken?.(`${prefix}${header}\n\n${buffer}`);
          },
          signal,
        );
        usage = combineUsage(usage, res.usage);
        sections.push(`${header}\n\n${buffer}`);
        succeeded += 1;
      } catch {
        // Partial-failure tolerant: surface this chunk's failure, keep the rest (§4.6).
        sections.push(`${header}\n\n_Review failed for this section._`);
      }
    }
    // If we ATTEMPTED at least one chunk and EVERY attempt failed, the run produced no real review
    // — only "_Review failed_" placeholders with zeroed timing. Resolving here would beacon a
    // SUCCESS (`ok:true`, ttft/total/tok_per_sec all absent/0) and save a junk record. Throw so the
    // caller's catch fires GEN_ERROR / `ok:false` and skips the save (review §4 "all-chunks-failed
    // review beacons ok:true"). A cancel before the first attempt (attempted === 0) is NOT a
    // failure — it falls through with whatever partial sections exist.
    if (attempted > 0 && succeeded === 0) {
      throw new AllChunksFailedError(attempted);
    }
    output = sections.join('\n\n');
  }

  return {
    code_text: codeText,
    review_output: output,
    review_mode: mode,
    language,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    code_hash: await sha256Hex(codeText),
    timing: mapUsage(usage, args.loadMs ?? 0),
  };
}
