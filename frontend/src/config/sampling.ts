/**
 * Sampling defaults for code review (build-plan §2.5, resolving FE §18.5). Centralized so they
 * are one-line tunable. temp 0.2 for determinism (vs the chat demo's 0.7). The logit_bias is an
 * inherited model-specific stabilizer from the original model's reference chat UI (index.js:130). Exact tuning
 * is a manual, empirical step.
 */
export interface SamplingOptions {
  temperature: number;
  top_p: number;
  repetition_penalty: number;
  frequency_penalty: number;
  logit_bias?: Record<string, number>;
}

export const DEFAULT_GEN_OPTIONS: SamplingOptions = {
  temperature: 0.2,
  top_p: 0.9,
  repetition_penalty: 1.1,
  frequency_penalty: 0.5,
  logit_bias: { '14444': -100 },
};
