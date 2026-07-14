// Slice 0 spike (eval spec §9.2) — de-risk the one load-bearing unknown:
// does Playwright-driven Chrome actually run WebLLM/WebGPU here, load the (now-corrected)
// model lib, and generate a non-empty structured review? Also captures a warm-gen latency
// baseline for the §7 budget. NOT a seed probe (seed support is Task 15). Throwaway.
import { chromium } from '@playwright/test';
import { startEvalServer, EVAL_PAGE } from './harness/serve';
import type { EvalCase } from './cases/types';

const CASE: EvalCase = {
  id: 'spike',
  mode: 'bugs',
  locale: 'en',
  category: 'core',
  code: 'def add(a, b):\n    return a - b\n',
  expect: { plantedLines: [{ line: 2 }] },
};

const server = await startEvalServer();
const ctx = await chromium.launchPersistentContext('.eval-cache', {
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'], // software-WebGPU fallback if no real adapter in headless
});
try {
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), '-', r.failure()?.errorText ?? ''));
  page.on('response', (r) => { if (r.status() >= 400) console.log('[http>=400]', r.status(), r.url()); });
  await page.goto(EVAL_PAGE);

  const gpu = await page.evaluate(async () => {
    const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } };
    if (!nav.gpu) return { ok: false, why: 'navigator.gpu absent' };
    const a = (await nav.gpu.requestAdapter()) as { info?: unknown } | null;
    return { ok: !!a, info: (a && a.info) ?? null };
  });
  console.log('WebGPU adapter:', JSON.stringify(gpu));
  if (!gpu.ok) throw new Error('No WebGPU adapter - spike FAILED');

  console.log('Loading model (first run downloads ~1 GB; watch [page] progress)...');
  await page.waitForFunction('window.__evalReady === true', { timeout: 600_000 });

  const t0 = Date.now();
  const gen = page.evaluate((c) => (window as unknown as { __runEval: (c: unknown) => Promise<unknown> }).__runEval(c), CASE);
  const cap = new Promise((_, rej) => setTimeout(() => rej(new Error('generation exceeded 300s (likely slow software WebGPU)')), 300_000));
  const draft = (await Promise.race([gen, cap])) as { review_output?: string; timing?: unknown };
  console.log(`review generated in ${Date.now() - t0}ms`);
  console.log('timing:', JSON.stringify(draft.timing));
  console.log('output (first 500 chars):\n' + String(draft.review_output ?? '').slice(0, 500));
  if (!draft.review_output || !draft.review_output.length) throw new Error('Empty review - spike FAILED');
  console.log('SPIKE OK');
} finally {
  await ctx.close();
  await server.close();
}
