#!/usr/bin/env node
// Production-readiness gate (residency plan section 16).
//
//   node infra/scripts/production-gate.cjs validate   every PR: the manifest is well formed
//   node infra/scripts/production-gate.cjs enforce    before a production deploy / apply:
//                                                     EVERY item is satisfied with evidence
//
// (A time-boxed, opt-in deferral exists for open legal/document items - see "Temporary, explicit
// deferral" below. Default behaviour is unchanged: strict.)
//
// `validate` passes while items are open (that is the honest state until the
// legal and vendor items exist). `enforce` fails in that state: nothing is
// deployed to production while an item is open.
//
// What this does and does not prove
//   * A `legal` / `document` item is satisfied only by a human entry (evidence,
//     approver, date). The script cannot read a counsel opinion or a signed DPA;
//     it refuses an EMPTY or placeholder entry and a repo path that does not
//     exist. The reviewed pull request and the GitHub Environment's required
//     reviewers remain the control over whether the entry is true.
//   * A `technical` item is NEVER satisfied by a hand-written status. It names
//     the test files that prove it and the workflow commands that run them; the
//     script fails when a named file is gone or a named command is no longer in
//     a workflow, so deleting a test or a CI step breaks the gate. That the
//     tests PASSED is established by the CI jobs the production jobs depend on
//     (`needs:`), not by this script.
//
// Temporary, explicit deferral (risk acceptance)
//   An OPEN `legal` / `document` item may carry a time-boxed deferral in the manifest:
//       deferred_until:  "YYYY-MM-DD"   review / expiry date, at most MAX_DEFERRAL_DAYS ahead
//       deferred_owner:  "<person>"     who must close it ("UNASSIGNED" is allowed, and warned about)
//       deferred_reason: "<why>"        at least 20 characters
//   The deferral is HONOURED only when the caller opts in with
//   PRODUCTION_GATE_ALLOW_DEFERRALS=true (deploy-aws.yml sets it; terraform.yml does not, so a
//   production `terraform apply` stays strict). A deferred item keeps status `open`, is never
//   treated as satisfied, and is printed as a ::warning:: on every run. Past `deferred_until` it
//   blocks again. Technical items can never be deferred: they are the checks that keep
//   tests, scans and CI steps from being deleted. Removing the env var, or the three fields,
//   restores strict enforcement.
//
// The manifest uses a deliberately small YAML subset so this file needs no
// dependency (it runs in jobs that never ran `npm ci`). Anything outside the
// subset is an error, never silently skipped.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_IDS = [
  'legal-hosting-approval',
  'transfer-inventory-complete',
  'dpa-critical-processors',
  'scc-or-alternative',
  'ai-minimiser-tests',
  'log-scrubbing-tests',
  'data-boundary-terraform-tests',
  'scps-applied',
  'restore-drill-record',
  'incident-response-runbook',
];
const KINDS = ['legal', 'document', 'technical'];
const HUMAN_STATUSES = ['open', 'satisfied'];
const DEFERRAL_KEYS = ['deferred_until', 'deferred_owner', 'deferred_reason'];
const MAX_DEFERRAL_DAYS = 90;
const PLACEHOLDER = /^(tbd|todo|n\/?a|none|pending|unknown|-+|\?+)$/i;

// ── restricted YAML subset ───────────────────────────────────────────────────
function scalar(raw, lineNo) {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('"')) {
    if (!/^"([^"\\]|\\.)*"$/.test(v)) throw new Error(`line ${lineNo}: unterminated or malformed string`);
    return JSON.parse(v);
  }
  if (v.startsWith("'")) {
    if (!/^'[^']*'$/.test(v)) throw new Error(`line ${lineNo}: unterminated or malformed string`);
    return v.slice(1, -1);
  }
  if (/[#{}\[\]&*!|>%@`]/.test(v)) {
    throw new Error(`line ${lineNo}: quote the value (unsupported YAML syntax): ${v}`);
  }
  return v;
}

function parse(text) {
  const doc = { items: [] };
  let item = null;
  let listKey = null;
  let inItems = false;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    if (/\t/.test(line)) throw new Error(`line ${n}: tabs are not allowed`);
    let m;
    if ((m = /^version:\s*(.+)$/.exec(line))) {
      doc.version = scalar(m[1], n);
      inItems = false;
    } else if (/^items:\s*$/.test(line)) {
      inItems = true;
    } else if (inItems && (m = /^ {2}- ([a-z_]+):(.*)$/.exec(line))) {
      item = {};
      doc.items.push(item);
      item[m[1]] = scalar(m[2], n);
      listKey = null;
    } else if (inItems && item && (m = /^ {4}([a-z_]+):(.*)$/.exec(line))) {
      if (m[2].trim() === '') {
        item[m[1]] = [];
        listKey = m[1];
      } else {
        item[m[1]] = scalar(m[2], n);
        listKey = null;
      }
    } else if (inItems && item && listKey && (m = /^ {6}- (.+)$/.exec(line))) {
      item[listKey].push(scalar(m[1], n));
    } else {
      throw new Error(`line ${n}: not valid in the manifest subset: ${line.trim()}`);
    }
  });
  return doc;
}

