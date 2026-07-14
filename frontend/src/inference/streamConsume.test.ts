import { describe, it, expect } from 'vitest';
import { consumeCancellableStream, type StreamChunk } from './streamConsume';
import type { CancelSignal } from './types';

/**
 * Minimal mutex mirroring web-llm 0.2.84's `CustomLock` (lib/index.js): `acquire()` resolves
 * immediately when free, else queues until a `release()`. There is NO timeout — a leaked lock
 * deadlocks every future acquire() forever, which is the production soft-lock this suite guards.
 */
class FakeLock {
  private held = false;
  private queue: Array<() => void> = [];
  acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.held = false;
  }
  get isHeld(): boolean {
    return this.held;
  }
}

/**
 * Faithful stand-in for web-llm's worker engine: `create()` acquires a shared per-model lock and
 * returns a streaming generator that releases it ONLY on natural completion — the `release()` is
 * the generator's LAST statement, NOT inside a `finally`, so a `.return()` (i.e. an early `break`
 * in the consumer) abandons it and LEAKS the lock, exactly like web-llm's `asyncGenerate`
 * (acquire @ chatCompletion ~12901, release @ asyncGenerate tail ~12867). `interruptGenerate()`
 * sets a flag honored at the top of the decode loop.
 */
function makeFakeWorkerEngine(tokens: string[]) {
  const lock = new FakeLock();
  let interrupted = false;

  async function* stream(): AsyncGenerator<StreamChunk> {
    for (const tok of tokens) {
      if (interrupted) break; // interruptSignal honored at the top of the decode loop
      yield { choices: [{ delta: { content: tok } }] };
    }
    // Terminal chunk + usage chunk, then release — mirrors asyncGenerate's tail. Because the
    // release is reached only by running to the end, a consumer that `break`s never frees it.
    yield { choices: [{ delta: {} }] };
    yield {
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: tokens.length, total_tokens: tokens.length },
    };
    lock.release(); // LAST statement: skipped when the generator is abandoned via .return()
  }

  return {
    lock,
    interruptGenerate: async (): Promise<void> => {
      interrupted = true;
    },
    async create(): Promise<AsyncGenerator<StreamChunk>> {
      interrupted = false; // web-llm resets interruptSignal at the start of each generation
      await lock.acquire(); // blocks forever if a prior run leaked the lock
      return stream();
    },
  };
}

/** Reject if `p` doesn't settle within `ms` — turns a production deadlock into a fast test failure. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms),
    ),
  ]);
}

describe('consumeCancellableStream', () => {
  it('streams every token in order and captures usage on the happy path', async () => {
    const engine = makeFakeWorkerEngine(['Hel', 'lo', '!']);
    const signal: CancelSignal = { cancelled: false };
    const seen: string[] = [];

    const res = await consumeCancellableStream(
      await engine.create(),
      engine.interruptGenerate,
      (d) => seen.push(d),
      signal,
    );

    expect(seen).toEqual(['Hel', 'lo', '!']);
    expect(res.text).toBe('Hello!');
    expect(res.usage?.completion_tokens).toBe(3);
    expect(engine.lock.isHeld).toBe(false);
  });

  it('releases the web-llm lock after a cancel so the NEXT generation is not deadlocked', async () => {
    // Reproduces the reported bug: start a review, Stop it, start again -> "Reviewing…" forever
    // and the whole app soft-locks until refresh, because the cancelled run leaked the engine lock.
    const engine = makeFakeWorkerEngine(['a', 'b', 'c', 'd', 'e']);

    // Run 1: press Stop after the first token reaches the UI.
    const signal1: CancelSignal = { cancelled: false };
    const seen1: string[] = [];
    await withTimeout(
      consumeCancellableStream(
        await engine.create(),
        engine.interruptGenerate,
        (d) => {
          seen1.push(d);
          signal1.cancelled = true; // Stop pressed mid-stream
        },
        signal1,
      ),
      2000,
      'first (cancelled) run',
    );

    expect(seen1).toEqual(['a']); // stopped surfacing tokens at the Stop point
    // The lock MUST be free again — a leak here is precisely the production soft-lock.
    expect(engine.lock.isHeld).toBe(false);

    // Run 2 (the "restart"): must acquire the lock and run to completion, not hang.
    const signal2: CancelSignal = { cancelled: false };
    const seen2: string[] = [];
    const res2 = await withTimeout(
      engine
        .create()
        .then((c) => consumeCancellableStream(c, engine.interruptGenerate, (d) => seen2.push(d), signal2)),
      2000,
      'second (restart) run',
    );

    expect(res2.text).toBe('abcde');
    expect(seen2).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(engine.lock.isHeld).toBe(false);
  });
});
