import { promptFor } from './prompts';
import type { ReviewMode, UiLanguage } from '../types/api';

const MODES: ReviewMode[] = ['explain', 'bugs', 'security', 'style'];
const LOCALES: UiLanguage[] = ['en', 'ja'];

describe('promptFor (mode × locale matrix — FE §4.8/§5.7)', () => {
  it('returns a non-empty, distinct prompt for every mode × locale', () => {
    const seen = new Set<string>();
    for (const m of MODES) {
      for (const l of LOCALES) {
        const p = promptFor(m, l);
        expect(p.length).toBeGreaterThan(0);
        seen.add(p);
      }
    }
    expect(seen.size).toBe(8);
  });

  it('every prompt instructs the Summary → Issues structure', () => {
    for (const m of MODES) {
      for (const l of LOCALES) {
        const p = promptFor(m, l);
        expect(/Summary|概要/.test(p) && /Issues|問題/.test(p)).toBe(true);
      }
    }
  });

  it('Japanese prompts are written in Japanese', () => {
    for (const m of MODES) {
      expect(/[぀-ヿ一-鿿]/.test(promptFor(m, 'ja'))).toBe(true);
    }
  });

  it('the bugs prompt mentions bugs and the security prompt mentions security', () => {
    expect(/bug/i.test(promptFor('bugs', 'en'))).toBe(true);
    expect(/security|vulnerab/i.test(promptFor('security', 'en'))).toBe(true);
  });
});
