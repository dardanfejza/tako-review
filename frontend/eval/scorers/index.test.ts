import { describe, it, expect } from 'vitest';
import { runCase, aggregateTrials } from './index';
import type { EvalCase } from '../cases/types';
import type { ReviewDraft } from '../../src/inference/reviewPipeline';

const c = (locale: EvalCase['locale']): EvalCase => ({ id: 't', mode: 'bugs', locale, category: 'core', code: 'x', expect: {} });
const draft = (review_output: string): ReviewDraft => ({ code_text: '', review_output, review_mode: 'bugs', language: 'en', model_version: 'm', prompt_version: 'p', code_hash: 'h', timing: { load_ms: 0, ttft_ms: 0, total_ms: 0, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0 } });

const budget = { maxTotalMs: 60000, minTokPerSec: 1 };
describe('runCase', () => {
  it('a clean core review passes all required checks', () => {
    const cc = { ...c('en'), code: 'a\nb\nc', category: 'core' as const, expect: { plantedLines: [{ line: 2 }] } };
    const out = '## Summary\nok\n## Issues\n- **high** L2: bug';
    const r = runCase(cc, draft(out), { budget, strictLatency: false });
    expect(r.pass).toBe(true);
    expect(r.checks.find((x) => x.name === 'planted_bug_hit')!.required).toBe(true);
  });
  it('latency only gates when strictLatency', () => {
    const slow = { ...draft('## Summary\nx\n## Issues\n- **low** L1'), timing: { load_ms: 0, ttft_ms: 0, total_ms: 999999, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0.1 } };
    const cc = { ...c('en'), code: 'a', category: 'negative' as const, expect: { maxIssues: 1 } };
    expect(runCase(cc, slow, { budget, strictLatency: false }).pass).toBe(true);
    expect(runCase(cc, slow, { budget, strictLatency: true }).pass).toBe(false);
  });
});
describe('aggregateTrials', () => {
  it('majority by default', () => {
    expect(aggregateTrials([true, true, false], { strictRepeats: false })).toBe(true);
    expect(aggregateTrials([true, false, false], { strictRepeats: false })).toBe(false);
  });
  it('all required under strictRepeats', () => {
    expect(aggregateTrials([true, true, false], { strictRepeats: true })).toBe(false);
  });
});
