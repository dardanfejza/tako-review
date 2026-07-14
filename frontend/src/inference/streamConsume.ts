import type { CancelSignal, GenResult } from './types';

/** The slice of a web-llm streaming chunk this module reads. */
export interface StreamChunk {
  choices: Array<{ delta?: { content?: string | null } }>;
  usage?: GenResult['usage'];
}

/**
 * Consume a web-llm streaming completion with cooperative cancel, accumulating text + usage.
 * Extracted from the worker client so it can be unit-tested without pulling @mlc-ai/web-llm into
 * the CI graph (the real `create()` + worker stay in engineClient.ts).
 *
 * CANCEL CONTRACT — DO NOT "simplify" the drain back to a `break` (web-llm 0.2.84):
 * `chatCompletion()` acquires a per-model `CustomLock` and its streaming generator (`asyncGenerate`)
 * releases it ONLY by running to its natural end (lib/index.js: acquire @ ~12901, release @ ~12867).
 * `break`ing this `for await` calls `.return()` on the chunk generator, abandoning the worker-side
 * generator BEFORE that `release()` — so the lock leaks and the NEXT `create()` deadlocks forever on
 * `lock.acquire()`, soft-locking the whole app until a page refresh (observed: Stop a review, start
 * another -> "Reviewing…" hangs and history/new-review stop responding). So on cancel we interrupt
 * ONCE (which makes the worker generator stop decoding and emit its terminal chunks) and keep
 * DRAINING, letting web-llm release the lock itself. The interrupt makes the drain terminate after at
 * most one more decode step, so this is not a "finish the whole generation" wait.
 */
export async function consumeCancellableStream(
  completion: AsyncIterable<StreamChunk>,
  // May be sync or async — web_worker.d.ts types interruptGenerate() as `(): void` though it is
  // async at runtime; `await` handles both. Returns `unknown` so either signature is assignable.
  interrupt: () => unknown,
  onToken: (delta: string) => void,
  signal: CancelSignal,
): Promise<GenResult> {
  let text = '';
  let usage: GenResult['usage'];
  let interrupted = false;
  for await (const chunk of completion) {
    // Capture usage in every branch: the terminal usage chunk also arrives while draining a cancel.
    if (chunk.usage) usage = chunk.usage;
    if (signal.cancelled) {
      if (!interrupted) {
        interrupted = true;
        try {
          await interrupt();
        } catch {
          // A rejecting interruptGenerate() still degrades to a clean cancel — the drain below
          // terminates the generator and frees the lock regardless. (N-20b)
        }
      }
      continue; // DRAIN to the generator's end — never break (see the cancel contract above)
    }
    const delta = chunk.choices[0]?.delta?.content ?? '';
    if (delta) {
      text += delta;
      onToken(delta);
    }
  }
  return { text, usage };
}
