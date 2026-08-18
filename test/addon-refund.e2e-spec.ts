/**
 * Pricing Catalog plan §24 — "addon-refund.e2e-spec.ts — full and partial
 * refund reversal end to end, including a refund arriving via each of the
 * three emission paths" (webhook reconciliation and the real `POST
 * /refunds` HTTP path — `RefundRecoveryService`'s background-job path is
 * unit-tested directly, not driven through this suite's real-time HTTP
 * surface).
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

async function refundWebhook(
  e2e: E2eApp,
  gwId: string,
  refundedCents?: number,
): Promise<void> {
  await request(e2e.app.getHttpServer())
    .post(`${API}/payments/webhooks/moyasar`)
    .send({
      id: randomUUID(),
      type: 'payment_refunded',
      created_at: new Date().toISOString(),
      data: { id: gwId, status: 'refunded', ...(refundedCents != null ? { refunded: refundedCents } : {}) },
    })
    .expect(200);
  await new Promise((r) => setTimeout(r, 300));
}

async function createAndPay(
  e2e: E2eApp,
  token: string,
  itemKey: string,
  quantity: number,
): Promise<ResourcePurchase> {
  const res = await request(e2e.app.getHttpServer())
    .post(`${API}/resource-purchases`)
    .set(...authHeader(token))
    .send({ itemKey, quantity, idempotencyKey: randomUUID() });
  expect(res.status).toBe(201);
  const purchases = e2e.dataSource.getRepository(ResourcePurchase);
  const purchase = await purchases.findOneOrFail({
    where: { id: res.body.purchase.id },
    relations: { payment: true },
  });
  await payWebhook(e2e, purchase.payment!.gateway_payment_id!, Number(purchase.total_minor), purchase.currency);
  return purchases.findOneOrFail({ where: { id: purchase.id }, relations: { payment: true } });
}

describe('Add-on refund reversal (plan §14/§24) — real Postgres', () => {
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

  async function capacityFor(tenantId: string, metric: string): Promise<number> {
    const rows = await e2e.dataSource.query(
      `SELECT GREATEST(SUM(CASE direction WHEN 'grant' THEN amount_units ELSE -amount_units END), 0) AS capacity
         FROM tenant_entitlement_ledger WHERE "tenantId" = $1 AND metric = $2`,
      [tenantId, metric],
    );
    return Number(rows[0]?.capacity ?? 0);
  }

  it('a full refund via the Moyasar webhook path fully revokes the granted capacity', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'refund-webhook-full', { max_branches: 5 });
    const purchase = await createAndPay(e2e, owner.token, 'branches', 3);
    expect(await capacityFor(owner.tenantId, 'branches')).toBe(3);

    await refundWebhook(e2e, purchase.payment!.gateway_payment_id!); // no `refunded` ⇒ full

    expect(await capacityFor(owner.tenantId, 'branches')).toBe(0);
    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('refunded');
  });

  it('a partial refund via the Moyasar webhook path revokes proportionally, purchase stays completed', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'refund-webhook-partial', { max_branches: 5 });
    // quantity 4 @ 5000 minor = 20000 total; delta_units = 4.
    const purchase = await createAndPay(e2e, owner.token, 'branches', 4);
    expect(await capacityFor(owner.tenantId, 'branches')).toBe(4);

    // Refund 5000 of 20000 (25%) ⇒ targetRevoked = floor(4 * 5000 / 20000) = 1.
    await refundWebhook(e2e, purchase.payment!.gateway_payment_id!, 5000);

    expect(await capacityFor(owner.tenantId, 'branches')).toBe(3); // 4 - 1
    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('completed');
  });

  it('repeated partial refunds converge and only revoke each NEW delta, never the whole target again', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'refund-webhook-repeated', { max_branches: 5 });
    // quantity 10 @ 5000 minor = 50000 total; delta_units = 10.
    const purchase = await createAndPay(e2e, owner.token, 'branches', 10);
    expect(await capacityFor(owner.tenantId, 'branches')).toBe(10);

    await refundWebhook(e2e, purchase.payment!.gateway_payment_id!, 20000); // 40% ⇒ target 4
    expect(await capacityFor(owner.tenantId, 'branches')).toBe(6); // 10 - 4

    await refundWebhook(e2e, purchase.payment!.gateway_payment_id!, 50000); // 100% cumulative ⇒ target 10
    expect(await capacityFor(owner.tenantId, 'branches')).toBe(0); // 10 - 4 - 6 = 0

    const revokeRows = await e2e.dataSource.query(
      `SELECT amount_units FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'revoke' ORDER BY created_at`,
      [purchase.id],
    );
    expect(revokeRows.map((r: { amount_units: string }) => Number(r.amount_units))).toEqual([4, 6]);

    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('refunded');
  });

  it('a full refund via the real POST /refunds HTTP path (a second real emission path) also revokes fully', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'refund-http-endpoint', { max_branches: 5 });
    const purchase = await createAndPay(e2e, owner.token, 'branches', 2);
    expect(await capacityFor(owner.tenantId, 'branches')).toBe(2);

    const refundRes = await request(e2e.app.getHttpServer())
      .post(`${API}/refunds`)
      .set(...authHeader(owner.token))
      .send({ paymentId: purchase.payment!.id });
    expect(refundRes.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));

    expect(await capacityFor(owner.tenantId, 'branches')).toBe(0);
    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('refunded');
  });

  it('a redelivered full-refund webhook does not double-revoke (no negative capacity)', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'refund-redelivery', { max_branches: 5 });
    const purchase = await createAndPay(e2e, owner.token, 'branches', 2);

    await refundWebhook(e2e, purchase.payment!.gateway_payment_id!);
    await refundWebhook(e2e, purchase.payment!.gateway_payment_id!);
    await refundWebhook(e2e, purchase.payment!.gateway_payment_id!);

    expect(await capacityFor(owner.tenantId, 'branches')).toBe(0);
    const revokeRows = await e2e.dataSource.query(
      `SELECT id FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'revoke'`,
      [purchase.id],
    );
    expect(revokeRows.length).toBe(1); // redelivery is a no-op, never a second revoke row
  });
});
