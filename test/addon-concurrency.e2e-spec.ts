/**
 * Pricing Catalog plan §24 — "addon-concurrency.e2e-spec.ts — concurrent
 * purchases with the SAME key ⇒ one purchase, one payment, one ledger row;
 * with DIFFERENT keys ⇒ two of each."
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

describe('Add-on purchase idempotency under concurrency (plan §13/§24) — real Postgres', () => {
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

  it('concurrent requests with the SAME idempotency key produce exactly one purchase and one payment', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'concurrency-same', {
      max_branches: 5,
    });
    const sharedKey = randomUUID();

    const [r1, r2, r3] = await Promise.all([
      request(e2e.app.getHttpServer())
        .post(`${API}/resource-purchases`)
        .set(...authHeader(owner.token))
        .send({ itemKey: 'branches', quantity: 1, idempotencyKey: sharedKey }),
      request(e2e.app.getHttpServer())
        .post(`${API}/resource-purchases`)
        .set(...authHeader(owner.token))
        .send({ itemKey: 'branches', quantity: 1, idempotencyKey: sharedKey }),
      request(e2e.app.getHttpServer())
        .post(`${API}/resource-purchases`)
        .set(...authHeader(owner.token))
        .send({ itemKey: 'branches', quantity: 1, idempotencyKey: sharedKey }),
    ]);

    for (const r of [r1, r2, r3]) expect(r.status).toBe(201);
    const purchaseIds = new Set([r1.body.purchase.id, r2.body.purchase.id, r3.body.purchase.id]);
    expect(purchaseIds.size).toBe(1); // all three resolved to the SAME purchase row

    const rows = await e2e.dataSource.query(
      `SELECT id FROM resource_purchases WHERE "tenantId" = $1 AND idempotency_key = $2`,
      [owner.tenantId, sharedKey],
    );
    expect(rows.length).toBe(1);

    const paymentIds = await e2e.dataSource.query(
      `SELECT DISTINCT "paymentId" FROM resource_purchases WHERE id = $1`,
      [[...purchaseIds][0]],
    );
    expect(paymentIds.length).toBe(1);
    expect(paymentIds[0].paymentId).not.toBeNull();
  });

  it('DIFFERENT idempotency keys on the same item+quantity create two separate purchases', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'concurrency-diff', {
      max_branches: 5,
    });

    const [r1, r2] = await Promise.all([
      request(e2e.app.getHttpServer())
        .post(`${API}/resource-purchases`)
        .set(...authHeader(owner.token))
        .send({ itemKey: 'branches', quantity: 1, idempotencyKey: randomUUID() }),
      request(e2e.app.getHttpServer())
        .post(`${API}/resource-purchases`)
        .set(...authHeader(owner.token))
        .send({ itemKey: 'branches', quantity: 1, idempotencyKey: randomUUID() }),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.purchase.id).not.toBe(r2.body.purchase.id);

    const rows = await e2e.dataSource.query(
      `SELECT id FROM resource_purchases WHERE "tenantId" = $1`,
      [owner.tenantId],
    );
    expect(rows.length).toBe(2);
  });
});
