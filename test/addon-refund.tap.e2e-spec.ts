/**
 * Tap migration, Phase 2 gate — the add-on refund-reversal suite
 * (`addon-refund.e2e-spec.ts`) ported to TAP.
 *
 * Scope note. The legacy suite drives three emission paths. For Tap, only the
 * real `POST /refunds` HTTP path is live in Phase 2: Tap refund WEBHOOKS are
 * verified and logged but deliberately not applied until Phase 5 (a Tap refund
 * can be asynchronous, and `RefundService` cannot yet represent a PENDING one).
 * So the webhook-driven cases are not ported; instead this suite pins the
 * CURRENT safe behaviour of an asynchronous refund — nothing is revoked.
 *
 * Real Postgres + Redis + AppModule; only Tap's network is stubbed.
 */
import './utils/tap-e2e-env.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  authHeader,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import {
  createSubscribedOwnerFixture,
  setPaidMode,
  resetBillingMode,
} from './utils/subscription-e2e-fixtures';
import { TapSandbox, settle } from './utils/tap-e2e';
import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { ResourcePriceCatalog } from '../src/entities/ResourcePricing/ResourcePriceCatalog';
import { ResourcePurchase } from '../src/entities/ResourcePricing/ResourcePurchase';
import { Payment } from '../src/entities/Payments/Payment';
import { PaymentStatus } from '../src/entities/enums';

const API = '/api/v1';

