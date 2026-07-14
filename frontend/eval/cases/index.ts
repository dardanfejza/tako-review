import type { EvalCase } from './types';
import { coreCases } from './core';
import { edgeCases } from './edge';
import { negativeCases } from './negative';

export const allCases: EvalCase[] = [...coreCases, ...edgeCases, ...negativeCases];
