#!/usr/bin/env node
/**
 * Static lint for the k6 suite — catches the failure classes that only show up at k6
 * RUN time (and k6 may not be runnable where you edit):
 *
 *   1. every named import resolves to a real export in the target module
 *   2. every `exec: '<fn>'` / kit builder first argument names an exported function
 *      of the scenario file (k6 resolves exec by exported name)
 *   3. every endpoint label passed to observe(res, '<label>', ...) is registered for the
 *      mergeable histograms (thresholds.js ENDPOINTS + config/campaign-endpoints.js), so
 *      no endpoint silently loses its per-endpoint histogram
 *   4. no scenario file hardcodes a http(s):// target (the guard only works if BASE_URL
 *      is the single source of the host)
 *
 * Usage:  node tests/load/lab/lint-scenarios.mjs        (exit 1 on any finding)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['helpers', 'flows', 'config', 'scenarios'];
const files = [];
for (const d of DIRS) for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.js')) files.push(path.join(ROOT, d, f));

const src = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const problems = [];
const bad = (f, msg) => problems.push(`${path.relative(ROOT, f)}: ${msg}`);

// ---- exports per module
function exportsOf(text) {
  const out = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      const as = /\bas\s+([A-Za-z0-9_$]+)$/.exec(t);
      out.add(as ? as[1] : t);
    }
  }
  return out;
}
const EXPORTS = new Map(files.map((f) => [f, exportsOf(src.get(f))]));

// ---- 1. imports
for (const [f, text] of src) {
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue; // k6/* built-ins
    const target = path.resolve(path.dirname(f), spec);
    if (!EXPORTS.has(target)) { bad(f, `import from '${spec}' does not resolve to a suite file`); continue; }
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !EXPORTS.get(target).has(name)) bad(f, `'${name}' is not exported by ${spec}`);
    }
  }
  for (const m of text.matchAll(/import\s+'([^']+)'/g)) {
    if (m[1].startsWith('.') && !EXPORTS.has(path.resolve(path.dirname(f), m[1]))) bad(f, `side-effect import '${m[1]}' not found`);
  }
}

// ---- 2. exec names in scenario files
for (const f of files.filter((x) => x.includes(`${path.sep}scenarios${path.sep}`))) {
  const text = src.get(f);
  const ex = EXPORTS.get(f);
  for (const m of text.matchAll(/\b(?:arrival|constantVus|rampVus)\(\s*'([A-Za-z0-9_$]+)'/g)) {
    if (!ex.has(m[1])) bad(f, `scenario exec '${m[1]}' is not an exported function`);
  }
  for (const m of text.matchAll(/exec:\s*'([A-Za-z0-9_$]+)'/g)) {
    if (!ex.has(m[1])) bad(f, `scenario exec '${m[1]}' is not an exported function`);
  }
  for (const m of text.matchAll(/\bexec:\s*'default'/g)) void m;
}

// ---- 3. endpoint labels
const registered = new Set();
for (const file of ['config/thresholds.js', 'config/campaign-endpoints.js']) {
  const t = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of t.matchAll(/'([a-z0-9_]+(?::[A-Za-z0-9_-]+)*)'/g)) registered.add(m[1]);
}
const UNREGISTERED_OK = new Set(['isolation:probe', 'setup:context']);
for (const f of files.filter((x) => !x.includes(`${path.sep}config${path.sep}`))) {
  const text = src.get(f);
  for (const m of text.matchAll(/observe(?:Create)?\(\s*[A-Za-z0-9_.\[\]]+\s*,\s*'([^']+)'/g)) {
    if (!registered.has(m[1]) && !UNREGISTERED_OK.has(m[1])) bad(f, `endpoint label '${m[1]}' is not registered in ENDPOINTS/CAMPAIGN_ENDPOINTS`);
  }
  // template-literal labels like `partner:${resource}:upsert` are checked by listing them:
  for (const m of text.matchAll(/observe\(\s*[A-Za-z0-9_.\[\]]+\s*,\s*`([^`]+)`/g)) {
    if (m[1].includes('${')) continue; // dynamic — covered by the explicit list in campaign-endpoints.js
  }
  // (and the two dynamic families used today)
}
// Labels built at run time (template literals / variables) cannot be matched textually, so
// each one is listed here and must be registered.
const DYNAMIC = ['partner:customers:upsert', 'partner:services:upsert', 'crm:search:code', 'crm:search:email',
  'crm:search:phone', 'crm:search:prefix', 'crm:search:name', 'crm:search:broad'];
for (const must of DYNAMIC) {
  if (!registered.has(must)) problems.push(`config: dynamic label '${must}' missing from CAMPAIGN_ENDPOINTS`);
}

// ---- 4. hardcoded targets
for (const [f, text] of src) {
  if (f.endsWith('guard.js')) continue;
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/['"`]https?:\/\/[^'"`$]*['"`]/.test(stripped.replace(/__ENV\.[A-Z_]+\s*\|\|\s*['"`]https?:\/\/[^'"`]+['"`]/g, ''))) {
    bad(f, 'contains a hardcoded http(s):// URL — the target must come only from BASE_URL (helpers/guard.js)');
  }
}

if (problems.length) {
  console.error(`lint-scenarios: ${problems.length} problem(s)\n  - ` + problems.join('\n  - '));
  process.exit(1);
}
console.log(`lint-scenarios: OK (${files.length} files, ${registered.size} registered endpoint labels)`);
