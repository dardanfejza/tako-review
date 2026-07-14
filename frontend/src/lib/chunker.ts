/**
 * Large-file map/reduce splitter (FE §4.6). Detects input size against the ~4k context budget
 * and splits oversized input into contiguous, non-overlapping, 1-based line windows so per-chunk
 * citations offset-correct back to real lines (chunk-local line k → original `startLine + k - 1`).
 * Breaks prefer function/blank boundaries when the current chunk is already substantial.
 */
export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

export interface ChunkOptions {
  budgetTokens: number;
}

/** Cheap token estimate (~4 chars/token) — good enough for the size gate (FE §4.5). */
const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Lines that begin a logical section — preferred split points. The input is the LINE-NUMBERED
 * text (`withLineNumbers()`), so every line is prefixed with `"<n>  "` (digits + padding). The
 * optional leading `\d+\s+` lets the boundary match THROUGH that prefix — without it the regex
 * could never fire on production input and every split was a raw budget cut mid-function (review
 * §5 "boundary splitting is dead code on numbered text").
 */
const BOUNDARY = /^\s*(?:\d+\s+)?(def |class |function |export |async |#|\/\/|\/\*)/;

export function needsChunking(code: string, budgetTokens: number): boolean {
  return estimateTokens(code) > budgetTokens;
}

export function splitIntoChunks(code: string, opts: ChunkOptions): Chunk[] {
  const { budgetTokens } = opts;
  const lines = code.split('\n');
  if (!needsChunking(code, budgetTokens)) {
    return [{ text: code, startLine: 1, endLine: lines.length }];
  }

  const chunks: Chunk[] = [];
  let start = 0; // 0-based index of the current chunk's first line
  let tokens = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineTokens = estimateTokens(line) + 1; // +1 approximates the newline
    const wouldExceed = tokens + lineTokens > budgetTokens && i > start;
    const atBoundary = i > start && BOUNDARY.test(line) && tokens >= budgetTokens * 0.6;
    if (wouldExceed || atBoundary) {
      chunks.push({ text: lines.slice(start, i).join('\n'), startLine: start + 1, endLine: i });
      start = i;
      tokens = 0;
    }
    tokens += lineTokens;
  }
  chunks.push({ text: lines.slice(start).join('\n'), startLine: start + 1, endLine: lines.length });
  return chunks;
}
