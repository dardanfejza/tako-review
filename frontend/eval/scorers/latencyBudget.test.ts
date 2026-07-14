import { describe, it, expect } from 'vitest';
import { latencyBudget } from './latencyBudget';
import type { EvalCase } from '../cases/types';
import type { ReviewDraft } from '../../src/inference/reviewPipeline';

const c = (locale: EvalCase['locale']): EvalCase => ({ id: 't', mode: 'bugs', locale, category: 'core', code: 'x', expect: {} });
const draft = (review_output: string): ReviewDraft => ({ code_text: '', review_output, review_mode: 'bugs', language: 'en', model_version: 'm', prompt_version: 'p', code_hash: 'h', timing: { load_ms: 0, ttft_ms: 0, total_ms: 0, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0 } });

const withTiming = (total_ms: number, tok_per_sec: number): ReviewDraft => ({ ...draft('x'), timing: { load_ms: 0, ttft_ms: 0, total_ms, tokens_prompt: 0, tokens_completion: 0, tok_per_sec } });

describe('latency_budget', () => {
  const scorer = latencyBudget({ maxTotalMs: 20000, minTokPerSec: 10 });
  it('passes within budget', () => expect(scorer(c('en'), withTiming(8000, 25)).pass).toBe(true));
  it('fails when too slow', () => expect(scorer(c('en'), withTiming(30000, 25)).pass).toBe(false));
  it('fails when decode rate too low', () => expect(scorer(c('en'), withTiming(8000, 4)).pass).toBe(false));
});
