import type { Scorer } from './types';
import { parseCitations } from '../../src/lib/lineNumber';

const TOLERANCE = 2;

/** Escape a literal term for use inside a RegExp. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Match a keyword on a WORD BOUNDARY, not as a bare substring. Plain `includes` lets incidental
 * tokens the model merely echoes from the input (`-1`, `len`, `index`, `sql`) count as a "find",
 * systematically over-reporting model quality. We anchor the term so `len` does not match `length`
 * and `sql` does not match `sqlite3`. Boundaries are only applied on the side that begins/ends with
 * a word char — CJK terms (`ぬるぽ`, `危険`) and symbol-led terms (`-1`) carry no `\w` edge, so we
 * fall back to a plain (escaped) substring there, which is already discriminative enough.
 */
function mentions(haystack: string, term: string): boolean {
  const t = term.toLowerCase();
  const lead = /^\w/.test(t) ? '\\b' : '';
  const tail = /\w$/.test(t) ? '\\b' : '';
  return new RegExp(`${lead}${escapeRe(t)}${tail}`, 'i').test(haystack);
}

export const plantedBugHit: Scorer = (c, d) => {
  const planted = c.expect.plantedLines ?? [];
  if (planted.length === 0) return { name: 'planted_bug_hit', pass: true, detail: 'no planted lines (n/a)' };
  const cites = parseCitations(d.review_output);
  const out = d.review_output;
  const covers = (line: number) =>
    cites.some((ci) =>
      ci.kind === 'single' ? Math.abs(ci.line - line) <= TOLERANCE : line >= ci.start - TOLERANCE && line <= ci.end + TOLERANCE,
    );
  const missed = planted.filter((p) => {
    // A planted bug counts as found only when the model BOTH cites a covering line AND names the
    // defect. Either alone is insufficient: a citation with no keyword may be an unrelated comment,
    // and a keyword with no citation is often an echo of the input. (No keywords ⇒ citation only.)
    if (!covers(p.line)) return true;
    if (!p.mustMentionAny) return false;
    return !p.mustMentionAny.some((t) => mentions(out, t));
  });
  const pass = missed.length === 0;
  return { name: 'planted_bug_hit', pass, detail: pass ? `all ${planted.length} planted issue(s) hit` : `missed line(s): ${missed.map((m) => m.line).join(', ')}` };
};
