import { describe, it, expect } from 'vitest';
import { buildReport, toMarkdown } from './report';

const results = [
  { id: 'a', pass: true, checks: [] },
  { id: 'b', pass: false, checks: [{ name: 'citations_valid', pass: false, detail: 'L9 out of range', required: true }] }
];
const meta = { modelVersion: 'M', promptVersion: 'P', libSha: 'abc', hfRevision: 'def', repeats: 3, caseSetHash: 'h' };

describe('report', () => {
  it('computes pass-rate and carries meta', () => {
    const r = buildReport(results as any, meta);
    expect(r.passRate).toBeCloseTo(0.5);
    expect(r.meta.modelVersion).toBe('M');
    expect(r.failures.map((f) => f.id)).toEqual(['b']);
  });
  it('markdown shows the pass-rate and failing checks', () => {
    const md = toMarkdown(buildReport(results as any, meta));
    expect(md).toContain('50%');
    expect(md).toContain('citations_valid');
  });
});
