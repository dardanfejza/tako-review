import { describe, it, expect } from 'vitest';
import { severityVocab } from './severityVocab';
import type { EvalCase } from '../cases/types';
import type { ReviewDraft } from '../../src/inference/reviewPipeline';

const c = (locale: EvalCase['locale']): EvalCase => ({ id: 't', mode: 'bugs', locale, category: 'core', code: 'x', expect: {} });
const draft = (review_output: string): ReviewDraft => ({ code_text: '', review_output, review_mode: 'bugs', language: 'en', model_version: 'm', prompt_version: 'p', code_hash: 'h', timing: { load_ms: 0, ttft_ms: 0, total_ms: 0, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0 } });

describe('severity_vocab', () => {
  it('passes when a severity tag is present in Issues', () => {
    expect(severityVocab(c('en'), draft('## Issues\n- **high** L3: bug')).pass).toBe(true);
  });
  it('fails when issues are expected but no severity tag appears', () => {
    const cc = { ...c('en'), expect: { minIssues: 1 } };
    expect(severityVocab(cc, draft('## Issues\n- something is wrong on L3')).pass).toBe(false);
  });
  it('passes a control case that expects zero issues', () => {
    const cc = { ...c('en'), category: 'negative' as const, expect: { maxIssues: 0 } };
    expect(severityVocab(cc, draft('## Issues\n- none')).pass).toBe(true);
  });
  it('passes a negative-category case even with no severity tags', () => {
    const cc = { ...c('en'), category: 'negative' as const, expect: {} };
    expect(severityVocab(cc, draft('## Issues\n- style notes only, no severity tag')).pass).toBe(true);
  });
  it('passes JA locale with bold Japanese severity marker **高:**', () => {
    expect(severityVocab(c('ja'), draft('## 問題点\n* **高:** null チェックがありません')).pass).toBe(true);
  });
  it('passes JA locale with 高リスク compound word', () => {
    expect(severityVocab(c('ja'), draft('## 問題点\n* **高リスク:** セキュリティ問題')).pass).toBe(true);
  });
  it('fails JA locale when no severity marker of any kind appears', () => {
    expect(severityVocab(c('ja'), draft('## 問題点\n* **命名:** 変数名が不明瞭です')).pass).toBe(false);
  });
});
