import type { CaseResult } from './scorers/index';

export interface ReportMeta {
  modelVersion: string;
  promptVersion: string;
  libSha: string;
  hfRevision: string;
  repeats: number;
  caseSetHash: string;
}

export interface Report {
  meta: ReportMeta;
  total: number;
  passed: number;
  passRate: number;
  results: CaseResult[];
  failures: CaseResult[];
}

export function buildReport(results: CaseResult[], meta: ReportMeta): Report {
  const passed = results.filter((r) => r.pass).length;
  return {
    meta,
    total: results.length,
    passed,
    passRate: results.length ? passed / results.length : 1,
    results,
    failures: results.filter((r) => !r.pass),
  };
}

export function toMarkdown(r: Report): string {
  const pct = Math.round(r.passRate * 100);
  const lines = [
    `# Eval Report — ${r.meta.modelVersion} @ ${r.meta.promptVersion}`,
    ``,
    `**Pass rate: ${pct}%** (${r.passed}/${r.total}), repeats=${r.meta.repeats}`,
    `Bytes: lib \`${r.meta.libSha}\` · hf \`${r.meta.hfRevision}\` · cases \`${r.meta.caseSetHash}\``,
    ``,
    `| Case | Result | Failing checks |`,
    `|---|---|---|`,
    ...r.results.map(
      (c) =>
        `| ${c.id} | ${c.pass ? '✅' : '❌'} | ${
          c.checks
            .filter((x) => x.required && !x.pass)
            .map((x) => x.name)
            .join(', ') || '—'
        } |`
    ),
  ];
  return lines.join('\n');
}
