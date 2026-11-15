import { parseGpx, verifyRun, sampleGpx } from './verify.js';
for (const mode of ['run', 'drive', 'short']) {
  const r = verifyRun(parseGpx(sampleGpx(mode)));
  console.log('\n== ' + mode + ' => ' + (r.ok ? 'PASS score ' + r.score : 'REJECT'));
  r.checks.forEach(c => console.log((c.ok ? '  ok  ' : '  FAIL') + ' ' + c.name + ' - ' + c.detail));
}
