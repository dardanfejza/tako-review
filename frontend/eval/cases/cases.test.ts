import { describe, it, expect } from 'vitest';
import { allCases } from './index';
import { withLineNumbers } from '../../src/lib/lineNumber';
import { needsChunking } from '../../src/lib/chunker';
import { CONTEXT_BUDGET_TOKENS } from '../../src/config/appConfig';

describe('eval case set integrity', () => {
  it('has unique ids', () => {
    const ids = allCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('planted lines fall within the snippet', () => {
    for (const c of allCases) {
      const n = c.code.split('\n').length;
      for (const p of c.expect.plantedLines ?? []) {
        expect(p.line, `${c.id} line ${p.line}/${n}`).toBeGreaterThanOrEqual(1);
        expect(p.line, `${c.id} line ${p.line}/${n}`).toBeLessThanOrEqual(n);
      }
    }
  });
  it('the edge "long" case actually triggers the chunking path', () => {
    // The size gate measures the line-numbered text (what becomes code_text), not the raw paste,
    // so the case only exercises the map/reduce chunker if needsChunking() fires on that.
    const long = allCases.find((c) => c.id === 'edge-py-long-en');
    expect(long, 'edge-py-long-en case missing').toBeDefined();
    expect(needsChunking(withLineNumbers(long!.code), CONTEXT_BUDGET_TOKENS)).toBe(true);
  });
});
