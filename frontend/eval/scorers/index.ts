import type { EvalCase } from '../cases/types';
import type { ReviewDraft } from '../../src/inference/reviewPipeline';
import type { CheckResult } from './types';
import { structureSections } from './structureSections';
import { severityVocab } from './severityVocab';
import { citationsValid } from './citationsValid';
import { plantedBugHit } from './plantedBugHit';
import { languageMatch } from './languageMatch';
import { latencyBudget, type LatencyBudget } from './latencyBudget';

export const REQUIRED = new Set(['structure_sections', 'severity_vocab', 'citations_valid', 'language_match']);

export interface ScoredCheck extends CheckResult {
  required: boolean;
}

export interface CaseResult {
  id: string;
  pass: boolean;
  checks: ScoredCheck[];
}

export interface RunOpts {
  budget: LatencyBudget;
  strictLatency: boolean;
}

export function runCase(c: EvalCase, d: ReviewDraft, opts: RunOpts): CaseResult {
  const raw: CheckResult[] = [
    structureSections(c, d),
    severityVocab(c, d),
    citationsValid(c, d),
    plantedBugHit(c, d),
    languageMatch(c, d),
    latencyBudget(opts.budget)(c, d),
  ];

  const checks: ScoredCheck[] = raw.map((r) => {
    let required = REQUIRED.has(r.name);
    if (r.name === 'planted_bug_hit') required = c.category === 'core' || c.category === 'regression';
    if (r.name === 'latency_budget') required = opts.strictLatency;
    return { ...r, required };
  });

  const pass = checks.every((ch) => !ch.required || ch.pass);
  return { id: c.id, pass, checks };
}

export function aggregateTrials(trialPasses: boolean[], opts: { strictRepeats: boolean }): boolean {
  if (opts.strictRepeats) return trialPasses.every(Boolean);
  const passed = trialPasses.filter(Boolean).length;
  return passed * 2 > trialPasses.length; // strict majority
}