// ── structure ────────────────────────────────────────────────────────────────
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hasDeferral(it) {
  return DEFERRAL_KEYS.some((k) => it[k] !== undefined && String(it[k]).trim() !== '');
}

// Shape of a deferral only (expiry is judged at enforce time, so an expired deferral does not
// turn every pull request red - it blocks the deploy, which is where it matters).
function deferralShapeErrors(it, today) {
  const where = `item ${it.id}`;
  const errors = [];
  if (it.kind === 'technical') errors.push(`${where}: a technical item can never be deferred`);
  for (const k of DEFERRAL_KEYS) {
    if (typeof it[k] !== 'string' || it[k].trim() === '') errors.push(`${where}: ${k} is required when a deferral is declared`);
  }
  if (typeof it.deferred_until === 'string' && it.deferred_until.trim() !== '') {
    if (!isRealDate(it.deferred_until)) errors.push(`${where}: deferred_until must be a real YYYY-MM-DD`);
    else if (it.deferred_until > addDays(today, MAX_DEFERRAL_DAYS)) {
      errors.push(`${where}: deferred_until ${it.deferred_until} is more than ${MAX_DEFERRAL_DAYS} days away (an open-ended deferral is not allowed)`);
    }
  }
  if (typeof it.deferred_reason === 'string' && it.deferred_reason.trim().length < 20) {
    errors.push(`${where}: deferred_reason must explain the deferral (20+ characters)`);
  }
  return errors;
}

function validateStructure(doc, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const errors = [];
  if (doc.version !== '1') errors.push(`version must be 1 (got ${JSON.stringify(doc.version)})`);
  const seen = new Set();
  for (const it of doc.items) {
    const where = `item ${it.id || '(no id)'}`;
    if (!it.id) {
      errors.push('an item has no id');
      continue;
    }
    if (seen.has(it.id)) errors.push(`${where}: duplicate id`);
    seen.add(it.id);
    if (!it.title) errors.push(`${where}: title is required`);
    if (!KINDS.includes(it.kind)) errors.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
    if (it.kind === 'technical') {
      if (it.status !== 'ci_verified') errors.push(`${where}: a technical item has status ci_verified (it is proven by tests, not by a hand-written status)`);
      if (!Array.isArray(it.checks) || it.checks.length === 0) errors.push(`${where}: technical item needs "checks" (test files)`);
      if (!Array.isArray(it.ci_steps) || it.ci_steps.length === 0) errors.push(`${where}: technical item needs "ci_steps" (workflow commands that run them)`);
    } else if (!HUMAN_STATUSES.includes(it.status)) {
      errors.push(`${where}: status must be one of ${HUMAN_STATUSES.join(', ')}`);
    }
    if (it.date && !isRealDate(it.date)) errors.push(`${where}: date must be a real YYYY-MM-DD`);
    if (hasDeferral(it)) errors.push(...deferralShapeErrors(it, today));
  }
  for (const id of REQUIRED_IDS) {
    if (!seen.has(id)) errors.push(`required item missing: ${id}`);
  }
  return errors;
}

// ── enforcement ──────────────────────────────────────────────────────────────
function repoPathLike(s) {
  return /^(compliance|infra|docs|src|\.github)\//.test(s);
}

