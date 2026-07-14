import type { Scorer } from './types';

export interface LatencyBudget { maxTotalMs: number; minTokPerSec: number; }

export const latencyBudget = (b: LatencyBudget): Scorer => (_c, d) => {
  const t = d.timing;
  const pass = t.total_ms <= b.maxTotalMs && t.tok_per_sec >= b.minTokPerSec;
  return { name: 'latency_budget', pass, detail: `total_ms=${t.total_ms}(≤${b.maxTotalMs}) tok/s=${t.tok_per_sec}(≥${b.minTokPerSec})` };
};
