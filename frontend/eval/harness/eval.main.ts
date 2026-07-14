import { runReview } from '../../src/inference/reviewPipeline';
import { createEngineClient } from '../../src/inference/engineClient';
import type { EvalCase } from '../cases/types';

let clientPromise: ReturnType<typeof load> | null = null;
async function load() {
  const client = createEngineClient();
  const t0 = performance.now();
  await client.load(() => {});
  return { client, loadMs: performance.now() - t0 };
}

(window as unknown as Record<string, unknown>).__runEval = async (c: EvalCase, seed?: number) => {
  if (!clientPromise) clientPromise = load();
  const { client, loadMs } = await clientPromise;
  return runReview({
    code: c.code, mode: c.mode, locale: c.locale, language: c.locale,
    client, signal: { cancelled: false }, loadMs, seed,
  });
};
(window as unknown as Record<string, unknown>).__evalReady = true;
