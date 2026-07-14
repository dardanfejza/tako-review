import { headerFrom, snippetFrom, codeBytes, lineCount, fileNameFrom } from './reviewMeta';

describe('reviewMeta', () => {
  it('fileNameFrom builds a filename from the derived header + language extension', () => {
    expect(fileNameFrom('def average(nums):\n  pass', 'python')).toBe('average.py');
    expect(fileNameFrom('async def handler():', 'python')).toBe('handler.py');
  });

  it('fileNameFrom sanitizes fallback first-line headers into a filename', () => {
    expect(fileNameFrom('interface User {', 'typescript')).toBe('interface-User.ts');
    expect(fileNameFrom('x = 1', 'python')).toBe('x-1.py');
  });

  it('fileNameFrom falls back to untitled and a txt extension', () => {
    expect(fileNameFrom('', 'python')).toBe('untitled.py');
    expect(fileNameFrom('x = 1', 'cobol')).toBe('x-1.txt');
  });

  it('headerFrom extracts a def/class name and strips a leading line number', () => {
    expect(headerFrom('12  def add_values(foo, bar):\n  return foo')).toBe('add_values');
    expect(headerFrom('class Foo:\n  pass')).toBe('Foo');
    expect(headerFrom('async def handler():')).toBe('handler');
  });

  it('headerFrom falls back to the first non-blank line (line number stripped)', () => {
    expect(headerFrom('1 issubclass(x, y)')).toBe('issubclass(x, y)');
    expect(headerFrom('\n\n   x = 1')).toBe('x = 1');
    expect(headerFrom('')).toBe('untitled');
  });

  it('snippetFrom returns the first non-blank line, truncated', () => {
    expect(snippetFrom('12  def add_values(foo, bar):\n  return foo')).toBe('def add_values(foo, bar):');
    expect(snippetFrom('')).toBe('');
  });

  it('codeBytes and lineCount measure the code', () => {
    expect(codeBytes('abc')).toBe(3);
    expect(codeBytes('café')).toBe(5); // é is 2 bytes in UTF-8
    expect(lineCount('a\nb\nc')).toBe(3);
    expect(lineCount('')).toBe(0);
  });
});
