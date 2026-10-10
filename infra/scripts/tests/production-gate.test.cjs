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

// ── temporary, time-boxed deferral ───────────────────────────────────────────
const DEFERRED_IDS = [
  'legal-hosting-approval',
  'transfer-inventory-complete',
  'dpa-critical-processors',
  'scc-or-alternative',
  'scps-applied',
  'restore-drill-record',
  'incident-response-runbook',
];
const TODAY = '2026-10-10';
const opts = { root: REPO, today: TODAY, allowDeferrals: true };

function withDeferrals(doc, until = '2026-11-10') {
  const d = clone(doc);
  for (const id of DEFERRED_IDS) {
    Object.assign(item(d, id), { deferred_until: until, deferred_owner: 'Owner', deferred_reason: 'accepted risk while the document is obtained' });
  }
  return d;
}

test('committed manifest: exactly the seven open items are deferred, none satisfied, technical untouched', () => {
  const d = realDoc();
  for (const id of DEFERRED_IDS) {
    const it = item(d, id);
    assert.equal(it.status, 'open', id);
    assert.ok(it.deferred_until && it.deferred_owner && it.deferred_reason, id);
    assert.equal(it.evidence, '');
  }
  for (const it of d.items.filter((i) => i.kind === 'technical')) assert.equal(it.deferred_until, undefined, it.id);
  assert.deepEqual(gate.validateStructure(d, { today: TODAY }), []);
});

test('deferred open items do not block, stay open, and are reported as deferred', () => {
  const r = gate.evaluate(realDoc(), opts);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.deferred.map((i) => i.id).sort(), [...DEFERRED_IDS].sort());
  assert.ok(r.deferred.every((i) => i.status === 'open'));
  assert.equal(r.report.filter((x) => x.class === 'deferred').length, 7);
  assert.equal(r.report.length, 10, 'every item is classified, none omitted');
  assert.ok(r.report.filter((x) => x.kind === 'technical').every((x) => x.class === 'blocking'));
});

test('deferrals are NOT honoured unless the caller opts in (strict is the default)', () => {
  assert.equal(gate.enforce(realDoc(), { root: REPO, today: TODAY }).length, 7);
});

test('an open item without a deferral still blocks while others are deferred', () => {
  const d = clone(realDoc());
  for (const k of ['deferred_until', 'deferred_owner', 'deferred_reason']) delete item(d, 'scps-applied')[k];
  const e = gate.enforce(d, opts);
  assert.equal(e.length, 1);
  assert.match(e[0], /scps-applied: status is "open"/);
});

test('an expired deferral blocks again', () => {
  const e = gate.enforce(withDeferrals(realDoc(), '2026-10-09'), opts).join('\n');
  assert.match(e, /deferral expired on 2026-10-09/);
});

test('technical / security checks still block while items are deferred', () => {
  const gone = clone(realDoc());
  item(gone, 'ai-minimiser-tests').checks.push('src/modules/ai/minimization/deleted.spec.ts');
  assert.match(gate.enforce(gone, opts).join('\n'), /check file is gone/);
  const noStep = clone(realDoc());
  item(noStep, 'log-scrubbing-tests').ci_steps = ['a command no workflow runs'];
  assert.match(gate.enforce(noStep, opts).join('\n'), /no workflow runs/);
});

test('a technical item can never carry a deferral', () => {
  const d = clone(realDoc());
  Object.assign(item(d, 'ai-minimiser-tests'), { deferred_until: '2026-11-10', deferred_owner: 'x', deferred_reason: 'skip the tests for now please' });
  assert.match(gate.validateStructure(d, { today: TODAY }).join('\n'), /technical item can never be deferred/);
});

test('an invalid deferral fails safely: incomplete, open-ended, malformed, terse; leftovers on a satisfied item are inert', () => {
  const partial = clone(realDoc());
  delete item(partial, 'scps-applied').deferred_owner;
  assert.match(gate.validateStructure(partial, { today: TODAY }).join('\n'), /deferred_owner is required/);

  const forever = withDeferrals(realDoc(), '2099-01-01');
  assert.match(gate.validateStructure(forever, { today: TODAY }).join('\n'), /open-ended deferral is not allowed/);

  const badDate = withDeferrals(realDoc(), '2026-13-45');
  assert.match(gate.validateStructure(badDate, { today: TODAY }).join('\n'), /real YYYY-MM-DD/);

  const terse = withDeferrals(realDoc());
  item(terse, 'scps-applied').deferred_reason = 'later';
  assert.match(gate.validateStructure(terse, { today: TODAY }).join('\n'), /deferred_reason must explain/);

  const stale = withDeferrals(realDoc());
  Object.assign(item(stale, 'scps-applied'), { status: 'satisfied', evidence: 'infra/docs/SECURITY.md', approved_by: 'Owner', date: '2026-10-01' });
  // inert: judged on its evidence, never reported as deferred
  const r = gate.evaluate(stale, opts);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.deferred.some((i) => i.id === 'scps-applied'));
  const noEvidence = clone(stale);
  item(noEvidence, 'scps-applied').evidence = '';
  assert.match(gate.enforce(noEvidence, opts).join('\n'), /satisfied without evidence/);
});

test('CLI: opt-in passes with warnings; strict and an invalid flag value fail', () => {
  const run = (env) =>
    spawnSync(process.execPath, [SCRIPT, 'enforce', MANIFEST], { cwd: REPO, encoding: 'utf8', env: { ...process.env, PRODUCTION_GATE_ALLOW_DEFERRALS: '', ...env } });
  const ok = run({ PRODUCTION_GATE_ALLOW_DEFERRALS: 'true' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal((ok.stdout.match(/::warning::production-gate: DEFERRED/g) || []).length, 7);
  assert.match(ok.stdout, /follow-up is still required/);
  assert.equal(run({}).status, 1);
  assert.equal(run({ PRODUCTION_GATE_ALLOW_DEFERRALS: 'false' }).status, 1);
  const bad = run({ PRODUCTION_GATE_ALLOW_DEFERRALS: 'yes' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be "true" or "false"/);
});

test('the deploy workflow opts in and terraform.yml does not', () => {
  const dep = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-aws.yml'), 'utf8');
  const tf = fs.readFileSync(path.join(REPO, '.github/workflows/terraform.yml'), 'utf8');
  assert.match(dep, /PRODUCTION_GATE_ALLOW_DEFERRALS: "true"/);
  assert.doesNotMatch(tf, /PRODUCTION_GATE_ALLOW_DEFERRALS/);
});
