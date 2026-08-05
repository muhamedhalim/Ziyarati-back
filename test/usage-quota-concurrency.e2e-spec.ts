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
});
