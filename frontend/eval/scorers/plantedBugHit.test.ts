import { describe, it, expect } from 'vitest';
import { plantedBugHit } from './plantedBugHit';
import type { EvalCase } from '../cases/types';
import type { ReviewDraft } from '../../src/inference/reviewPipeline';

const c = (locale: EvalCase['locale']): EvalCase => ({ id: 't', mode: 'bugs', locale, category: 'core', code: 'x', expect: {} });
const draft = (review_output: string): ReviewDraft => ({ code_text: '', review_output, review_mode: 'bugs', language: 'en', model_version: 'm', prompt_version: 'p', code_hash: 'h', timing: { load_ms: 0, ttft_ms: 0, total_ms: 0, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0 } });

const code3 = 'def add(a,b):\n    # adds\n    return a - b';
describe('planted_bug_hit', () => {
  it('passes when a citation lands near the planted line and the term is mentioned', () => {
    const cc = { ...c('en'), code: code3, expect: { plantedLines: [{ line: 3, mustMentionAny: ['subtract', '-'] }] } };
    // 'subtract' matches as a whole word; keyword matching is boundary-anchored, not substring.
    expect(plantedBugHit(cc, draft('**high** L3: this will subtract instead of add')).pass).toBe(true);
  });
  it('fails when the planted line is never cited', () => {
    const cc = { ...c('en'), code: code3, expect: { plantedLines: [{ line: 3 }] } };
    expect(plantedBugHit(cc, draft('looks fine to me')).pass).toBe(false);
  });
  it('is n/a (pass) when there are no planted lines', () => {
    expect(plantedBugHit({ ...c('en'), code: code3, expect: {} }, draft('anything')).pass).toBe(true);
  });
  it('FAILS on a keyword hit with no covering citation (citation is REQUIRED, not a bonus)', () => {
    // Old behavior waived the citation on any keyword hit; that lets the model pass by paraphrasing
    // without ever pointing at the line. A find must both name the defect AND cite the line.
    const cc = { ...c('en'), code: code3, expect: { plantedLines: [{ line: 3, mustMentionAny: ['subtract', '-'] }] } };
    expect(plantedBugHit(cc, draft('## Issues\n- the function subtracts instead of adding')).pass).toBe(false);
  });
  it('fails when mustMentionAny is set but no keyword appears (even with citation)', () => {
    const cc = { ...c('en'), code: code3, expect: { plantedLines: [{ line: 3, mustMentionAny: ['subtract', 'wrong operator'] }] } };
    expect(plantedBugHit(cc, draft('## Issues\n- L3: something looks off here')).pass).toBe(false);
  });
  it('still requires citation when no mustMentionAny is specified', () => {
    const cc = { ...c('en'), code: code3, expect: { plantedLines: [{ line: 3 }] } };
    expect(plantedBugHit(cc, draft('looks fine to me')).pass).toBe(false);
  });
  it('does NOT pass on an incidental substring that merely echoes the input', () => {
    // The model output here just restates the snippet ("return len(xs)") and cites L3, but never
    // diagnoses the off-by-one. The keyword 'len' must match on a word boundary so 'length' or an
    // echoed identifier alone is not mistaken for a finding... here 'len' DOES echo, so the guard
    // that matters is the keyword being discriminative AND requiring it: an output that says
    // 'index' incidentally without a covering citation must fail.
    const offByOne = 'def last_index(xs):\n    # returns index of last element\n    return len(xs)';
    const cc = { ...c('en'), code: offByOne, expect: { plantedLines: [{ line: 3, mustMentionAny: ['off-by-one'] }] } };
    // Output echoes 'index' and 'len' from the input and cites L3, but never says 'off-by-one'.
    const echo = draft('## Summary\nL3 returns len(xs); the index logic reads the list length. Looks fine.');
    expect(plantedBugHit(cc, echo).pass).toBe(false);
    // Real find: cites L3 AND names the discriminative defect term.
    expect(plantedBugHit(cc, draft('L3: off-by-one — should return len(xs) - 1')).pass).toBe(true);
  });
  it('matches keywords on word boundaries (sql does not match sqlite3)', () => {
    const sqlCase = 'q = f"SELECT * FROM users WHERE n = \'{u}\'"';
    const cc = { ...c('en'), code: sqlCase, expect: { plantedLines: [{ line: 1, mustMentionAny: ['sql'] }] } };
    // 'sqlite3' contains the substring 'sql' but is not the word 'sql' — must not count.
    expect(plantedBugHit(cc, draft('L1 uses sqlite3 to connect.')).pass).toBe(false);
    expect(plantedBugHit(cc, draft('L1 is an SQL injection.')).pass).toBe(true);
  });
});
