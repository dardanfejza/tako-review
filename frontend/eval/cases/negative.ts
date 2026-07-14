import type { EvalCase } from './types';

export const negativeCases: EvalCase[] = [
  {
    id: 'style-py-clean-ja',
    mode: 'style',
    locale: 'ja',
    category: 'negative',
    code: [
      'def greet(name: str) -> str:',
      '    """Return a greeting message."""',
      '    return f"Hello, {name}!"',
      '',
      'def add(a: int, b: int) -> int:',
      '    """Return the sum of two integers."""',
      '    return a + b',
    ].join('\n'),
    expect: { maxIssues: 1 },
  },
  {
    id: 'bugs-ts-clean-en',
    mode: 'bugs',
    locale: 'en',
    category: 'negative',
    code: [
      'export function clamp(value: number, min: number, max: number): number {',
      '  if (value < min) return min;',
      '  if (value > max) return max;',
      '  return value;',
      '}',
    ].join('\n'),
    expect: { maxIssues: 1 },
  },
];