describe('Add-on refund reversal over TAP (plan §14/§24) — real Postgres', () => {
  let e2e: E2eApp;
  const tap = new TapSandbox();

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    const catalog = e2e.dataSource.getRepository(ResourcePriceCatalog);
    const item = await catalog.findOneOrFail({
      where: { item_key: 'branches' },
    });
    item.unit_price_minor = '5000';
    item.is_active = true;
    await catalog.save(item);
  }, 90_000);

  beforeEach(() => {
    tap.refundStatus = 'REFUNDED';
  });

  afterAll(async () => {
    await settle();
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  async function capacityFor(tenantId: string): Promise<number> {
    const rows = await e2e.dataSource.query(
      `SELECT GREATEST(SUM(CASE direction WHEN 'grant' THEN amount_units ELSE -amount_units END), 0) AS capacity
         FROM tenant_entitlement_ledger WHERE "tenantId" = $1 AND metric = 'branches'`,
      [tenantId],
    );
    return Number(rows[0]?.capacity ?? 0);
  }

  const purchaseOf = (id: string) =>
    e2e.dataSource
      .getRepository(ResourcePurchase)
      .findOneOrFail({ where: { id } });
  const paymentOf = (id: string) =>
    e2e.dataSource.getRepository(Payment).findOneByOrFail({ id });

  /** Buy `quantity` units through the API and pay them through a signed Tap webhook. */
  async function createAndPay(
    token: string,
    quantity: number,
  ): Promise<ResourcePurchase> {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(token))
      .send({ itemKey: 'branches', quantity, idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    const purchase = await e2e.dataSource
      .getRepository(ResourcePurchase)
      .findOneOrFail({
        where: { id: res.body.purchase.id },
        relations: { payment: true },
      });
    await tap
      .deliver(e2e.app, tap.capture(purchase.payment!.gateway_payment_id!))
      .expect(200);
    await settle();
    return purchase;
  }

  const refund = (token: string, paymentId: string, amount?: number) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/refunds`)
      .set(...authHeader(token))
      .send({ paymentId, ...(amount != null ? { amount } : {}) });

  it('a full refund through POST /refunds fully revokes the granted capacity', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-refund-full', {
      max_branches: 5,
    });
    const purchase = await createAndPay(owner.token, 3);
    expect(await capacityFor(owner.tenantId)).toBe(3);

    await refund(owner.token, purchase.payment!.id).expect(201);
    await settle();

    expect(await capacityFor(owner.tenantId)).toBe(0);
    expect((await purchaseOf(purchase.id)).status).toBe('refunded');
    expect((await paymentOf(purchase.payment!.id)).status).toBe(
      PaymentStatus.REFUNDED,
    );
  });

  it('sends Tap an idempotent, per-refund request (never the payment id as the key)', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-refund-shape', {
      max_branches: 5,
    });
    const purchase = await createAndPay(owner.token, 2);

    await refund(owner.token, purchase.payment!.id).expect(201);

    const body = tap.refundRequests[tap.refundRequests.length - 1];
    expect(body.charge_id).toBe(purchase.payment!.gateway_payment_id);
    expect(body.reference.merchant).toEqual(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(body.reference.idempotent).toBe(`refund:${body.reference.merchant}`);
    expect(body.reference.idempotent).not.toContain(purchase.payment!.id);
  });

  it('a partial refund revokes proportionally and the purchase stays completed', async () => {
    const owner = await createSubscribedOwnerFixture(
      e2e,
      'tap-refund-partial',
      { max_branches: 5 },
    );
    // quantity 4 @ 50.00 = 200.00; delta_units = 4.
    const purchase = await createAndPay(owner.token, 4);
    expect(await capacityFor(owner.tenantId)).toBe(4);

    // Refund 50.00 of 200.00 (25%) ⇒ targetRevoked = floor(4 × 5000 / 20000) = 1.
    await refund(owner.token, purchase.payment!.id, 50).expect(201);
    await settle();

    expect(await capacityFor(owner.tenantId)).toBe(3);
    expect((await purchaseOf(purchase.id)).status).toBe('completed');
    expect((await paymentOf(purchase.payment!.id)).status).toBe(
      PaymentStatus.PARTIALLY_REFUNDED,
    );
  });

  it('repeated partial refunds converge — each NEW delta is revoked, never the whole target again', async () => {
    const owner = await createSubscribedOwnerFixture(
      e2e,
      'tap-refund-repeated',
      { max_branches: 5 },
    );
    // quantity 10 @ 50.00 = 500.00; delta_units = 10.
    const purchase = await createAndPay(owner.token, 10);
    expect(await capacityFor(owner.tenantId)).toBe(10);

    await refund(owner.token, purchase.payment!.id, 200).expect(201); // 40% ⇒ target 4
    await settle();
    expect(await capacityFor(owner.tenantId)).toBe(6);

    await refund(owner.token, purchase.payment!.id, 300).expect(201); // 100% cumulative ⇒ target 10
    await settle();
    expect(await capacityFor(owner.tenantId)).toBe(0);

    const revokes = await e2e.dataSource.query(
      `SELECT amount_units FROM tenant_entitlement_ledger
        WHERE "sourcePurchaseId" = $1 AND direction = 'revoke' ORDER BY created_at`,
      [purchase.id],
    );
    expect(
      revokes.map((r: { amount_units: string }) => Number(r.amount_units)),
    ).toEqual([4, 6]);
    expect((await purchaseOf(purchase.id)).status).toBe('refunded');
  });

  it('an idempotent refund replay does not double-revoke', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-refund-idem', {
      max_branches: 5,
    });
    const purchase = await createAndPay(owner.token, 2);
    const idempotencyKey = randomUUID();

    const send = () =>
      request(e2e.app.getHttpServer())
        .post(`${API}/refunds`)
        .set(...authHeader(owner.token))
        .send({ paymentId: purchase.payment!.id, idempotencyKey });
    await send().expect(201);
    await send().expect(201); // replay returns the same refund
    await settle();

    expect(await capacityFor(owner.tenantId)).toBe(0);
    expect(
      tap.refundRequests.filter(
        (r) => r.charge_id === purchase.payment!.gateway_payment_id,
      ),
    ).toHaveLength(1);
    const revokes = await e2e.dataSource.query(
      `SELECT id FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'revoke'`,
      [purchase.id],
    );
    expect(revokes.length).toBe(1);
  });

  // The CURRENT, deliberately-safe behaviour for an asynchronous Tap refund
  // (Phase 5 will make it first-class). Pinned here so nobody enables Tap
  // refunds believing they work end to end.
  it('an ASYNCHRONOUS (PENDING) Tap refund revokes NOTHING and does not mark the payment refunded', async () => {
    const owner = await createSubscribedOwnerFixture(
      e2e,
      'tap-refund-pending',
      { max_branches: 5 },
    );
    const purchase = await createAndPay(owner.token, 2);
    tap.refundStatus = 'PENDING';

    const res = await refund(owner.token, purchase.payment!.id);
    await settle();

    expect(res.status).toBeGreaterThanOrEqual(400); // refused, not silently "done"
    expect(await capacityFor(owner.tenantId)).toBe(2); // nothing revoked
    expect((await purchaseOf(purchase.id)).status).toBe('completed');
    expect((await paymentOf(purchase.payment!.id)).status).toBe(
      PaymentStatus.PAID,
    );
  });
});
