// Lints the TypeScript files changed since <base> and fails ONLY on problems that sit on lines the
// change ADDS (quality rules only: the prettier rule is off — see below).
//
//   node scripts/ci/lint-changed.mjs <base-sha>
//   LINT_INCLUDE_WORKTREE=1 node scripts/ci/lint-changed.mjs HEAD   # also lint uncommitted edits
//
// Why not "lint whole changed files": the tree carries ~77 rule errors and ~15,700 prettier errors
// (12,000 of them CRLF on a Windows checkout) that predate this gate. Whole-file linting would make
// every small fix in an old file fail for code it did not write. Line-level gating blocks NEW debt
// only; the backlog is a tracked follow-up.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { relative } from 'node:path';

const require = createRequire(import.meta.url);
const { ESLint } = require('eslint');

const base = process.argv[2];
if (!base) {
  console.error('usage: lint-changed.mjs <base-sha>');
  process.exit(2);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

try {
  git('cat-file', '-e', `${base}^{commit}`);
} catch {
  console.error(`base ${base} is not available locally (shallow clone?) — refusing to lint nothing`);
  process.exit(2);
}

const range = process.env.LINT_INCLUDE_WORKTREE ? [base] : [`${base}...HEAD`];
const files = git('diff', '--name-only', '--diff-filter=ACMR', ...range, '--', 'src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts')
  .split('\n')
  .filter(Boolean);
if (files.length === 0) {
  console.log(`No TypeScript files changed since ${base}.`);
  process.exit(0);
}

/** Added line numbers per file, from `git diff -U0` hunks (`@@ -a,b +c,d @@`). */
function addedLines(file) {
  const out = git('diff', '-U0', ...range, '--', file);
  const lines = new Set();
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

const eslint = new ESLint({ overrideConfig: { rules: { 'prettier/prettier': 'off' } } });
const results = await eslint.lintFiles(files);

let errors = 0;
for (const r of results) {
  const added = addedLines(relative(process.cwd(), r.filePath).replace(/\\/g, '/'));
  for (const m of r.messages) {
    if (m.severity !== 2 || !added.has(m.line)) continue;
    errors++;
    console.log(`${r.filePath}:${m.line}:${m.column}  ${m.message}  (${m.ruleId ?? 'parse'})`);
  }
}
console.log(`Linted ${files.length} changed file(s); ${errors} problem(s) on added lines.`);
process.exit(errors ? 1 : 0);
