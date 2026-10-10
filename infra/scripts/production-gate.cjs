#!/usr/bin/env node
// Production-readiness gate (residency plan section 16).
//
//   node infra/scripts/production-gate.cjs validate   every PR: the manifest is well formed
//   node infra/scripts/production-gate.cjs enforce    before a production deploy / apply:
//                                                     EVERY item is satisfied with evidence
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

function validateStructure(doc) {
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

function enforce(doc, { root = process.cwd(), today = new Date().toISOString().slice(0, 10) } = {}) {
  const errors = [];
  const workflows = workflowText(root);
  for (const it of doc.items) {
    const where = `item ${it.id}`;
    if (it.kind === 'technical') {
      for (const c of it.checks || []) {
        if (!fs.existsSync(path.join(root, c))) errors.push(`${where}: check file is gone: ${c}`);
      }
      for (const s of it.ci_steps || []) {
        if (!workflows.includes(s)) errors.push(`${where}: no workflow runs "${s}" any more`);
      }
      continue;
    }
    if (it.status !== 'satisfied') {
      errors.push(`${where}: status is "${it.status}" (needs satisfied) — ${it.title}`);
      continue;
    }
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
  }
  return errors;
}

function load(manifestPath) {
  return parse(fs.readFileSync(manifestPath, 'utf8'));
}

function main(argv) {
  const mode = argv[0];
  const manifest = path.resolve(process.cwd(), argv[1] || 'compliance/production-gate.yaml');
  if (!['validate', 'enforce'].includes(mode)) {
    console.error('usage: production-gate.cjs validate|enforce [manifest]');
    return 2;
  }
  let doc;
  try {
    doc = load(manifest);
  } catch (e) {
    console.error(`::error::production-gate: ${e.message}`);
    return 1;
  }
  const errors = validateStructure(doc);
  if (mode === 'enforce' && errors.length === 0) errors.push(...enforce(doc));
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::production-gate: ${e}`);
    console.error(
      mode === 'enforce'
        ? 'production-gate: NOT satisfied — nothing is deployed to production until every item has evidence.'
        : 'production-gate: manifest is malformed.',
    );
    return 1;
  }
  const open = doc.items.filter((i) => i.kind !== 'technical' && i.status !== 'satisfied').length;
  console.log(`production-gate: ${mode} ok (${doc.items.length} items, ${open} open)`);
  return 0;
}

module.exports = { parse, validateStructure, enforce, load, REQUIRED_IDS };

if (require.main === module) process.exit(main(process.argv.slice(2)));
