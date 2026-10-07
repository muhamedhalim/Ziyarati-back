/**
 * Pricing Catalog plan §24 — "addon-catalog-mutation.e2e-spec.ts — price
 * change and deactivation mid-payment leave the purchase intact."
 *
 * Real end-to-end version of the snapshot invariant already unit-proven in
 * `resource-purchase.snapshot.spec.ts`: once `resource_purchases` is
 * inserted, nothing downstream re-reads `resource_price_catalog` — proven
 * here via a REAL admin price mutation between purchase creation and
 * webhook confirmation, against real Postgres.
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
async function payWebhook(e2e: E2eApp, gatewayPaymentId: string): Promise<void> {
  await tap.deliver(e2e.app, tap.capture(gatewayPaymentId)).expect(200);
  await settle();
}

describe('Add-on price snapshot invariant — real Postgres, live catalog mutation mid-flight (plan §17/§24)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    await activateCatalogItem(e2e, 'branches', '5000');
  }, 60_000);

  afterAll(async () => {
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  it('a price change AND a deactivation after create() do not alter the already-snapshotted purchase or its charge', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'catalog-mutation', { max_branches: 5 });

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
    expect(purchase.unit_price_minor).toBe('5000');
    expect(purchase.total_minor).toBe('10000'); // 5000 × 2

    // The admin changes the price AND deactivates the item — a real write,
    // via the real repository, exactly as an admin's PATCH/active endpoint
    // would leave the row — while the purchase is still `payment_processing`.
    const catalog = e2e.dataSource.getRepository(ResourcePriceCatalog);
    const item = await catalog.findOneOrFail({ where: { item_key: 'branches' } });
    item.unit_price_minor = '999999';
    item.is_active = false;
    await catalog.save(item);

    // Confirm payment now — the listener must use the SNAPSHOT, not the
    // just-mutated catalog row.
    await payWebhook(e2e, purchase.payment!.gateway_payment_id!);

    const settled = await purchases.findOneOrFail({ where: { id: purchase.id } });
    expect(settled.status).toBe('completed');
    expect(settled.unit_price_minor).toBe('5000'); // unchanged
    expect(settled.total_minor).toBe('10000'); // unchanged
    expect(settled.delta_units).toBe('2'); // unchanged

    // The entitlement ledger grant used the SNAPSHOT's delta_units (2), not
    // whatever the mutated (and now deactivated) catalog row implies.
    const capacity = await e2e.dataSource.query(
      `SELECT GREATEST(SUM(CASE direction WHEN 'grant' THEN amount_units ELSE -amount_units END), 0) AS capacity
         FROM tenant_entitlement_ledger WHERE "tenantId" = $1 AND metric = 'branches'`,
      [owner.tenantId],
    );
    expect(Number(capacity[0].capacity)).toBe(2);

    // And the deactivated item genuinely can't be bought again by a NEW purchase.
    const blockedPreview = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases/preview`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'branches', quantity: 1 });
    expect(blockedPreview.status).toBe(404);
  });
});
