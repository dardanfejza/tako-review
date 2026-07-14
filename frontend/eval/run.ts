import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium, type BrowserContext } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { startEvalServer, EVAL_PAGE } from './harness/serve';
import { allCases } from './cases/index';
import { runCase, aggregateTrials, type CaseResult } from './scorers/index';
import { buildReport, toMarkdown } from './report';
import { MODEL_VERSION, PROMPT_VERSION } from '../src/config/versions';
import { MODEL_LIB_URL, MODEL_HF_REVISION } from '../src/config/appConfig';
import type { ReviewDraft } from '../src/inference/reviewPipeline';

const usage = (msg: string): never => {
  console.error(
    `error: ${msg}\n` +
      'usage: run [--repeat N>=1] [--max-total-ms MS] [--min-tok-s N] ' +
      '[--strict-latency] [--strict-repeats]',
  );
  process.exit(2);
};

/**
 * Read a numeric flag. `validate` rejects malformed values up front so a missing/garbage `--repeat`
 * can't silently become NaN/0 — which downstream produces an empty trialResults array and an
 * undefined `trialResults.at(-1)!`, crashing report generation.
 */
const arg = (k: string, d: number, validate: (n: number) => boolean): number => {
  const i = process.argv.indexOf(k);
  if (i < 0) return d;
  const raw = process.argv[i + 1];
  const n = Number(raw);
  if (raw === undefined || raw.startsWith('--') || !validate(n)) usage(`invalid value for ${k}: ${raw ?? '(missing)'}`);
  return n;
};
const has = (k: string) => process.argv.includes(k);
const positiveInt = (n: number) => Number.isInteger(n) && n >= 1;
const positiveFinite = (n: number) => Number.isFinite(n) && n > 0;
const REPEAT = arg('--repeat', 1, positiveInt);
const strictLatency = has('--strict-latency');
const strictRepeats = has('--strict-repeats');
// Baseline from spike 2026-06-10: warm gen 5496ms, 37.5 tok/s. 4x headroom on time; 40% floor on rate.
const BUDGET = { maxTotalMs: arg('--max-total-ms', 25000, positiveFinite), minTokPerSec: arg('--min-tok-s', 15, positiveFinite) };

/** Stable fingerprint of the WHOLE case set, so editing a case (without changing the count) changes
 *  the hash and reports stay comparable across case-set edits. */
const caseSetHash = createHash('sha256').update(JSON.stringify(allCases)).digest('hex').slice(0, 12);

let server: ViteDevServer | undefined;
let ctx: BrowserContext | undefined;
try {
  server = await startEvalServer();
  ctx = await chromium.launchPersistentContext('.eval-cache', {
    channel: 'chrome', headless: true,
    // PERMIT, not force: recent headless Chrome gates WebGPU behind this flag, but with a real
    // adapter present (the documented macOS + Metal target machine) Chrome uses that real GPU —
    // SwiftShader is only the fallback when no hardware adapter exists. The committed baseline is
    // produced on real Metal/WebGPU; run on a GPU-less box (no real adapter) is unrepresentative,
    // which is why this stays a local pre-push gate, not cloud CI (see README "Requirements").
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await ctx!.newPage();
  await page.goto(EVAL_PAGE);
  await page.waitForFunction('window.__evalReady === true', { timeout: 600_000 });

  const results: CaseResult[] = [];
  const trialLog: { id: string; trial: number; seed: number; output: string }[] = [];
  for (const c of allCases) {
    const trialPasses: boolean[] = [];
    const trialResults: CaseResult[] = [];
    for (let t = 0; t < REPEAT; t++) {
      const seed = 1000 + t;
      const draft = (await page.evaluate(
        ([cc, s]: [unknown, number]) => (window as unknown as { __runEval: (c: unknown, seed: number) => unknown })['__runEval'](cc, s),
        [c, seed] as [unknown, number],
      )) as ReviewDraft;
      const r = runCase(c, draft, { budget: BUDGET, strictLatency });
      trialPasses.push(r.pass);
      trialResults.push(r);
      trialLog.push({ id: c.id, trial: t, seed, output: draft.review_output });
    }
    const aggPass = aggregateTrials(trialPasses, { strictRepeats });
    // Use checks from the first majority-winning trial so the report reflects
    // the representative run, not always the last trial (which may have failed).
    const rep = aggPass ? (trialResults.find((r) => r.pass) ?? trialResults.at(-1)!) : trialResults.at(-1)!;
    results.push({ ...rep, pass: aggPass });
  }

  const report = buildReport(results, {
    modelVersion: MODEL_VERSION, promptVersion: PROMPT_VERSION,
    libSha: MODEL_LIB_URL.match(/\/([0-9a-f]{40})\//)?.[1] ?? MODEL_LIB_URL,
    hfRevision: MODEL_HF_REVISION,
    repeats: REPEAT, caseSetHash,
  });
  mkdirSync(new URL('./reports/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./reports/latest.json', import.meta.url), JSON.stringify({ ...report, trials: trialLog }, null, 2));
  writeFileSync(new URL('./reports/latest.md', import.meta.url), toMarkdown(report));
  console.log(toMarkdown(report));
  process.exitCode = report.passRate >= 1 ? 0 : 1;
} finally {
  await ctx?.close();
  await server?.close();
}
