import type { EvalCase } from './types';

// Three-liner: minimum viable input
const TINY_JS = [
  'const id = (x) => x;',
  'const double = (x) => x * 2;',
  'const inc = (x) => x + 1;',
].join('\n');

// Long input: force the chunking path (CONTEXT_BUDGET_TOKENS = 3500 tokens).
// The size gate measures withLineNumbers(code), not the raw paste, so this module must be large
// enough that the line-numbered text estimates > 3500 tokens (~14k chars). The class/method loop
// below clears that with headroom; cases.test.ts asserts needsChunking() actually fires.
function makeLongPython(): string {
  const lines: string[] = [
    'import os',
    'import sys',
    'from typing import List, Optional',
    '',
    '# A deliberately long module to exercise the chunking path in the eval harness.',
    '# The chunker splits input > CONTEXT_BUDGET_TOKENS (3500 tokens) into contiguous,',
    '# non-overlapping line windows and reviews each window independently.',
    '',
  ];
  // Plausible Python: enough classes/methods to push the line-numbered text past the budget.
  for (let i = 0; i < 90; i++) {
    lines.push(`class Handler${i}:`);
    lines.push(`    """Handler for request type ${i}, dispatched by the router registry."""`);
    lines.push(``);
    lines.push(`    def __init__(self, config: dict, logger: Optional[object] = None) -> None:`);
    lines.push(`        self.config = config`);
    lines.push(`        self.logger = logger`);
    lines.push(`        self.processed = 0`);
    lines.push(``);
    lines.push(`    def handle(self, payload: List[dict]) -> int:`);
    lines.push(`        # Process each record and tally how many succeeded for request type ${i}.`);
    lines.push(`        for record in payload:`);
    lines.push(`            self.processed += 1`);
    lines.push(`        return self.processed`);
    lines.push(``);
  }
  return lines.join('\n');
}

export const edgeCases: EvalCase[] = [
  {
    id: 'edge-js-tiny-ja',
    mode: 'style',
    locale: 'ja',
    category: 'edge',
    code: TINY_JS,
    expect: { maxIssues: 2 },
  },
  {
    id: 'edge-py-long-en',
    mode: 'bugs',
    locale: 'en',
    category: 'edge',
    code: makeLongPython(),
    expect: {},
  },
];
