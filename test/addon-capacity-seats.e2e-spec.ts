/**
 * Pricing Catalog plan §24 — "addon-capacity-seats.e2e-spec.ts — the same
 * [as branches] for `employees`, through `assertUserSeatWithinLimit`."
 *
 * `employees` maps to `max_users`; the owner's own account already counts
 * as 1 seat, so `max_users: 2` allows exactly one staff hire before the cap.
 */
import './utils/tap-e2e-env.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { createE2eApp, authHeader, type E2eApp } from './utils/whatsapp-e2e-app';
import { TapSandbox, settle } from './utils/tap-e2e';
import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
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

const tap = new TapSandbox();

/** Confirms the payment the way Tap does: a signed webhook for the captured charge. */
async function postWebhook(e2e: E2eApp, gatewayPaymentId: string): Promise<void> {
  await tap.deliver(e2e.app, tap.capture(gatewayPaymentId)).expect(200);
  await settle();
}

// Email uniqueness is enforced globally (not merely per-clinic) at the DB
// level, and this e2e database persists across runs — a literal, repeated
// address collides (409) with a previous run's leftover row. randomUUID()
// keeps every run's staff emails unique regardless of retries.
function newStaffPayload(suffix: string) {
  const unique = randomUUID().slice(0, 8);
  return {
    email: `e2e-seat-${suffix}-${unique}@example.test`,
    fullName: `E2E Seat ${suffix}`,
    title: 'Staff Member',
  };
}

describe('Add-on capacity purchase — employee seats (plan §24) — real Postgres', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    await activateCatalogItem(e2e, 'employees', '3000');
  }, 60_000);

  // No per-tenant teardown — see addon-capacity-branches.e2e-spec.ts's note:
  // a tenant with a completed purchase (a real `payments` row) can never be
  // hard-deleted again by design.
  afterAll(async () => {
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  it('purchasing +1 seat raises the enforced max_users limit past the plan cap', async () => {
    // The owner's own account already counts as 1 seat.
    const owner = await createSubscribedOwnerFixture(e2e, 'seat-addon', { max_users: 2 });

    const first = await request(e2e.app.getHttpServer())
      .post(`${API}/staff/from-new-user`)
      .set(...authHeader(owner.token))
      .send(newStaffPayload('a'));
    expect(first.status).toBe(201);

    const overLimit = await request(e2e.app.getHttpServer())
      .post(`${API}/staff/from-new-user`)
      .set(...authHeader(owner.token))
      .send(newStaffPayload('overflow'));
    expect(overLimit.status).toBe(422);

    const purchaseRes = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'employees', quantity: 1, idempotencyKey: randomUUID() });
    expect(purchaseRes.status).toBe(201);

    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    const purchase = await purchases.findOneOrFail({
      where: { id: purchaseRes.body.purchase.id },
      relations: { payment: true },
    });

    await postWebhook(e2e, purchase.payment!.gateway_payment_id!);

    const settled = await purchases.findOneOrFail({ where: { id: purchase.id } });
    expect(settled.status).toBe('completed');

    const nowFits = await request(e2e.app.getHttpServer())
      .post(`${API}/staff/from-new-user`)
      .set(...authHeader(owner.token))
      .send(newStaffPayload('b'));
    expect(nowFits.status).toBe(201);

    const stillOver = await request(e2e.app.getHttpServer())
      .post(`${API}/staff/from-new-user`)
      .set(...authHeader(owner.token))
      .send(newStaffPayload('overflow2'));
    expect(stillOver.status).toBe(422);
  });
});
