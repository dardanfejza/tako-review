import type { Scorer } from './types';

// Hiragana, katakana, CJK ideographs.
const CJK = /[぀-ヿ㐀-鿿]/;

export const languageMatch: Scorer = (c, d) => {
  const hasCjk = CJK.test(d.review_output);
  const pass = c.locale === 'ja' ? hasCjk : !hasCjk;
  return { name: 'language_match', pass, detail: pass ? `matches ${c.locale}` : `expected ${c.locale} (cjk=${hasCjk})` };
};
