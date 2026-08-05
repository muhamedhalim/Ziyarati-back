/**
 * Real-PostgreSQL concurrency proof for FND-007 (Wave 3).
 *
 * TR-003a: concurrency cannot be certified from mocks. Same pattern as
 * `usage-quota-concurrency.e2e-spec.ts` (FND-034) and
 * `refund-concurrency.e2e-spec.ts` (FND-026).
 *
 * The bug (pre-fix): `AuthService.createTenantUser` reads
 * `currentUsers = await this.users.count(...)` and calls
 * `usage.assertCountWithinLimit(tenantId, COUNT_LIMIT.USERS, currentUsers)`
 * — both reads — BEFORE the actual `INSERT` (inside a later, separate
 * transaction). Two concurrent requests each count the SAME pre-insert total,
 * both see room for one more, and both insert: `max_users + 1` staff created
 * against the plan's seat cap.
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
  cleanupSubscriptionFixture,
  type SubscribedOwnerFixture,
} from './utils/subscription-e2e-fixtures';
import { User } from '../src/entities/Auth&RBAC/User';

const API = '/api/v1';

describe('Seat cap (max_users) concurrency (FND-007, container-backed) — real Postgres', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
    await setPaidMode(e2e);
  }, 60_000);

  afterAll(async () => {
    // Must run before app.close() — the global billing-mode flip this suite
    // set in beforeAll is process-wide (test/utils/subscription-e2e-fixtures.ts),
    // not scoped to this file, and would otherwise leak into every e2e suite
    // that runs after this one under --runInBand's shared process/database.
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  async function cleanup(owner: SubscribedOwnerFixture): Promise<void> {
    await cleanupSubscriptionFixture(e2e, owner.tenantId, owner.planId);
    await cleanupTenant(e2e, owner.tenantId);
  }

  // The owner fixture itself is user #1 — max_users: 2 leaves room for
  // exactly one more staff member.
  it('two concurrent staff creations at 1/2 seats admit at most one', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'seat-race', { max_users: 2 });
    const suffix = owner.tenantId.slice(0, 8);

    const [r1, r2] = await Promise.all([
      request(e2e.app.getHttpServer())
        .post(`${API}/auth/register-user`)
        .set(...authHeader(owner.token))
        .send({ email: `staff-a-${suffix}@example.test`, password: 'TempPass123!', fullName: 'Staff A', phone: '+966500000001' }),
      request(e2e.app.getHttpServer())
        .post(`${API}/auth/register-user`)
        .set(...authHeader(owner.token))
        .send({ email: `staff-b-${suffix}@example.test`, password: 'TempPass123!', fullName: 'Staff B', phone: '+966500000002' }),
    ]);

    // DIRECT proof: total user count for this tenant (owner + any admitted
    // staff) must never exceed the plan's seat cap. Pre-fix this is 3 > 2.
    const users = e2e.dataSource.getRepository(User);
    const total = await users.count({ where: { tenant: { id: owner.tenantId } } });
    expect(total).toBeLessThanOrEqual(2);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 422]);

    await cleanup(owner);
  });

  // Regression guard: the ordinary, well-under-cap path must still work.
  it('a single staff creation well under the cap still succeeds', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'seat-normal', { max_users: 10 });
    const suffix = owner.tenantId.slice(0, 8);

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/register-user`)
      .set(...authHeader(owner.token))
      .send({ email: `staff-${suffix}@example.test`, password: 'TempPass123!', fullName: 'Staff', phone: '+966500000003' });

    expect(res.status).toBe(201);

    await cleanup(owner);
  });
});
