/**
 * Tap migration, Phase 2 gate — the add-on refund-reversal suite
 * (`addon-refund.e2e-spec.ts`) ported to TAP.
 *
 * Scope note. The legacy suite drives three emission paths. For Tap, Phase 2 had
 * only the real `POST /refunds` HTTP path; Phase 5 makes a Tap refund first-class
 * (a PENDING one is represented, and the signed refund webhook / the reaper
 * complete it), so the last case below now proves an ASYNCHRONOUS refund revokes
 * the add-on only WHEN it completes — never while it is merely accepted.
 * The full refund matrix over Tap lives in `refund.tap.e2e-spec.ts`.
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
import { RefundService } from '../src/modules/payments/refund.service';
import { RefundService } from '../src/modules/payments/refund.service';

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

  // FIN-001: a clinic can no longer refund platform revenue through POST /refunds
  // (guard test below). The entitlement-reversal machinery is exercised through
  // the platform-initiated service path, which is what a platform action calls.
  const refund = async (
    _token: string,
    paymentId: string,
    amount?: number,
    idempotencyKey?: string,
  ) => {
    const rows = await e2e.dataSource.query(
      `SELECT "tenantId" FROM payments WHERE id = $1`,
      [paymentId],
    );
    return e2e.app.get(RefundService).create(
      rows[0].tenantId as string,
      {
        paymentId,
        ...(amount != null ? { amount } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as never,
      undefined,
      { platformInitiated: true },
    );
  };

  it('FIN-001: a clinic owner cannot refund an add-on payment through POST /refunds', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-refund-block', {
      max_branches: 5,
    });
    const purchase = await createAndPay(owner.token, 2);
    await request(e2e.app.getHttpServer())
      .post(`${API}/refunds`)
      .set(...authHeader(owner.token))
      .send({ paymentId: purchase.payment!.id })
      .expect(403);
    expect(await capacityFor(owner.tenantId)).toBe(2);
    expect((await paymentOf(purchase.payment!.id)).status).toBe(
      PaymentStatus.PAID,
    );
  });

  it('a full refund through POST /refunds fully revokes the granted capacity', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-refund-full', {
      max_branches: 5,
    });
    const purchase = await createAndPay(owner.token, 3);
    expect(await capacityFor(owner.tenantId)).toBe(3);

    await refund(owner.token, purchase.payment!.id);
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

    await refund(owner.token, purchase.payment!.id);

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
    await refund(owner.token, purchase.payment!.id, 50);
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

    await refund(owner.token, purchase.payment!.id, 200); // 40% ⇒ target 4
    await settle();
    expect(await capacityFor(owner.tenantId)).toBe(6);

    await refund(owner.token, purchase.payment!.id, 300); // 100% cumulative ⇒ target 10
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
      refund(owner.token, purchase.payment!.id, undefined, idempotencyKey);
    await send();
    await send(); // replay returns the same refund
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

  // Phase 5: an asynchronous Tap refund is first-class. While it is only
  // ACCEPTED (PENDING) nothing is revoked and the payment is not refunded; when
  // Tap completes it (signed webhook, re-fetched) the add-on is revoked once.
  it('an ASYNCHRONOUS (PENDING) Tap refund revokes NOTHING until it completes, then revokes exactly once', async () => {
    const owner = await createSubscribedOwnerFixture(
      e2e,
      'tap-refund-pending',
      { max_branches: 5 },
    );
    const purchase = await createAndPay(owner.token, 2);
    tap.refundStatus = 'PENDING';

    const res = { body: await refund(owner.token, purchase.payment!.id) };
    await settle();

    expect(res.body.status).toBe('PENDING'); // accepted, not done
    expect(await capacityFor(owner.tenantId)).toBe(2); // nothing revoked yet
    expect((await purchaseOf(purchase.id)).status).toBe('completed');
    expect((await paymentOf(purchase.payment!.id)).status).toBe(
      PaymentStatus.PAID,
    );

    // Tap completes the refund and posts it (the app re-fetches before trusting it)
    const tapRefund = tap.lastRefund();
    tap.setRefundStatus(tapRefund.id, 'REFUNDED');
    await tap.deliverRefund(e2e.app, tapRefund).expect(200);
    await tap.deliverRefund(e2e.app, tapRefund).expect(200); // a redelivery is harmless
    await settle();

    expect(await capacityFor(owner.tenantId)).toBe(0);
    expect((await purchaseOf(purchase.id)).status).toBe('refunded');
    expect((await paymentOf(purchase.payment!.id)).status).toBe(
      PaymentStatus.REFUNDED,
    );
    const revokes = await e2e.dataSource.query(
      `SELECT id FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'revoke'`,
      [purchase.id],
    );
    expect(revokes.length).toBe(1);
  });
});
