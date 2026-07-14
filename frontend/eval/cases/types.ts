import type { ReviewMode, UiLanguage } from '../../src/types/api';

export interface EvalCase {
  id: string;
  mode: ReviewMode;
  locale: UiLanguage;
  category: 'core' | 'regression' | 'edge' | 'negative';
  code: string;
  expect: {
    plantedLines?: { line: number; mustMentionAny?: string[] }[];
    /** Not enforced by any scorer — informational only. */
    minIssues?: number;
    /** Only enforced when === 0: bypasses severity_vocab check in severityVocab scorer. */
    maxIssues?: number;
  };
}
