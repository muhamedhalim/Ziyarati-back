import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * CR-47 guard. A `findOne({ where: { ..., tenant: { id } }, lock: { mode: 'pessimistic_write' } })`
 * LEFT JOINs `tenants` for the filter, and a bare `FOR UPDATE` then locks the tenant row too, so every
 * locked payment/refund/billing-upgrade lookup of a clinic serializes on that one row. Scoping the lock
 * with `tables: ['<table>']` renders `FOR UPDATE OF`. `test/integration/row-lock-scope.int-spec.ts`
 * proves the behaviour on a real database; this spec keeps a new call site from forgetting it.
 */
const SRC_ROOT = __dirname;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** Every `findOne({ ... })` call whose `where` filters on `tenant: {` and which takes a pessimistic lock. */
export function unscopedTenantLocks(text: string): number[] {
  const hits: number[] = [];
  const re = /findOne\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const next = text.indexOf('findOne(', m.index + 1);
    const block = text.slice(
      m.index,
      next === -1 ? m.index + 900 : Math.min(next, m.index + 900),
    );
    const lock = /lock:\s*\{([^}]*)\}/.exec(block);
    if (!lock || !/pessimistic_(write|read)/.test(lock[1])) continue;
    const beforeLock = block.slice(0, lock.index);
    if (!/\btenant:\s*\{/.test(beforeLock)) continue;
    if (/\btables:\s*\[/.test(lock[1])) continue;
    hits.push(text.slice(0, m.index).split('\n').length);
  }
  return hits;
}

describe('CR-47 - tenant-filtered pessimistic locks are scoped with `tables`', () => {
  it('no production findOne combines a `tenant: { ... }` filter with an unscoped pessimistic lock', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      for (const line of unscopedTenantLocks(readFileSync(file, 'utf8'))) {
        violations.push(`${relative(SRC_ROOT, file)}:${line}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the detector flags the unsafe shape and accepts the scoped one', () => {
    const unsafe = `repo.findOne({\n where: { id, tenant: { id: tenantId } },\n lock: { mode: 'pessimistic_write' },\n});`;
    const scoped = `repo.findOne({\n where: { id, tenant: { id: tenantId } },\n lock: { mode: 'pessimistic_write', tables: ['payments'] },\n});`;
    const noTenant = `repo.findOne({\n where: { id },\n lock: { mode: 'pessimistic_write' },\n});`;
    expect(unscopedTenantLocks(unsafe)).toHaveLength(1);
    expect(unscopedTenantLocks(scoped)).toEqual([]);
    expect(unscopedTenantLocks(noTenant)).toEqual([]);
  });
});
