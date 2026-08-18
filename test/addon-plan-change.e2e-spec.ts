/**
 * Pricing Catalog plan §24 — "addon-plan-change.e2e-spec.ts — upgrade and
 * downgrade after purchase; capacity and credits both survive."
 *
 * Capacity add-ons are permanent additive deltas on the ledger, independent
 * of the plan (plan §6 decision 2) — this proves that in real Postgres by
 * swapping the tenant's subscription onto different plans after a purchase
 * and re-reading the enforced limit each time.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { createE2eApp, authHeader, type E2eApp } from './utils/whatsapp-e2e-app';
import {
  createSubscribedOwnerFixture,
  setPaidMode,
  resetBillingMode,
} from './utils/subscription-e2e-fixtures';
import { ResourcePriceCatalog } from '../src/entities/ResourcePricing/ResourcePriceCatalog';
import { ResourcePurchase } from '../src/entities/ResourcePricing/ResourcePurchase';
import { SubscriptionPlan } from '../src/entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../src/entities/SaaS-Core/Subscription';
import { BillingCycle } from '../src/entities/enums';

const API = '/api/v1';

async function activateCatalogItem(
  e2e: E2eApp,
  itemKey: string,
  unitPriceMinor: string,
): Promise<void> {
  const catalog = e2e.dataSource.getRepository(ResourcePriceCatalog);
  const item = await catalog.findOneOrFail({ where: { item_key: itemKey } });
  item.unit_price_minor = unitPriceMinor;
  item.is_active = true;
  await catalog.save(item);
}

async function payWebhook(e2e: E2eApp, gwId: string, amountCents: number, currency: string): Promise<void> {
  await request(e2e.app.getHttpServer())
    .post(`${API}/payments/webhooks/moyasar`)
    .send({
      id: randomUUID(),
      type: 'payment_paid',
      created_at: new Date().toISOString(),
      data: { id: gwId, status: 'paid', amount: amountCents, currency },
    })
    .expect(200);
  await new Promise((r) => setTimeout(r, 300));
}

describe('Add-on capacity survives a plan change (plan §6/§24) — real Postgres', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
    await setPaidMode(e2e);
    await activateCatalogItem(e2e, 'branches', '5000');
  }, 60_000);

  afterAll(async () => {
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  it('a purchased +2 branches survives both an upgrade and a downgrade of the underlying plan', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'plan-change', { max_branches: 3 });

    const purchaseRes = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'branches', quantity: 2, idempotencyKey: randomUUID() });
    expect(purchaseRes.status).toBe(201);

    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    const purchase = await purchases.findOneOrFail({
      where: { id: purchaseRes.body.purchase.id },
      relations: { payment: true },
    });
    await payWebhook(e2e, purchase.payment!.gateway_payment_id!, Number(purchase.total_minor), purchase.currency);

    const breakdown1 = await request(e2e.app.getHttpServer())
      .get(`${API}/usage/breakdown`)
      .set(...authHeader(owner.token));
    // getBreakdown only covers the 4 metered metrics — read the capacity
    // ledger directly for a count-based metric like branches.
    const capacity = async () => {
      const rows = await e2e.dataSource.query(
        `SELECT GREATEST(SUM(CASE direction WHEN 'grant' THEN amount_units ELSE -amount_units END), 0) AS capacity
           FROM tenant_entitlement_ledger WHERE "tenantId" = $1 AND metric = 'branches'`,
        [owner.tenantId],
      );
      return Number(rows[0]?.capacity ?? 0);
    };
    expect(await capacity()).toBe(2); // ledger itself, unaffected by plan
    void breakdown1; // metered-metrics endpoint isn't the relevant proof here

    const plans = e2e.dataSource.getRepository(SubscriptionPlan);
    const subscriptions = e2e.dataSource.getRepository(Subscription);

    // Upgrade: plan cap 3 → 10.
    const upgradedPlan = await plans.save(
      plans.create({
        name: `E2E Upgraded ${owner.tenantId.slice(0, 8)}`,
        price: '199.00',
        billing_cycle: BillingCycle.MONTHLY,
        is_active: true,
        is_custom: false,
        max_branches: 10,
      }),
    );
    await subscriptions.update({ id: owner.subscriptionId }, { plan: { id: upgradedPlan.id } as SubscriptionPlan });
    expect(await capacity()).toBe(2); // the ledger doesn't move

    const branchAfterUpgrade = await request(e2e.app.getHttpServer())
      .post(`${API}/branches`)
      .set(...authHeader(owner.token))
      .send({ name: 'Branch after upgrade' });
    expect(branchAfterUpgrade.status).toBe(201); // 1 existing branch + this one = 2, well under 10+2=12

    // Downgrade: plan cap 3 → 1. Effective enforced limit = max(1, override) + 2 = 3.
    const downgradedPlan = await plans.save(
      plans.create({
        name: `E2E Downgraded ${owner.tenantId.slice(0, 8)}`,
        price: '19.00',
        billing_cycle: BillingCycle.MONTHLY,
        is_active: true,
        is_custom: false,
        max_branches: 1,
      }),
    );
    await subscriptions.update({ id: owner.subscriptionId }, { plan: { id: downgradedPlan.id } as SubscriptionPlan });
    expect(await capacity()).toBe(2); // still untouched by the plan swap

    // 1 branch exists so far; effective limit is 1(plan)+2(addon)=3 — two more fit.
    const branchAfterDowngrade = await request(e2e.app.getHttpServer())
      .post(`${API}/branches`)
      .set(...authHeader(owner.token))
      .send({ name: 'Branch after downgrade' });
    expect(branchAfterDowngrade.status).toBe(201); // 2 total

    const branchAtCeiling = await request(e2e.app.getHttpServer())
      .post(`${API}/branches`)
      .set(...authHeader(owner.token))
      .send({ name: 'Branch at ceiling' });
    expect(branchAtCeiling.status).toBe(201); // 3 total — exactly the 1+2 ceiling

    const overLimit = await request(e2e.app.getHttpServer())
      .post(`${API}/branches`)
      .set(...authHeader(owner.token))
      .send({ name: 'Branch overflow after downgrade' });
    expect(overLimit.status).toBe(422); // 4th would exceed 1(plan)+2(addon)=3
  });
});
