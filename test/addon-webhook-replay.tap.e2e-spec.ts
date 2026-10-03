/**
 * Tap migration, Phase 2 gate — the add-on webhook-replay suite
 * (`addon-webhook-replay.e2e-spec.ts`, which drives the legacy Moyasar route)
 * ported to the TAP route. Same plan §24 guarantees:
 *
 *   - a redelivered success grants the capacity exactly once;
 *   - a late success after a genuine failure still grants (failure is not terminal);
 *   - a late success after a full refund is refused — and, new in Phase 2, the
 *     REFUNDED payment itself stays REFUNDED.
 *
 * Real Postgres (migrations-built `ziyarati_e2e`), real Redis, the real
 * AppModule: the purchase is created through the HTTP API, the charge goes
 * through the real `TapGatewayProvider`, and the signed webhook through the real
 * verifier, re-fetch, dedupe index and row locks. Only Tap's network is stubbed
 * (`TapApiClient` at its boundary).
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

describe('Add-on entitlement over TAP — webhook redelivery & terminal-status guard (plan §24, G14) — real Postgres', () => {
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

  afterAll(async () => {
    await settle();
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  async function createPurchase(token: string): Promise<ResourcePurchase> {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(token))
      .send({ itemKey: 'branches', quantity: 1, idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    return e2e.dataSource.getRepository(ResourcePurchase).findOneOrFail({
      where: { id: res.body.purchase.id },
      relations: { payment: true },
    });
  }

  const purchaseOf = (id: string) =>
    e2e.dataSource
      .getRepository(ResourcePurchase)
      .findOneOrFail({ where: { id } });
  const grants = (purchaseId: string) =>
    e2e.dataSource.query(
      `SELECT amount_units FROM tenant_entitlement_ledger WHERE "sourcePurchaseId" = $1 AND direction = 'grant'`,
      [purchaseId],
    );
  const capacity = async (tenantId: string) =>
    Number(
      (
        await e2e.dataSource.query(
          `SELECT GREATEST(SUM(CASE direction WHEN 'grant' THEN amount_units ELSE -amount_units END), 0) AS capacity
             FROM tenant_entitlement_ledger WHERE "tenantId" = $1 AND metric = 'branches'`,
          [tenantId],
        )
      )[0].capacity,
    );

  it('the charge is created through the real Tap adapter as PLATFORM revenue (platform merchant, hosted page, server-built return)', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-shape', {
      max_branches: 5,
    });
    const purchase = await createPurchase(owner.token);

    const body = tap.chargeRequests[tap.chargeRequests.length - 1];
    expect(purchase.payment!.gateway).toBe('tap');
    expect(purchase.payment!.gateway_payment_id).toBe(tap.lastCharge().id);
    expect(body).toMatchObject({
      amount: expect.anything(),
      currency: 'SAR',
      source: { id: 'src_all' },
      merchant: { id: 'e2e-merchant' }, // the platform's own account, never a clinic
      reference: {
        transaction: purchase.payment!.id,
        idempotent: `pay:${purchase.payment!.id}`,
      },
      metadata: { udf1: purchase.payment!.id, udf3: owner.tenantId },
    });
    expect(String(body.redirect.url)).toMatch(
      /\/app\/billing\?checkout=return$/,
    );
    // a platform charge must never carry a clinic routing leg
    expect(body.platform).toBeUndefined();
  });

  it('a redelivered success webhook grants the capacity exactly once', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-replay', {
      max_branches: 5,
    });
    const purchase = await createPurchase(owner.token);
    const charge = tap.capture(purchase.payment!.gateway_payment_id!);

    const first = await tap.deliver(e2e.app, charge).expect(200);
    const second = await tap.deliver(e2e.app, charge).expect(200); // redelivery
    const third = await tap.deliver(e2e.app, charge).expect(200); // redelivery again
    await settle();

    expect(first.body).toMatchObject({
      matched: true,
      status: 'PAID',
      deduplicated: false,
    });
    expect(second.body.deduplicated).toBe(true);
    expect(third.body.deduplicated).toBe(true);

    const rows = await grants(purchase.id);
    expect(rows.length).toBe(1); // exactly one grant, never three
    expect(Number(rows[0].amount_units)).toBe(1);
    expect((await purchaseOf(purchase.id)).status).toBe('completed');
  });

  it('a late success after a genuine failure still grants (failure is not terminal)', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-late-success', {
      max_branches: 5,
    });
    const purchase = await createPurchase(owner.token);
    const id = purchase.payment!.gateway_payment_id!;

    await tap.deliver(e2e.app, tap.decline(id)).expect(200);
    await settle();
    expect((await purchaseOf(purchase.id)).status).toBe('payment_failed');
    expect(
      (
        await e2e.dataSource
          .getRepository(Payment)
          .findOneByOrFail({ id: purchase.payment!.id })
      ).status,
    ).toBe(PaymentStatus.FAILED);

    // Tap reports the capture anyway (a late, out-of-order delivery).
    await tap.deliver(e2e.app, tap.capture(id)).expect(200);
    await settle();

    expect((await purchaseOf(purchase.id)).status).toBe('completed');
    expect((await grants(purchase.id)).length).toBe(1);
    expect(
      (
        await e2e.dataSource
          .getRepository(Payment)
          .findOneByOrFail({ id: purchase.payment!.id })
      ).status,
    ).toBe(PaymentStatus.PAID);
  });

  it('a late success after a full refund is refused — the purchase stays refunded AND the payment stays REFUNDED', async () => {
    const owner = await createSubscribedOwnerFixture(
      e2e,
      'tap-late-after-refund',
      { max_branches: 5 },
    );
    const purchase = await createPurchase(owner.token);
    const charge = tap.capture(purchase.payment!.gateway_payment_id!);

    await tap.deliver(e2e.app, charge).expect(200);
    await settle();
    expect((await purchaseOf(purchase.id)).status).toBe('completed');
    expect(await capacity(owner.tenantId)).toBe(1);

    // Full refund through the real refund path (Tap answers REFUNDED synchronously).
    await request(e2e.app.getHttpServer())
      .post(`${API}/refunds`)
      .set(...authHeader(owner.token))
      .send({ paymentId: purchase.payment!.id })
      .expect(201);
    await settle();
    expect((await purchaseOf(purchase.id)).status).toBe('refunded');
    expect(await capacity(owner.tenantId)).toBe(0);

    // Tap redelivers the CAPTURED event.
    const late = await tap.deliver(e2e.app, charge).expect(200);
    await settle();

    expect(late.body.deduplicated).toBe(true);
    expect((await grants(purchase.id)).length).toBe(1); // still just the original grant
    expect(await capacity(owner.tenantId)).toBe(0); // NOT re-granted
    expect((await purchaseOf(purchase.id)).status).toBe('refunded');
    expect(
      (
        await e2e.dataSource
          .getRepository(Payment)
          .findOneByOrFail({ id: purchase.payment!.id })
      ).status,
    ).toBe(PaymentStatus.REFUNDED);
  });

  it('a wrong-amount capture is NEVER booked (anti-tampering) — the purchase is not granted', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'tap-amount', {
      max_branches: 5,
    });
    const purchase = await createPurchase(owner.token);
    const charge = tap.capture(purchase.payment!.gateway_payment_id!, {
      amount: 1,
    });

    await tap.deliver(e2e.app, charge).expect(200);
    await settle();

    expect((await purchaseOf(purchase.id)).status).toBe('payment_processing');
    expect((await grants(purchase.id)).length).toBe(0);
    expect(
      (
        await e2e.dataSource
          .getRepository(Payment)
          .findOneByOrFail({ id: purchase.payment!.id })
      ).status,
    ).toBe(PaymentStatus.PENDING);
  });
});