function workflowText(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

// Returns { errors, deferred, report }. `errors` blocks the deploy; `deferred` are open items whose
// deferral was honoured (reported as warnings, still open); `report` classifies EVERY item.
function evaluate(doc, { root = process.cwd(), today = new Date().toISOString().slice(0, 10), allowDeferrals = false } = {}) {
  const errors = [];
  const deferred = [];
  const report = [];
  const workflows = workflowText(root);
  for (const it of doc.items) {
    const where = `item ${it.id}`;
    if (it.kind === 'technical') {
      const before = errors.length;
      for (const c of it.checks || []) {
        if (!fs.existsSync(path.join(root, c))) errors.push(`${where}: check file is gone: ${c}`);
      }
      for (const s of it.ci_steps || []) {
        if (!workflows.includes(s)) errors.push(`${where}: no workflow runs "${s}" any more`);
      }
      report.push({ id: it.id, kind: it.kind, class: 'blocking', state: errors.length === before ? 'ci_verified (passing)' : 'FAILING' });
      continue;
    }
    if (it.status !== 'satisfied') {
      if (allowDeferrals && hasDeferral(it)) {
        if (it.deferred_until < today) {
          errors.push(`${where}: deferral expired on ${it.deferred_until} - item is still "${it.status}" (needs satisfied) - ${it.title}`);
          report.push({ id: it.id, kind: it.kind, class: 'blocking', state: `${it.status} (deferral expired ${it.deferred_until})` });
        } else {
          deferred.push(it);
          report.push({ id: it.id, kind: it.kind, class: 'deferred', state: `${it.status} until ${it.deferred_until}` });
        }
        continue;
      }
      errors.push(`${where}: status is "${it.status}" (needs satisfied) - ${it.title}`);
      report.push({ id: it.id, kind: it.kind, class: 'blocking', state: it.status });
      continue;
    }
    const before = errors.length;
    const ev = (it.evidence || '').trim();
    if (!ev) errors.push(`${where}: satisfied without evidence`);
    else if (PLACEHOLDER.test(ev) || /[<>]/.test(ev)) errors.push(`${where}: evidence is a placeholder: ${ev}`);
    else if (repoPathLike(ev)) {
      if (!fs.existsSync(path.join(root, ev))) errors.push(`${where}: evidence path does not exist: ${ev}`);
    } else if (!/^external:\s*\S.{9,}$/.test(ev)) {
      errors.push(`${where}: evidence must be a repo path, or "external: <where the document is kept>" (10+ characters)`);
    }
    const by = (it.approved_by || '').trim();
    if (!by || PLACEHOLDER.test(by) || /[<>]/.test(by)) errors.push(`${where}: approved_by is missing or a placeholder`);
    if (!isRealDate(it.date || '')) errors.push(`${where}: date is missing or not YYYY-MM-DD`);
    else if (it.date > today) errors.push(`${where}: date is in the future (${it.date})`);
    report.push({ id: it.id, kind: it.kind, class: 'blocking', state: errors.length === before ? 'satisfied (evidenced)' : 'FAILING evidence' });
  }
  return { errors, deferred, report };
}

// Back-compat: the list of blocking errors.
function enforce(doc, opts) {
  return evaluate(doc, opts).errors;
}

function load(manifestPath) {
  return parse(fs.readFileSync(manifestPath, 'utf8'));
}

function main(argv, env = process.env) {
  const mode = argv[0];
  const manifest = path.resolve(process.cwd(), argv[1] || 'compliance/production-gate.yaml');
  if (!['validate', 'enforce'].includes(mode)) {
    console.error('usage: production-gate.cjs validate|enforce [manifest]');
    return 2;
  }
  const flag = (env.PRODUCTION_GATE_ALLOW_DEFERRALS || '').trim();
  if (!['', 'true', 'false'].includes(flag)) {
    console.error(`::error::production-gate: PRODUCTION_GATE_ALLOW_DEFERRALS must be "true" or "false" (got ${JSON.stringify(flag)}) - refusing to guess`);
    return 1;
  }
  const allowDeferrals = flag === 'true';
  let doc;
  try {
    doc = load(manifest);
  } catch (e) {
    console.error(`::error::production-gate: ${e.message}`);
    return 1;
  }
  const errors = validateStructure(doc);
  let result = { errors: [], deferred: [], report: [] };
  if (mode === 'enforce' && errors.length === 0) {
    result = evaluate(doc, { allowDeferrals });
    errors.push(...result.errors);
  }
  for (const r of result.report) {
    console.log(`production-gate: [${r.class.toUpperCase()}] ${r.id} (${r.kind}): ${r.state}`);
  }
  for (const it of result.deferred) {
    const owner = it.deferred_owner.trim().toUpperCase() === 'UNASSIGNED' ? 'UNASSIGNED (assign an owner)' : it.deferred_owner;
    console.log(
      `::warning::production-gate: DEFERRED ${it.id} - status "${it.status}", NOT satisfied; owner ${owner}; ` +
        `review by ${it.deferred_until}; reason: ${it.deferred_reason} - follow-up is still required`,
    );
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::production-gate: ${e}`);
    console.error(
      mode === 'enforce'
        ? 'production-gate: NOT satisfied - nothing is deployed to production until every blocking item has evidence.'
        : 'production-gate: manifest is malformed.',
    );
    return 1;
  }
  const open = doc.items.filter((i) => i.kind !== 'technical' && i.status !== 'satisfied').length;
  console.log(
    `production-gate: ${mode} ok (${doc.items.length} items, ${open} open, ${result.deferred.length} deferred` +
      `${allowDeferrals ? '' : ', deferrals not honoured in this run'})`,
  );
  return 0;
}

module.exports = { parse, validateStructure, enforce, evaluate, main, load, REQUIRED_IDS, MAX_DEFERRAL_DAYS };

if (require.main === module) process.exit(main(process.argv.slice(2)));
