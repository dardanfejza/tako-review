import type { Scorer } from './types';
import { issuesSection } from './types';

const SEV_EN = /\b(high|medium|low)\b/gi;
// Japanese severity markers: **高:**, **中:**, **低:** or 高リスク/中リスク/低リスク compound words
const SEV_JA = /高リスク|中リスク|低リスク|\*\*(高|中|低)[:\s]/g;

export const severityVocab: Scorer = (c, d) => {
  if ((c.expect.maxIssues ?? Infinity) === 0 || c.category === 'negative') {
    return { name: 'severity_vocab', pass: true, detail: 'control/negative: severity not required' };
  }
  const issues = issuesSection(d.review_output, c.locale);
  const enFound = issues.match(SEV_EN) ?? [];
  if (enFound.length > 0) {
    return { name: 'severity_vocab', pass: true, detail: `${enFound.length} severity tag(s)` };
  }
  if (c.locale === 'ja') {
    const jaFound = issues.match(SEV_JA) ?? [];
    if (jaFound.length > 0) {
      return { name: 'severity_vocab', pass: true, detail: `${jaFound.length} ja severity tag(s)` };
    }
  }
  return { name: 'severity_vocab', pass: false, detail: 'no high/medium/low severity in Issues' };
};
