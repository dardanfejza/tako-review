/**
 * Line-numbered input + citation parsing (FE §4.5/§5.5). The numbered text is what gets stored
 * as `code_text`, so the model cites real line numbers and the UI can anchor citations back.
 */

/** Prefix each line with its 1-based number and two spaces (preserves original indentation). */
export function withLineNumbers(code: string): string {
  if (code === '') return '';
  return code
    .split('\n')
    .map((line, i) => `${i + 1}  ${line}`)
    .join('\n');
}

/**
 * Inverse of {@link withLineNumbers}: strip the leading "N  " each stored `code_text` line carries,
 * so a restored review shows RAW code in the editor (CodeMirror draws its own gutter — duplicating
 * them otherwise, and re-running would line-number the already-numbered text). Strips exactly one
 * prepended prefix; lines without one are left untouched.
 */
export function stripLineNumbers(numbered: string): string {
  if (numbered === '') return '';
  return numbered
    .split('\n')
    .map((line) => line.replace(/^\d+ {2}/, ''))
    .join('\n');
}

export type Citation =
  | { kind: 'single'; line: number }
  | { kind: 'range'; start: number; end: number };

/** An inclusive line range carried by a citation anchor (single line ⇒ `from === to`). */
export interface LineRange {
  from: number;
  to: number;
}

/**
 * The citation grammar, shared by {@link parseCitations} and the remark plugin so the two never
 * diverge. Returns a FRESH global regex each call (callers never trip over a shared `lastIndex`).
 * Matches case-insensitively: `L42` / `lines 12-15` / `line 3–4` (en dash) / `42行目` / `12-15行目`.
 * Capture groups: (1) L/line start, (2) L/line end, (3) 行目 start, (4) 行目 end.
 *
 * The L/line alternative is anchored on a word boundary (`\b`) so an embedded `l<n>` inside an
 * identifier in the model's prose (`level42`, `html5`, `call42()`, `HTML5`) is NOT mistaken for a
 * citation. The 行目 alternative gets a leading negative-lookbehind `(?<![\w\d])` for the same
 * reason — without it `page42行目` would grab `42` out of the identifier (the CJK suffix alone is
 * not enough of a leading boundary). CJK lead chars are not `\w`, so a real `…は42行目` still matches.
 */
export function citationPattern(): RegExp {
  return /\b(?:L|lines?\s+)(\d+)(?:\s*[-–]\s*(\d+))?|(?<![\w\d])(\d+)\s*(?:[-–]\s*(\d+)\s*)?行目/gi;
}

/**
 * Extract line citations the model emits, in order of appearance:
 *   - single: `L42` / `42行目`
 *   - range:  `lines 12-15` / `lines 3–4` (ASCII hyphen or en-dash) / `12-15行目`
 */
export function parseCitations(text: string): Citation[] {
  const re = citationPattern();
  const out: Citation[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = Number(m[1] ?? m[3]);
    const endRaw = m[2] ?? m[4];
    if (endRaw === undefined) {
      // Drop nonsensical single lines (`L0`, `0行目`): line numbers are 1-based.
      if (start >= 1) out.push({ kind: 'single', line: start });
    } else {
      // Normalize a reversed range (`lines 15-12`) so start <= end downstream.
      const end = Number(endRaw);
      out.push({ kind: 'range', start: Math.min(start, end), end: Math.max(start, end) });
    }
  }
  return out;
}
