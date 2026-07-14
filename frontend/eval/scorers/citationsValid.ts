import type { Scorer } from './types';
import { parseCitations } from '../../src/lib/lineNumber';

export const citationsValid: Scorer = (c, d) => {
  const n = c.code.split('\n').length;
  const cites = parseCitations(d.review_output);
  const bad = cites.filter((ci) =>
    ci.kind === 'single' ? ci.line < 1 || ci.line > n : ci.start < 1 || ci.end > n || ci.start > ci.end,
  );
  const pass = bad.length === 0;
  return { name: 'citations_valid', pass, detail: pass ? `${cites.length} citation(s), all in [1,${n}]` : `${bad.length} out-of-range citation(s)` };
};
