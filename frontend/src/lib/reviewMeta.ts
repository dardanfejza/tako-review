/**
 * Code-derived history metadata. Mirrors the backend `review_service` helpers
 * (header_from / snippet_from) so the optimistic prepend matches the server's list projection.
 */

const LINENO = /^\s*\d{1,4}[ \t]+/;
const DEF = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;

function cleanLine(line: string): string {
  return line.replace(LINENO, '').trim();
}

/** List header: first def/class name, else the first non-blank line (leading line number stripped). */
export function headerFrom(code: string): string {
  let first = '';
  for (const raw of code.split('\n')) {
    const line = cleanLine(raw);
    if (!line) continue;
    if (!first) first = line;
    const m = DEF.exec(line);
    if (m) return m[1]!.slice(0, 48);
  }
  return (first || 'untitled').slice(0, 48);
}

/** List body: the first non-blank code line (leading line number stripped), truncated. */
export function snippetFrom(code: string): string {
  for (const raw of code.split('\n')) {
    const line = cleanLine(raw);
    if (line) return line.slice(0, 80);
  }
  return '';
}

/** UTF-8 byte length of the code (matches the server's len(code.encode())). */
export function codeBytes(code: string): number {
  return new TextEncoder().encode(code).length;
}

export function lineCount(code: string): number {
  return code.length === 0 ? 0 : code.split('\n').length;
}

const EXT: Record<string, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
};

/** Editor file-tab name: the derived header sanitized into a filename + language extension
 *  (e.g. "average.py", "interface-User.ts"). Unknown languages fall back to .txt. */
export function fileNameFrom(code: string, language: string): string {
  const stem =
    headerFrom(code)
      .replace(/[^A-Za-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/\.+$/g, '')
      .slice(0, 24) || 'untitled';
  return `${stem}.${EXT[language.toLowerCase()] ?? 'txt'}`;
}
