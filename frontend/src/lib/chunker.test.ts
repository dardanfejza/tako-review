import { needsChunking, splitIntoChunks } from './chunker';
import { withLineNumbers } from './lineNumber';

describe('needsChunking', () => {
  it('is false for short code under the token budget', () => {
    expect(needsChunking('print(1)', 3500)).toBe(false);
  });
  it('is true for code over the token budget', () => {
    expect(needsChunking('x'.repeat(20000), 3500)).toBe(true);
  });
});

describe('splitIntoChunks (offset-correct map/reduce — FE §4.6)', () => {
  it('returns one chunk covering all lines when under budget', () => {
    const chunks = splitIntoChunks('a\nb\nc', { budgetTokens: 3500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 3, text: 'a\nb\nc' });
  });

  it('splits oversized input into contiguous 1-based chunks that reconstruct the source', () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = splitIntoChunks(code, { budgetTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(200);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
    }
    expect(chunks.map((c) => c.text).join('\n')).toBe(code);
  });

  it('prefers breaking at function/blank boundaries while still reconstructing the source', () => {
    const code = 'def a():\n  pass\n\ndef b():\n  pass';
    const chunks = splitIntoChunks(code, { budgetTokens: 6 });
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunks.map((c) => c.text).join('\n')).toBe(code);
  });

  it('breaks at boundaries on LINE-NUMBERED text — the regex tolerates the "N  " prefix (review §5)', () => {
    // Production feeds the chunker `withLineNumbers()` output: every line starts with "<n>  ".
    // Before the fix the BOUNDARY regex (`^\s*(def |class |...)`) could never match the digit
    // prefix, so EVERY split was a raw budget cut mid-function. Build two fat functions so the
    // accumulator passes budget*0.6 exactly as the second `def` line arrives, then assert the
    // split lands on that numbered boundary line — not a mid-body cut.
    const body = Array.from({ length: 12 }, () => '    x = compute_a_long_expression(value)').join('\n');
    const raw = `def first():\n${body}\ndef second():\n${body}`;
    const numbered = withLineNumbers(raw);
    // Budget 200: after `first()`'s body the accumulator passes budget*0.6, so the split prefers
    // the numbered `14  def second():` boundary line (over a later mid-body budget cut).
    const chunks = splitIntoChunks(numbered, { budgetTokens: 200 });

    expect(chunks.length).toBeGreaterThan(1);
    // Reconstruction invariant always holds (contiguous, non-overlapping).
    expect(chunks.map((c) => c.text).join('\n')).toBe(numbered);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
    }
    // The boundary-preferring path actually fired: at least one non-first chunk begins on a
    // numbered `def `/`class ` line (would be impossible if the regex ignored the number prefix).
    const startsOnBoundary = chunks
      .slice(1)
      .some((c) => /^\d+\s+(def |class )/.test(c.text.split('\n')[0]!));
    expect(startsOnBoundary).toBe(true);
  });
});
