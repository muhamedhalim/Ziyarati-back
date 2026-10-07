/**
 * Pricing Catalog plan §24 — "addon-capacity-branches.e2e-spec.ts — at
 * max_branches, creation 422s; buy +1; webhook; creation now succeeds. The
 * proof that G2 is closed."
 *
 * Drives the FULL real path: real branch-creation HTTP calls hit the plan
 * limit, a real `POST /resource-purchases` starts payment, a real Tap
 * webhook confirms it, and the SAME branch-creation endpoint is called again
 * to prove the purchased capacity actually raised the enforced limit — not
 * just that a ledger row exists.
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

describe('Add-on capacity purchase — branches (plan §24, G2 closure) — real Postgres', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    await activateCatalogItem(e2e, 'branches', '5000');
  }, 60_000);

  // NOTE: no per-tenant teardown, mirroring `refund-concurrency.e2e-spec.ts`'s
  // documented reasoning: `transactions` is append-only by DB trigger, and
  // `payments`/`tenants` are FK-referenced by it with no cascade, so a tenant
  // that ever completes a purchase (which creates a real `payments` row) can
  // never be hard-deleted again — real production behavior, not a test
  // artifact. Every fixture below gets a fresh randomUUID-suffixed tenant, so
  // no cross-test cleanup is required for isolation.
  afterAll(async () => {
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  it('purchasing +1 branch raises the enforced limit past the plan cap', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'branch-addon', { max_branches: 2 });

    // 1. Fill the plan's own cap.
    for (let i = 0; i < 2; i++) {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/branches`)
        .set(...authHeader(owner.token))
        .send({ name: `E2E Branch ${i}` });
      expect(res.status).toBe(201);
    }

    // 2. A 3rd is refused — the plan cap, unmodified.
    const overLimit = await request(e2e.app.getHttpServer())
      .post(`${API}/branches`)
      .set(...authHeader(owner.token))
      .send({ name: 'E2E Branch overflow' });
    expect(overLimit.status).toBe(422);

    // 3. Buy +1 branch — no price in the request body, server computes it.
    const purchaseRes = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'branches', quantity: 1, idempotencyKey: randomUUID() });
    expect(purchaseRes.status).toBe(201);
    expect(purchaseRes.body.purchase.status).toBe('payment_processing');

    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    const purchase = await purchases.findOneOrFail({
      where: { id: purchaseRes.body.purchase.id },
      relations: { payment: true },
    });
    expect(purchase.payment).toBeDefined();

    // 4. Confirm payment via a signed Tap webhook.
    await postWebhook(e2e, purchase.payment!.gateway_payment_id!);

    const settled = await purchases.findOneOrFail({ where: { id: purchase.id } });
    expect(settled.status).toBe('completed');

    // 5. THE PROOF: the exact same branch-creation endpoint now admits one more.
    const nowFits = await request(e2e.app.getHttpServer())
      .post(`${API}/branches`)
      .set(...authHeader(owner.token))
      .send({ name: 'E2E Branch after purchase' });
    expect(nowFits.status).toBe(201);

    // 6. And a 4th is still refused — the raise was exactly +1, not unlimited.
    const stillOver = await request(e2e.app.getHttpServer())
      .post(`${API}/branches`)
      .set(...authHeader(owner.token))
      .send({ name: 'E2E Branch overflow again' });
    expect(stillOver.status).toBe(422);
  });
});
