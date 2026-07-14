// Fails the build if any eval path/symbol leaked into the shipped bundle (eval spec §4).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const NEEDLES = ['__runEval', 'eval/harness', 'eval/run', 'eval/scorers'];
const offenders = [];
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html)$/.test(e)) {
      const txt = readFileSync(p, 'utf8');
      for (const n of NEEDLES) if (txt.includes(n)) offenders.push(`${p}: contains "${n}"`);
    }
  }
}
walk(DIST);
if (offenders.length) {
  console.error('BUILD ISOLATION VIOLATION — eval code leaked into dist/:\n' + offenders.join('\n'));
  process.exit(1);
}
console.log('dist/ clean: no eval code shipped.');
