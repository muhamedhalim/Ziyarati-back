/**
 * Real-PostgreSQL concurrency proof for FND-032 / M-04 (Wave 3).
 *
 * TR-003a: concurrency cannot be certified from mocks. Same pattern as
 * `usage-quota-concurrency.e2e-spec.ts` (FND-034).
 *
 * The bug (pre-fix): `SubscriptionService.changePlan` (and `.create`) call
 * `BillingService.generateInvoice` with NO race protection at all — no lock,
 * no pre-check, no DB constraint. Two concurrent `changePlan` calls for the
 * SAME subscription both read the current plan, both save, and both call
 * `generateInvoice`: two OPEN invoices for one subscription.
 *
 * M-04's fix is a partial unique index —
 * `UQ_sub_invoice_open_per_subscription ON subscription_invoices
 * (subscription_id) WHERE status = 'OPEN'` — deliberately NOT tenant+period
 * (data-model.md D-4: the table has no period column). This also means a
 * CLOSED/PAID invoice must never block a later one for the same subscription
 * — asserted explicitly below.
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
import { SubscriptionPlan } from '../src/entities/SaaS-Core/SubscriptionPlan';
import { SubscriptionInvoice } from '../src/entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, BillingCycle } from '../src/entities/enums';

const API = '/api/v1';

describe('Subscription invoice concurrency (FND-032/M-04, container-backed) — real Postgres', () => {
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

  async function seedTargetPlan(label: string): Promise<SubscriptionPlan> {
    const plans = e2e.dataSource.getRepository(SubscriptionPlan);
    return plans.save(
      plans.create({
        name: `Target Plan ${label}`,
        price: '199.00',
        billing_cycle: BillingCycle.MONTHLY,
        is_active: true,
        is_custom: false,
      }),
    );
  }

  async function cleanup(owner: SubscribedOwnerFixture, ...extraPlanIds: string[]): Promise<void> {
    await e2e.dataSource.query(`DELETE FROM subscription_invoices WHERE tenant_id = $1`, [owner.tenantId]);
    await cleanupSubscriptionFixture(e2e, owner.tenantId, owner.planId);
    for (const planId of extraPlanIds) {
      await e2e.dataSource.query(`DELETE FROM subscription_plans WHERE id = $1`, [planId]);
    }
    await cleanupTenant(e2e, owner.tenantId);
  }

  it('two concurrent change-plan requests yield at most one OPEN invoice', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'invoice-race');
    const target = await seedTargetPlan(owner.tenantId.slice(0, 8));

    const [r1, r2] = await Promise.all([
      request(e2e.app.getHttpServer())
        .post(`${API}/subscriptions/change-plan`)
        .set(...authHeader(owner.token))
        .send({ planId: target.id }),
      request(e2e.app.getHttpServer())
        .post(`${API}/subscriptions/change-plan`)
        .set(...authHeader(owner.token))
        .send({ planId: target.id }),
    ]);

    // DIRECT proof: at most one OPEN invoice for this subscription.
    const invoices = e2e.dataSource.getRepository(SubscriptionInvoice);
    const open = await invoices.count({
      where: { subscription_id: owner.subscriptionId, status: InvoiceStatus.OPEN },
    });
    expect(open).toBeLessThanOrEqual(1);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    await cleanup(owner, target.id);
  });

  // Regression guard (explicit per T059/M-04): a CLOSED/PAID invoice must
  // never block a later one for the same subscription — the constraint is
  // scoped to status='OPEN', not to the subscription alone.
  it('a paid invoice does not block a later invoice for the same subscription', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'invoice-reopen');
    const target1 = await seedTargetPlan(`${owner.tenantId.slice(0, 8)}-a`);
    const target2 = await seedTargetPlan(`${owner.tenantId.slice(0, 8)}-b`);

    const first = await request(e2e.app.getHttpServer())
      .post(`${API}/subscriptions/change-plan`)
      .set(...authHeader(owner.token))
      .send({ planId: target1.id });
    expect(first.status).toBe(200);

    const invoices = e2e.dataSource.getRepository(SubscriptionInvoice);
    await invoices.update(
      { subscription_id: owner.subscriptionId, status: InvoiceStatus.OPEN },
      { status: InvoiceStatus.PAID, paid_at: new Date() },
    );

    const second = await request(e2e.app.getHttpServer())
      .post(`${API}/subscriptions/change-plan`)
      .set(...authHeader(owner.token))
      .send({ planId: target2.id });
    expect(second.status).toBe(200);

    const openCount = await invoices.count({
      where: { subscription_id: owner.subscriptionId, status: InvoiceStatus.OPEN },
    });
    expect(openCount).toBe(1);

    await cleanup(owner, target1.id, target2.id);
  });
});
