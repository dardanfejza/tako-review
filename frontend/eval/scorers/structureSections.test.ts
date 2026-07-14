import { describe, it, expect } from 'vitest';
import { structureSections } from './structureSections';
import type { EvalCase } from '../cases/types';
import type { ReviewDraft } from '../../src/inference/reviewPipeline';

const c = (locale: EvalCase['locale']): EvalCase => ({ id: 't', mode: 'bugs', locale, category: 'core', code: 'x', expect: {} });
const draft = (review_output: string): ReviewDraft => ({ code_text: '', review_output, review_mode: 'bugs', language: 'en', model_version: 'm', prompt_version: 'p', code_hash: 'h', timing: { load_ms: 0, ttft_ms: 0, total_ms: 0, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0 } });

describe('structure_sections', () => {
  it('passes when both EN sections present', () => {
    expect(structureSections(c('en'), draft('## Summary\nok\n## Issues\n- none')).pass).toBe(true);
  });
  it('fails when a section is missing', () => {
    expect(structureSections(c('en'), draft('## Summary\nonly')).pass).toBe(false);
  });
  it('checks JA headings for ja locale', () => {
    expect(structureSections(c('ja'), draft('## 概要\n要約\n## 問題点\n- なし')).pass).toBe(true);
  });
});
