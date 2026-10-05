#!/usr/bin/env node
/**
 * Runs the whole k6 suite under a Node SHIM of the k6 runtime (lab/shim/*) — no k6, no Docker,
 * no network. It cannot judge performance; it exists to catch, BEFORE a long run, the failures
 * that would otherwise surface minutes into one:
 *
 *   - init-time errors: invalid or duplicate metric names, SharedArray misuse, bad imports
 *   - scenario definitions: exec functions that do not exist, missing executor fields
 *   - flow RUNTIME errors: typos, undefined variables, wrong property access, null session fields
 *     — every scenario's exec functions are executed once, and the persona engine is driven as
 *     one VU of EVERY persona, against synthetic sessions/packs and a fake HTTP layer
 *   - handleSummary: returns a /reports file and does not throw
 *   - metric tags that are undefined (k6 would reject or silently drop them)
 * Also lists the request paths each scenario exercised, so a flow that silently sends nothing is visible.
 *
 *   node tests/load/lab/shim-check.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOAD = path.resolve(HERE, '..');
const verbose = process.argv.includes('--verbose');
const REGISTER = path.join(HERE, 'shim', 'register.mjs');

function runChild(target, vu, ticks, envOverride) {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(REGISTER).href, path.join(HERE, 'shim-run.mjs'), target, String(vu || 1), String(ticks || 6)], {
    encoding: 'utf8', cwd: LOAD, env: Object.assign({}, process.env, envOverride ? { SHIM_ENV: JSON.stringify(envOverride) } : {}), timeout: 60000,
  });
  const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) return { target, ok: false, errors: [`no output: ${(r.stderr || '').split('\n').slice(0, 4).join(' | ')}`] };
  return JSON.parse(line);
}

const scenarios = fs.readdirSync(path.join(LOAD, 'scenarios')).filter((f) => f.endsWith('.js')).sort();
// Scenarios that need packs the shim provides; legacy scenarios use the old login helper and need a different shim — skip them.
const LEGACY = new Set(['smoke.js', 'baseline.js', 'mixed-workload.js', 'progressive-sweep.js', 'appointments-write.js', 'public-booking.js', 'spike.js', 'soak.js', 'vu-ladder.js']);
const targets = scenarios.filter((f) => !LEGACY.has(f)).map((f) => `scenarios/${f}`);

let failed = 0;
const report = [];
for (const t of targets) {
  const r = runChild(t, 1, 1, t.includes('payment-webhook') ? { LT_PAY_PARTS: 'resolve,checkout,race,return,webhook,webhook-dup,billing,refund' } : undefined);
  report.push(r);
  if (!r.ok) failed++;
}

// Persona engine: one VU per persona bucket (VU ids 1..100 cover every persona deterministically)
const personasSeen = new Set(); let personaRuns = 0;
for (let vu = 1; vu <= 100 && personasSeen.size < 7; vu++) {
  const r = runChild('flows/campaign.js', vu, 40, { LT_PERSONA_MIX: 'receptionist:30,doctor:20,owner:15,idle:5,public:15,marketplace:8,partner:7' });
  const persona = ((r.executed && r.executed[0]) || '').match(/persona (\w+)/);
  if (persona && !personasSeen.has(persona[1])) { personasSeen.add(persona[1]); personaRuns++; report.push(Object.assign(r, { target: `persona:${persona[1]} (vu ${vu})` })); if (!r.ok) failed++; }
}

for (const r of report) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.target}${r.executed && r.executed.length ? `  [ran: ${r.executed.join(', ')}]` : ''}  requests=${r.requests ?? '-'} metrics=${r.metrics ?? '-'}`);
  for (const e of r.errors || []) console.log(`       ! ${e}`);
  if (verbose && r.paths) console.log(`       paths: ${r.paths.join('; ')}`);
}
console.log(`\nshim-check: ${report.length - failed}/${report.length} OK; personas exercised: ${[...personasSeen].join(', ') || 'none'}`);
if (personasSeen.size < 7) { console.log(`WARNING: only ${personasSeen.size}/7 personas were reached`); }
process.exit(failed ? 1 : 0);
