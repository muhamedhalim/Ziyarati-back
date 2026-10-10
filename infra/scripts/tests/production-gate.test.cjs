'use strict';
// Offline tests for infra/scripts/production-gate.cjs. No network, no AWS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gate = require('../production-gate.cjs');
const REPO = path.resolve(__dirname, '../../..');
const MANIFEST = path.join(REPO, 'compliance', 'production-gate.yaml');
const SCRIPT = path.resolve(__dirname, '../production-gate.cjs');

function realDoc() {
  return gate.parse(fs.readFileSync(MANIFEST, 'utf8'));
}
function clone(doc) {
  return JSON.parse(JSON.stringify(doc));
}
function item(doc, id) {
  return doc.items.find((i) => i.id === id);
}

test('the committed manifest is well formed and lists every required item', () => {
  assert.deepEqual(gate.validateStructure(realDoc()), []);
});

test('the committed manifest does NOT pass enforce: legal items are open', () => {
  const errors = gate.enforce(realDoc(), { root: REPO });
  assert.ok(errors.length > 0);
  // the technical items resolve on their own; only human items are open
  assert.ok(errors.every((e) => /status is "open"/.test(e)), errors.join('\n'));
});

test('a satisfied item without evidence, approver or date is refused', () => {
  const d = clone(realDoc());
  item(d, 'legal-hosting-approval').status = 'satisfied';
  const e = gate.enforce(d, { root: REPO }).join('\n');
  assert.match(e, /without evidence/);
  assert.match(e, /approved_by/);
  assert.match(e, /date is missing/);
});

test('placeholders and template brackets are not evidence', () => {
  for (const ev of ['TBD', 'n/a', 'pending', '<attach opinion>', 'external: <where>']) {
    const d = clone(realDoc());
    const it = item(d, 'legal-hosting-approval');
    Object.assign(it, { status: 'satisfied', evidence: ev, approved_by: 'Owner', date: '2026-10-01' });
    const e = gate.enforce(d, { root: REPO }).filter((m) => m.includes('legal-hosting-approval'));
    assert.ok(e.length > 0, `accepted ${ev}`);
  }
});

test('a repo-path evidence must exist; an external reference must say where', () => {
  const ok = clone(realDoc());
  Object.assign(item(ok, 'legal-hosting-approval'), {
    status: 'satisfied',
    evidence: 'external: counsel opinion held in the contract repository, ref LO-1',
    approved_by: 'Owner',
    date: '2026-10-01',
  });
  assert.equal(gate.enforce(ok, { root: REPO }).filter((m) => m.includes('legal-hosting-approval')).length, 0);

  const missing = clone(ok);
  item(missing, 'legal-hosting-approval').evidence = 'compliance/not-there.pdf';
  assert.match(gate.enforce(missing, { root: REPO }).join('\n'), /evidence path does not exist/);

  const vague = clone(ok);
  item(vague, 'legal-hosting-approval').evidence = 'external: yes';
  assert.match(gate.enforce(vague, { root: REPO }).join('\n'), /evidence must be a repo path/);
});

test('a future date is refused', () => {
  const d = clone(realDoc());
  Object.assign(item(d, 'restore-drill-record'), {
    status: 'satisfied',
    evidence: 'infra/docs/DISASTER-RECOVERY.md',
    approved_by: 'Ops lead',
    date: '2099-01-01',
  });
  assert.match(gate.enforce(d, { root: REPO }).join('\n'), /in the future/);
});

test('a technical item cannot be hand-satisfied, and breaks when its test or CI step disappears', () => {
  const d = clone(realDoc());
  item(d, 'ai-minimiser-tests').status = 'satisfied';
  assert.match(gate.validateStructure(d).join('\n'), /ci_verified/);

  const gone = clone(realDoc());
  item(gone, 'ai-minimiser-tests').checks.push('src/modules/ai/minimization/deleted.spec.ts');
  assert.match(gate.enforce(gone, { root: REPO }).join('\n'), /check file is gone/);

  const noStep = clone(realDoc());
  item(noStep, 'log-scrubbing-tests').ci_steps = ['a command no workflow runs'];
  assert.match(gate.enforce(noStep, { root: REPO }).join('\n'), /no workflow runs/);
});

test('a removed or duplicated required item is refused', () => {
  const d = clone(realDoc());
  d.items = d.items.filter((i) => i.id !== 'scps-applied');
  assert.match(gate.validateStructure(d).join('\n'), /required item missing: scps-applied/);
  const dup = clone(realDoc());
  dup.items.push(clone(item(dup, 'scps-applied')));
  assert.match(gate.validateStructure(dup).join('\n'), /duplicate id/);
});

test('syntax outside the supported subset is an error, never skipped', () => {
  assert.throws(() => gate.parse('version: 1\nitems:\n  - id: a\n    status: [open]\n'), /quote the value/);
  assert.throws(() => gate.parse('version: 1\nitems:\n  - id: a\n\tstatus: open\n'), /tabs/);
  assert.throws(() => gate.parse('version: 1\nbogus line\n'), /not valid in the manifest subset/);
});

test('CLI: validate exits 0 and enforce exits 1 on the committed manifest', () => {
  const run = (mode) => spawnSync(process.execPath, [SCRIPT, mode, MANIFEST], { cwd: REPO, encoding: 'utf8' });
  assert.equal(run('validate').status, 0);
  const enforced = run('enforce');
  assert.equal(enforced.status, 1);
  assert.match(enforced.stderr, /NOT satisfied/);
});

test('CLI: enforce passes on a fully evidenced manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgate-'));
  const d = clone(realDoc());
  for (const it of d.items) {
    if (it.kind === 'technical') continue;
    Object.assign(it, { status: 'satisfied', evidence: 'external: document kept in the contract repository', approved_by: 'Owner', date: '2026-10-01' });
  }
  const lines = ['version: 1', 'items:'];
  for (const it of d.items) {
    lines.push(`  - id: ${it.id}`);
    for (const [k, v] of Object.entries(it)) {
      if (k === 'id') continue;
      if (Array.isArray(v)) {
        lines.push(`    ${k}:`);
        for (const x of v) lines.push(`      - ${JSON.stringify(x)}`);
      } else lines.push(`    ${k}: ${JSON.stringify(v)}`);
    }
  }
  const file = path.join(dir, 'm.yaml');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const r = spawnSync(process.execPath, [SCRIPT, 'enforce', file], { cwd: REPO, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /enforce ok/);
});
