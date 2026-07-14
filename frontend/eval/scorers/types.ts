import type { ReviewDraft } from '../../src/inference/reviewPipeline';
import type { EvalCase } from '../cases/types';

export interface CheckResult { name: string; pass: boolean; detail: string; }
export type Scorer = (c: EvalCase, draft: ReviewDraft) => CheckResult;

/** Issues-section slice, used by structure/severity scorers. */
export function issuesSection(output: string, locale: EvalCase['locale']): string {
  const heading = locale === 'ja' ? '## 問題点' : '## Issues';
  const i = output.indexOf(heading);
  return i === -1 ? '' : output.slice(i);
}
