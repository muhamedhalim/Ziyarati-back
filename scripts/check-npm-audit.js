/* eslint-disable */
/**
 * T148 — npm audit adjudication gate.
 *
 * `npm audit --audit-level=high` alone cannot distinguish a genuinely new,
 * unreviewed advisory from one already investigated and confirmed
 * unreachable in this application (008's Final Verification Pass rejected
 * 6 of 9 dependency advisories on reachability grounds — see
 * SECURITY-REVIEW.md ZT-004c at the repo root). Run unmodified, the CI gate
 * would fail on every PR forever, which trains reviewers to ignore or bypass
 * it rather than read it.
 *
 * This script runs the audit itself, then classifies each HIGH/CRITICAL
 * advisory (moderate/low are out of scope for an "audit-level=high" gate
 * and are not evaluated at all — unchanged from the plain flag's own
 * behaviour) into:
 *   - ACCEPTED   — reachability-adjudicated, evidence recorded in
 *                  specs/010-security-headers-and-regression-suite/evidence/
 *                  t148-npm-audit-adjudication.md. Logged, does not fail.
 *   - anything else — a genuinely new advisory. FAILS the gate: this is the
 *                  entire point of running npm audit in CI.
 *
 * Adding a package version bump to clear an advisory is a separate,
 * deliberate change — this script only decides what CI should do about
 * advisories that already exist in the current, unmodified lockfile.
 */
const { execSync } = require('node:child_process');

// GHSA id -> one-line reason. Full reasoning (files checked, why the
// vulnerable code path is not reachable) lives in the evidence file above;
// this is a pointer, not a restatement.
const ACCEPTED = new Map([
  [
    'GHSA-52cp-r559-cp3m',
    'js-yaml (via @nestjs/swagger, OpenAPI doc serialization only) — 008 ZT-004c, reconfirmed',
  ],
  [
    'GHSA-5p4m-2wfm-xmqj',
    'js-yaml (via @nestjs/swagger, OpenAPI doc serialization only) — 008 ZT-004c, reconfirmed',
  ],
]);

function main() {
  let raw;
  try {
    raw = execSync('npm audit --omit=dev --json', {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    // npm audit exits non-zero whenever it finds ANY vulnerability, including
    // ones this script will classify as accepted. stdout still has the report.
    raw = err.stdout;
  }
  if (!raw) {
    console.error('npm audit produced no parseable output.');
    process.exit(1);
  }

  const report = JSON.parse(raw);
  const vulnerabilities = report.vulnerabilities || {};

  const seen = new Set();
  const accepted = [];
  const unexpected = [];

  for (const [pkg, info] of Object.entries(vulnerabilities)) {
    for (const via of info.via) {
      if (typeof via !== 'object' || !via.url) continue; // string = dependency-chain pointer, not an advisory
      if (via.severity !== 'high' && via.severity !== 'critical') continue;
      const id = via.url.split('/').pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const label = `${id} (${via.severity}) — ${pkg}: ${via.title}`;
      if (ACCEPTED.has(id)) {
        accepted.push(`${label}\n      -> ${ACCEPTED.get(id)}`);
      } else {
        unexpected.push(label);
      }
    }
  }

  if (accepted.length) {
    console.log(
      '\n[accepted — reachability-adjudicated, see evidence/t148-npm-audit-adjudication.md]',
    );
    accepted.forEach((l) => console.log('  ' + l));
  }

  if (unexpected.length) {
    console.error('\n[UNEXPECTED — new or unadjudicated high/critical advisory]');
    unexpected.forEach((l) => console.error('  x ' + l));
    console.error(
      '\nAdjudicate in specs/010-security-headers-and-regression-suite/evidence/' +
        't148-npm-audit-adjudication.md, then add the GHSA id to ACCEPTED in this ' +
        'script only if genuinely unreachable — otherwise fix it.',
    );
    process.exit(1);
  }

  console.log('\nnpm audit: no unadjudicated high/critical advisories. Gate passes.');
}

main();
