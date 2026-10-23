#!/usr/bin/env node
/**
 * Prints line / branch coverage for the modules whose defects cost the most, from the json-summary that
 * `npm run test:cov` (jest --coverage) writes to coverage/coverage-summary.json.
 *
 * REPORT-ONLY by default. The threshold below is the recommendation in the quality review (80% lines and
 * branches on money, identity, tenancy and scheduling code); it is enforced only with
 * `COVERAGE_ENFORCE=1`, because adopting a gate is an owner decision (D13), not something a script should
 * decide silently. Run `npm run test:cov` first.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SUMMARY = join(process.cwd(), 'coverage', 'coverage-summary.json');
const THRESHOLD = Number(process.env.COVERAGE_THRESHOLD ?? 80);
const ENFORCE = process.env.COVERAGE_ENFORCE === '1';

/** Directory prefixes (relative to src/) that make up each critical area. */
const AREAS = {
  auth: ['modules/auth/'],
  payments: ['modules/payments/'],
  'subscription-billing': ['modules/subscription-billing/'],
  appointment: ['modules/appointment/'],
  scheduling: ['modules/scheduling/'],
  rbac: ['rbac/', 'modules/rbac/'],
  'tenant-context': ['core/tenant-context/'],
  storage: ['modules/storage/'],
};

if (!existsSync(SUMMARY)) {
  console.error(`No ${relative(process.cwd(), SUMMARY)} - run "npm run test:cov" first.`);
  process.exit(2);
}

const summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
const srcRoot = join(process.cwd(), 'src').replace(/\\/g, '/') + '/';

const totals = {};
for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  const rel = file.replace(/\\/g, '/').replace(srcRoot, '');
  for (const [area, prefixes] of Object.entries(AREAS)) {
    if (!prefixes.some((p) => rel.startsWith(p))) continue;
    const t = (totals[area] ??= { lines: [0, 0], branches: [0, 0] });
    t.lines[0] += data.lines.covered;
    t.lines[1] += data.lines.total;
    t.branches[0] += data.branches.covered;
    t.branches[1] += data.branches.total;
  }
}

const pct = ([covered, total]) => (total === 0 ? 100 : (covered / total) * 100);
let below = 0;
console.log(`area                    lines    branches   (recommended >= ${THRESHOLD}%)`);
for (const [area, t] of Object.entries(totals)) {
  const lines = pct(t.lines);
  const branches = pct(t.branches);
  const flag = lines < THRESHOLD || branches < THRESHOLD ? '  <-- below' : '';
  if (flag) below++;
  console.log(`${area.padEnd(22)} ${lines.toFixed(1).padStart(6)}%  ${branches.toFixed(1).padStart(7)}%${flag}`);
}
const all = summary.total;
console.log(`\nwhole src/             ${all.lines.pct}% lines, ${all.branches.pct}% branches`);

if (ENFORCE && below > 0) {
  console.error(`\n${below} area(s) below ${THRESHOLD}% and COVERAGE_ENFORCE=1.`);
  process.exit(1);
}
