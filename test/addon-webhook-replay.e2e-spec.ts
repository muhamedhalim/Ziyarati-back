/**
 * Pricing Catalog plan §24 — "addon-webhook-replay.e2e-spec.ts — redelivery
 * grants once; a late success after a failure; a late success after a
 * refund is refused."
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
import { Payment } from '../src/entities/Payments/Payment';
import { PaymentStatus } from '../src/entities/enums';

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

async function webhook(
  e2e: E2eApp,
  type: 'payment_paid' | 'payment_failed' | 'payment_refunded',
  gatewayPaymentId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await request(e2e.app.getHttpServer())
    .post(`${API}/payments/webhooks/moyasar`)
    .send({
      id: randomUUID(),
      type,
      created_at: new Date().toISOString(),
      data: { id: gatewayPaymentId, status: type === 'payment_paid' ? 'paid' : type.replace('payment_', ''), ...extra },
    })
    .expect(200);
  await new Promise((r) => setTimeout(r, 300));
}

async function createPurchase(
  e2e: E2eApp,
  token: string,
  itemKey: string,
): Promise<ResourcePurchase> {
  const res = await request(e2e.app.getHttpServer())
    .post(`${API}/resource-purchases`)
    .set(...authHeader(token))
    .send({ itemKey, quantity: 1, idempotencyKey: randomUUID() });
  expect(res.status).toBe(201);
  const purchases = e2e.dataSource.getRepository(ResourcePurchase);
  return purchases.findOneOrFail({ where: { id: res.body.purchase.id }, relations: { payment: true } });
}

describe('Add-on entitlement — webhook redelivery & terminal-status guard (plan §24, G14) — real Postgres', () => {
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

  it('a redelivered success webhook grants the capacity exactly once', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'replay-success', { max_branches: 5 });
    const purchase = await createPurchase(e2e, owner.token, 'branches');
    const gwId = purchase.payment!.gateway_payment_id!;
    const totalMinor = Number(purchase.total_minor);

    await webhook(e2e, 'payment_paid', gwId, { amount: totalMinor, currency: purchase.currency });
    await webhook(e2e, 'payment_paid', gwId, { amount: totalMinor, currency: purchase.currency }); // redelivery
    await webhook(e2e, 'payment_paid', gwId, { amount: totalMinor, currency: purchase.currency }); // redelivery again

    const ledgerRows = await e2e.dataSource.query(
      `SELECT amount_units FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'grant'`,
      [purchase.id],
    );
    expect(ledgerRows.length).toBe(1); // exactly one grant, never three
    expect(Number(ledgerRows[0].amount_units)).toBe(1);
  });

  it('a late success webhook after a genuine failure still grants (failure is not terminal)', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'replay-late-success', { max_branches: 5 });
    const purchase = await createPurchase(e2e, owner.token, 'branches');
    const gwId = purchase.payment!.gateway_payment_id!;

    await webhook(e2e, 'payment_failed', gwId);
    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('payment_failed');

    // The gateway reports success anyway (a late/out-of-order webhook) —
    // payment_failed is NOT in TERMINAL_PURCHASE_STATUSES, so this grants.
    await webhook(e2e, 'payment_paid', gwId, {
      amount: Number(purchase.total_minor),
      currency: purchase.currency,
    });
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('completed');

    const ledgerRows = await e2e.dataSource.query(
      `SELECT id FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'grant'`,
      [purchase.id],
    );
    expect(ledgerRows.length).toBe(1);
  });

  it('a late success webhook after a full refund is refused (refund IS terminal — G14)', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'replay-late-after-refund', {
      max_branches: 5,
    });
    const purchase = await createPurchase(e2e, owner.token, 'branches');
    const gwId = purchase.payment!.gateway_payment_id!;
    const totalMinor = Number(purchase.total_minor);

    await webhook(e2e, 'payment_paid', gwId, { amount: totalMinor, currency: purchase.currency });

    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('completed');

    // Full refund via the real refund webhook path.
    await webhook(e2e, 'payment_refunded', gwId);
    const afterRefund = await purchases.findOneOrFail({ where: { id: purchase.id } });
    expect(afterRefund.status).toBe('refunded');

    const capacityBefore = await e2e.dataSource.query(
      `SELECT GREATEST(SUM(CASE direction WHEN 'grant' THEN amount_units ELSE -amount_units END), 0) AS capacity
         FROM tenant_entitlement_ledger WHERE "tenantId" = $1 AND metric = 'branches'`,
      [owner.tenantId],
    );
    expect(Number(capacityBefore[0].capacity)).toBe(0);

    // A late/redelivered success now arrives — G14: 'refunded' IS terminal,
    // must NOT re-grant.
    await webhook(e2e, 'payment_paid', gwId, { amount: totalMinor, currency: purchase.currency });

    const grantRows = await e2e.dataSource.query(
      `SELECT id FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'grant'`,
      [purchase.id],
    );
    expect(grantRows.length).toBe(1); // still just the one original grant

    const capacityAfter = await e2e.dataSource.query(
      `SELECT GREATEST(SUM(CASE direction WHEN 'grant' THEN amount_units ELSE -amount_units END), 0) AS capacity
         FROM tenant_entitlement_ledger WHERE "tenantId" = $1 AND metric = 'branches'`,
      [owner.tenantId],
    );
    expect(Number(capacityAfter[0].capacity)).toBe(0); // NOT re-granted
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('refunded');

    // Tap Phase 2: the PAYMENT row must not regress either. Each Moyasar delivery
    // carries a fresh event id, so this late success is NOT de-duplicated — the old
    // guard ("not already PAID") flipped the REFUNDED payment back to PAID.
    expect(
      (await e2e.dataSource.getRepository(Payment).findOneByOrFail({ id: purchase.payment!.id })).status,
    ).toBe(PaymentStatus.REFUNDED);
  });
});
