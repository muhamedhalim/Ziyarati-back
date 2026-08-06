/**
 * Real-PostgreSQL concurrency proof for FND-034 (Wave 3).
 *
 * TR-003a: concurrency cannot be certified from mocks. Boots the real
 * AppModule against real Postgres, same pattern as
 * `refund-concurrency.e2e-spec.ts` (FND-026, Wave 1).
 *
 * The bug (pre-fix): `UsageService.assertWithinLimit` (a READ: fetch the
 * current usage row, compare to the plan limit) and the call site's later
 * `UsageService.increment` (a separate WRITE) are two round-trips with a gap
 * between them — textbook check-then-act. Two concurrent requests at
 * used=99/limit=100 can both read "99 < 100, OK" before either has
 * incremented, so both are admitted: 101 campaigns created against a
 * 100-campaign monthly cap.
 *
 * Uses the `campaigns` endpoint (AD-10's four call sites all share the same
 * `assertWithinLimit`/`increment` pair) — POST /campaigns needs only
 * `type`+`name`, no template/account/appointment fixtures, so it is the
 * simplest of the four to race.
 */
import request from 'supertest';
import { DataSource } from 'typeorm';

import {
  createE2eApp,
  authHeader,
  cleanupTenant,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import {
  createSubscribedOwnerFixture,
  setPaidMode,
  resetBillingMode,
  seedUsage,
  cleanupSubscriptionFixture,
  type SubscribedOwnerFixture,
} from './utils/subscription-e2e-fixtures';
import { Campaign } from '../src/entities/Campaigns/Campaign';
import { UsageService } from '../src/modules/subscription-billing/usage.service';
import { USAGE_METRIC } from '../src/modules/subscription-billing/usage-metric';

const API = '/api/v1';

describe('Usage quota concurrency (FND-034, container-backed) — real Postgres', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
    await setPaidMode(e2e);
  }, 60_000);

  afterAll(async () => {
    // Must run before app.close() — see max-users-concurrency.e2e-spec.ts's
    // identical comment: the global billing-mode flip in beforeAll is
    // process-wide and would otherwise leak into later e2e suites.
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  async function seedAtBoundary(label: string, used: number, limit: number): Promise<SubscribedOwnerFixture> {
    const owner = await createSubscribedOwnerFixture(e2e, label, { max_campaigns: limit }, ['campaigns']);
    await seedUsage(e2e, owner.tenantId, owner.subscriptionId, 'campaigns_used', used);
    return owner;
  }

  async function cleanup(owner: SubscribedOwnerFixture): Promise<void> {
    await e2e.dataSource.query(`DELETE FROM campaigns WHERE "tenantId" = $1`, [owner.tenantId]);
    await cleanupSubscriptionFixture(e2e, owner.tenantId, owner.planId);
    await cleanupTenant(e2e, owner.tenantId);
  }

  it('two concurrent creates at 99/100 admit at most one', async () => {
    const owner = await seedAtBoundary('quota-race', 99, 100);

    const [r1, r2] = await Promise.all([
      request(e2e.app.getHttpServer())
        .post(`${API}/campaigns`)
        .set(...authHeader(owner.token))
        .send({ type: 'PROMOTION', name: 'Race A' }),
      request(e2e.app.getHttpServer())
        .post(`${API}/campaigns`)
        .set(...authHeader(owner.token))
        .send({ type: 'PROMOTION', name: 'Race B' }),
    ]);

    // DIRECT proof: count campaigns actually created for this tenant. Pre-fix
    // this is 2 (both 201s) against a limit of 100 starting at 99 used — one
    // unit over. Post-fix exactly one is admitted.
    const campaigns = e2e.dataSource.getRepository(Campaign);
    const created = await campaigns.count({ where: { tenant: { id: owner.tenantId } } });
    expect(created).toBeLessThanOrEqual(1);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 422]);

    await cleanup(owner);
  });

  it('ten concurrent creates at 95/100 admit at most five', async () => {
    const owner = await seedAtBoundary('quota-race-burst', 95, 100);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(e2e.app.getHttpServer())
          .post(`${API}/campaigns`)
          .set(...authHeader(owner.token))
          .send({ type: 'PROMOTION', name: `Burst ${i}` }),
      ),
    );

    const campaigns = e2e.dataSource.getRepository(Campaign);
    const created = await campaigns.count({ where: { tenant: { id: owner.tenantId } } });
    expect(created).toBeLessThanOrEqual(5);

    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded.length).toBe(created);

    await cleanup(owner);
  });

  // Regression guard: the fix must not touch the ordinary, well-under-limit path.
  it('a single request well under the limit still succeeds', async () => {
    const owner = await seedAtBoundary('quota-normal', 0, 100);

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/campaigns`)
      .set(...authHeader(owner.token))
      .send({ type: 'PROMOTION', name: 'Normal' });

    expect(res.status).toBe(201);

    await cleanup(owner);
  });

  // Regression guard: free-mode/override short-circuit must survive the fix.
  it('a tenant over the limit is still refused outright (non-concurrent)', async () => {
    const owner = await seedAtBoundary('quota-over', 100, 100);

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/campaigns`)
      .set(...authHeader(owner.token))
      .send({ type: 'PROMOTION', name: 'Over' });

    expect(res.status).toBe(422);

    await cleanup(owner);
  });

  // FND-047 fix-verification block. Pre-fix, this whole file hung: the FIRST
  // test above passed (2-way concurrency has plenty of pool headroom), but
  // "ten concurrent creates" (and everything scheduled after it) hit Jest's
  // 30s timeout with zero progress — see evidence/wave7-new-findings.md and
  // evidence/fnd-047-fix.md for the live pg_stat_activity reproduction.
  describe('FND-047 — pool-deadlock fix verification', () => {
    // Higher than DB_POOL_MAX (10 in this environment's .env) — proves the fix
    // isn't merely "exactly at the pool size happens to work", and that
    // oversubscription now queues/clears normally instead of deadlocking.
    it('a burst larger than the pool size (20-way) completes without hanging', async () => {
      const owner = await seedAtBoundary('quota-burst-20', 0, 1000);

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          request(e2e.app.getHttpServer())
            .post(`${API}/campaigns`)
            .set(...authHeader(owner.token))
            .send({ type: 'PROMOTION', name: `Big Burst ${i}` }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 201);
      expect(succeeded.length).toBe(20);

      await cleanup(owner);
    }, 30_000);

    // No leaked connections: every transaction opened by the burst above must
    // have committed and released its connection — none left STUCK open. Scoped
    // to "stuck for more than a few seconds" rather than "zero at this instant" —
    // the full AppModule's own background workers/schedulers may legitimately
    // hold a brand-new, still-in-flight transaction for their own unrelated
    // work at the exact moment this queries pg_stat_activity; a genuine LEAK
    // (this test's actual concern) shows up as one stuck indefinitely, not as
    // one that clears within a couple of seconds.
    it('a burst leaves no idle-in-transaction connection stuck open', async () => {
      const owner = await seedAtBoundary('quota-leak-check', 0, 100);

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          request(e2e.app.getHttpServer())
            .post(`${API}/campaigns`)
            .set(...authHeader(owner.token))
            .send({ type: 'PROMOTION', name: `Leak ${i}` }),
        ),
      );

      // Give any legitimately-in-flight background transaction a moment to
      // finish before judging anything "stuck".
      await new Promise((resolve) => setTimeout(resolve, 500));

      const rows = await e2e.dataSource.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND state = 'idle in transaction'
           AND now() - state_change > interval '3 seconds'`,
      );
      expect(rows[0].n).toBe(0);

      await cleanup(owner);
    }, 30_000);

    // Rollback after downstream failure: a failure occurring AFTER admission
    // but INSIDE the same transaction must roll the reservation back too —
    // proven directly against the real `UsageService`/real Postgres, since
    // the HTTP campaign-create path has no built-in way to fail deterministically
    // after admission without touching campaign.service.ts (out of FND-047 scope).
    it('a downstream failure after admission rolls back the reservation (no permanent charge)', async () => {
      const owner = await seedAtBoundary('quota-rollback', 50, 100);
      const usageService = e2e.moduleRef.get(UsageService, { strict: false });

      await expect(
        e2e.dataSource.transaction(async (manager) => {
          const admission = await usageService.incrementIfWithinLimit(
            owner.tenantId,
            USAGE_METRIC.CAMPAIGNS,
            1,
            manager,
          );
          expect(admission.applied).toBe(true);
          throw new Error('simulated downstream failure after admission');
        }),
      ).rejects.toThrow('simulated downstream failure after admission');

      const usage = await usageService.getUsage(owner.tenantId);
      expect(usage.campaignsUsed).toBe(50); // unchanged — rolled back with the transaction

      await cleanup(owner);
    });

    // Defense-in-depth (typeorm.config.ts's connectionTimeoutMillis): a
    // genuinely exhausted pool must fail bounded and clearly, never hang
    // forever — proven against an isolated throwaway pool of size 1 so the
    // assertion doesn't depend on this environment's real DB_POOL_MAX.
    it('a genuinely exhausted pool fails with a bounded timeout, not an unbounded hang', async () => {
      const probe = new DataSource({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        extra: { max: 1, connectionTimeoutMillis: 500 },
      });
      await probe.initialize();

      // A manually-held QueryRunner, explicitly awaited, so the pool's ONE
      // connection is DETERMINISTICALLY checked out before the second query
      // below is attempted — `probe.transaction(cb)` without awaiting the
      // outer promise would race the second query for that same connection.
      const heldRunner = probe.createQueryRunner();
      await heldRunner.connect();
      await heldRunner.startTransaction();

      try {
        const start = Date.now();
        await expect(probe.query('SELECT 1')).rejects.toThrow();
        expect(Date.now() - start).toBeLessThan(5_000);
      } finally {
        await heldRunner.rollbackTransaction();
        await heldRunner.release();
        await probe.destroy();
      }
    }, 15_000);
  });
});
