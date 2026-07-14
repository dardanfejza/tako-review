import { describe, it, expect } from 'vitest';
import { citationsValid } from './citationsValid';
import type { EvalCase } from '../cases/types';
import type { ReviewDraft } from '../../src/inference/reviewPipeline';

const c = (locale: EvalCase['locale']): EvalCase => ({ id: 't', mode: 'bugs', locale, category: 'core', code: 'x', expect: {} });
const draft = (review_output: string): ReviewDraft => ({ code_text: '', review_output, review_mode: 'bugs', language: 'en', model_version: 'm', prompt_version: 'p', code_hash: 'h', timing: { load_ms: 0, ttft_ms: 0, total_ms: 0, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0 } });

const code5 = 'a\nb\nc\nd\ne'; // 5 lines

describe('citations_valid', () => {
  it('passes when all citations are in [1,N]', () => {
    const cc = { ...c('en'), code: code5 };
    expect(citationsValid(cc, draft('issue at L3 and lines 1-2')).pass).toBe(true);
  });
  it('fails on an out-of-range citation', () => {
    const cc = { ...c('en'), code: code5 };
    expect(citationsValid(cc, draft('see L9')).pass).toBe(false);
  });
});
