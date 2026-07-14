import { withLineNumbers, stripLineNumbers, parseCitations } from './lineNumber';

describe('withLineNumbers', () => {
  it('prefixes each line with its 1-based number + two spaces, preserving indentation', () => {
    expect(withLineNumbers('def f():\n  return 1')).toBe('1  def f():\n2    return 1');
  });

  it('returns empty string for empty input', () => {
    expect(withLineNumbers('')).toBe('');
  });

  it('numbers a single line', () => {
    expect(withLineNumbers('print(1)')).toBe('1  print(1)');
  });
});

describe('parseCitations', () => {
  it('parses single Lnn citations and ranges with hyphen or en-dash, in order', () => {
    expect(parseCitations('see L42 and lines 12-15 and lines 3–4')).toEqual([
      { kind: 'single', line: 42 },
      { kind: 'range', start: 12, end: 15 },
      { kind: 'range', start: 3, end: 4 },
    ]);
  });

  it('returns an empty array when there are no citations', () => {
    expect(parseCitations('no citations here')).toEqual([]);
  });

  it('parses Japanese 行目 single and range citations', () => {
    expect(parseCitations('42行目を参照')).toEqual([{ kind: 'single', line: 42 }]);
    expect(parseCitations('12-15行目に問題')).toEqual([{ kind: 'range', start: 12, end: 15 }]);
  });

  it('parses a mix of English and Japanese citations in order', () => {
    expect(parseCitations('L7 と 12-15行目 を確認')).toEqual([
      { kind: 'single', line: 7 },
      { kind: 'range', start: 12, end: 15 },
    ]);
  });

  it('does not match an L/line pattern embedded inside an identifier', () => {
    // `level42`, `html5`, `call42()`, `model5` must NOT become citations — the L/line marker
    // only counts at a word boundary, so identifiers in the model's prose are left intact.
    expect(parseCitations('level42 html5 call42() model5')).toEqual([]);
  });

  it('matches standalone lowercase l42 and capitalized Line/Lines (case-insensitive)', () => {
    expect(parseCitations('see l42 and Line 7 and Lines 3-4')).toEqual([
      { kind: 'single', line: 42 },
      { kind: 'single', line: 7 },
      { kind: 'range', start: 3, end: 4 },
    ]);
  });

  it('does not grab digits glued to a preceding word in the 行目 branch', () => {
    // `page42行目` must not yield line 42 — the 行目 marker needs a leading boundary just like
    // the L/line marker, so digits welded onto an identifier are left intact.
    expect(parseCitations('see .../page42行目')).toEqual([]);
    expect(parseCitations('item7行目')).toEqual([]);
  });

  it('still matches a 行目 citation at a real boundary (whitespace / start / CJK)', () => {
    expect(parseCitations('問題は 42行目 です')).toEqual([{ kind: 'single', line: 42 }]);
    expect(parseCitations('問題は12-15行目です')).toEqual([{ kind: 'range', start: 12, end: 15 }]);
  });

  it('drops a single citation with line < 1', () => {
    expect(parseCitations('L0 is not a real line')).toEqual([]);
    expect(parseCitations('0行目 も無効')).toEqual([]);
  });

  it('swaps a reversed range so start <= end', () => {
    expect(parseCitations('lines 15-12 are reversed')).toEqual([
      { kind: 'range', start: 12, end: 15 },
    ]);
    expect(parseCitations('15-12行目')).toEqual([{ kind: 'range', start: 12, end: 15 }]);
  });
});

describe('stripLineNumbers', () => {
  it('is the inverse of withLineNumbers and preserves indentation', () => {
    const code = 'def f():\n    return 1\n\nx = 2';
    expect(stripLineNumbers(withLineNumbers(code))).toBe(code);
  });

  it('strips exactly one prepended prefix; leaves raw lines untouched', () => {
    expect(stripLineNumbers('1  def f():\n2      pass')).toBe('def f():\n    pass');
    expect(stripLineNumbers('already raw')).toBe('already raw');
    expect(stripLineNumbers('')).toBe('');
  });
});
