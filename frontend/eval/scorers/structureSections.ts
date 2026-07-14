import type { Scorer } from './types';
import type { EvalCase } from '../cases/types';

const SECTIONS: Record<EvalCase['locale'], [string, string]> = {
  en: ['## Summary', '## Issues'],
  ja: ['## 概要', '## 問題点'],
};

export const structureSections: Scorer = (c, d) => {
  const [a, b] = SECTIONS[c.locale];
  const out = d.review_output;
  const pass = out.includes(a) && out.includes(b);
  return { name: 'structure_sections', pass, detail: pass ? 'both sections present' : `missing ${out.includes(a) ? b : a}` };
};
