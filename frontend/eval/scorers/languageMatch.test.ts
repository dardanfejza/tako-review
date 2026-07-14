import { describe, it, expect } from 'vitest';
import { languageMatch } from './languageMatch';
import type { EvalCase } from '../cases/types';
import type { ReviewDraft } from '../../src/inference/reviewPipeline';

const c = (locale: EvalCase['locale']): EvalCase => ({ id: 't', mode: 'bugs', locale, category: 'core', code: 'x', expect: {} });
const draft = (review_output: string): ReviewDraft => ({ code_text: '', review_output, review_mode: 'bugs', language: 'en', model_version: 'm', prompt_version: 'p', code_hash: 'h', timing: { load_ms: 0, ttft_ms: 0, total_ms: 0, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0 } });

describe('language_match', () => {
  it('passes ja output containing kana/kanji', () => {
    expect(languageMatch(c('ja'), draft('## 概要\nこのコードには問題があります')).pass).toBe(true);
  });
  it('fails ja locale with English-only output', () => {
    expect(languageMatch(c('ja'), draft('This code has a bug')).pass).toBe(false);
  });
  it('passes en output with no CJK', () => {
    expect(languageMatch(c('en'), draft('This code has a bug')).pass).toBe(true);
  });
});
