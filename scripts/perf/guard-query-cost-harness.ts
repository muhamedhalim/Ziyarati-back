/**
 * PERF-BE-003 (Stage B) — measurement-only harness, MP-backend-03.
 *
 * Times the two specific DB queries identified during T146's guard-chain
 * trace, in isolation from HTTP/Express/Nest dispatch overhead:
 *   (a) the `AuthService.buildAuthenticatedUser` query (JwtAuthGuard/RBAC
 *       resolution) — users.findOne with the tenant+userRoles+role+
 *       rolePermissions+permission relation tree.
 *   (b) the `TenantLookupService.findById` query (ActiveTenantGuard) — the
 *       duplicate tenant-by-id lookup T146 traced.
 *
 * Never imported by src/, never run in the app process — a standalone
 * DataSource against the running LOCAL/T1 stack, exactly like
 * `src/config/data-source.ts`'s own migration-CLI pattern. No src/ file is
 * modified to take this measurement (Standing Rule 6).
 */
import { DataSource } from 'typeorm';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const USER_ID = process.argv[2];
const TENANT_ID = process.argv[3];
const N = Number(process.argv[4] ?? 50);
const OUT = process.argv[5] ?? 'guard-query-cost-before.json';

if (!USER_ID || !TENANT_ID) {
  console.error('usage: guard-query-cost-harness.ts <userId> <tenantId> [n] [outFile]');
  process.exit(1);
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.floor(q * (sorted.length - 1))];
}

function summarize(label: string, samplesMs: number[]) {
  const s = [...samplesMs].sort((a, b) => a - b);
  return {
    label,
    n: s.length,
    p50Ms: +percentile(s, 0.5).toFixed(3),
    p95Ms: +percentile(s, 0.95).toFixed(3),
    p99Ms: +percentile(s, 0.99).toFixed(3),
    minMs: +s[0].toFixed(3),
    maxMs: +s[s.length - 1].toFixed(3),
    avgMs: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3),
  };
}

async function time<T>(fn: () => Promise<T>): Promise<number> {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function main() {
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: [join(__dirname, '..', '..', 'src', 'entities', '**', '!(*.spec).{ts,js}')],
    synchronize: false,
    logging: false,
  });
  await ds.initialize();

  const { User } = require('../../src/entities/Auth&RBAC/User');
  const { Tenant } = require('../../src/entities/SaaS-Core/Tenant');
  const users = ds.getRepository(User);
  const tenants = ds.getRepository(Tenant);

  // warm-up (JIT/connection/plan cache) — discarded, matches MP-backend-03's
  // own disclosed limitation about JIT warm-up sensitivity at this scale.
  await users.findOne({
    where: { id: USER_ID },
    relations: { tenant: true, userRoles: { role: { rolePermissions: { permission: true } } } },
  });
  await tenants.findOne({ where: { id: TENANT_ID } });

  const authQueryMs: number[] = [];
  for (let i = 0; i < N; i++) {
    authQueryMs.push(
      await time(() =>
        users.findOne({
          where: { id: USER_ID },
          relations: { tenant: true, userRoles: { role: { rolePermissions: { permission: true } } } },
        }),
      ),
    );
  }

  const tenantQueryMs: number[] = [];
  for (let i = 0; i < N; i++) {
    tenantQueryMs.push(await time(() => tenants.findOne({ where: { id: TENANT_ID } })));
  }

  const result = {
    environmentClass: 'LOCAL',
    dataTier: 'T1',
    userId: USER_ID,
    tenantId: TENANT_ID,
    authQuery: summarize(
      'AuthService.buildAuthenticatedUser query (JwtAuthGuard/RBAC resolution)',
      authQueryMs,
    ),
    tenantQuery: summarize(
      'TenantLookupService.findById query (ActiveTenantGuard duplicate fetch)',
      tenantQueryMs,
    ),
  };

  console.log(JSON.stringify(result, null, 2));
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  await ds.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
