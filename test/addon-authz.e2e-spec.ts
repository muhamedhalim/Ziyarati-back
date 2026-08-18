/**
 * Pricing Catalog plan §24 — "addon-authz.e2e-spec.ts — cross-tenant
 * purchase/read → 404; non-super-admin catalog write → 403."
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

describe('Add-on purchase & catalog authorization boundaries (plan §21/§24) — real Postgres', () => {
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

  it("a purchase belonging to tenant A is invisible (404) to tenant B's owner", async () => {
    const ownerA = await createSubscribedOwnerFixture(e2e, 'authz-tenant-a', { max_branches: 5 });
    const ownerB = await createSubscribedOwnerFixture(e2e, 'authz-tenant-b', { max_branches: 5 });

    const purchaseRes = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(ownerA.token))
      .send({ itemKey: 'branches', quantity: 1, idempotencyKey: randomUUID() });
    expect(purchaseRes.status).toBe(201);
    const purchaseId = purchaseRes.body.purchase.id;

    // Owner A can read their own purchase.
    const ownRead = await request(e2e.app.getHttpServer())
      .get(`${API}/resource-purchases/${purchaseId}`)
      .set(...authHeader(ownerA.token));
    expect(ownRead.status).toBe(200);

    // Owner B, a DIFFERENT tenant, gets 404 — not 403, not a redacted 200.
    const crossTenantRead = await request(e2e.app.getHttpServer())
      .get(`${API}/resource-purchases/${purchaseId}`)
      .set(...authHeader(ownerB.token));
    expect(crossTenantRead.status).toBe(404);

    // Owner B's own purchase list never includes tenant A's row.
    const listB = await request(e2e.app.getHttpServer())
      .get(`${API}/resource-purchases`)
      .set(...authHeader(ownerB.token));
    expect(listB.status).toBe(200);
    expect(listB.body.data.find((p: { id: string }) => p.id === purchaseId)).toBeUndefined();
  });

  it('a non-super-admin owner cannot write to the platform pricing catalog (403)', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'authz-non-admin', { max_branches: 5 });

    const readCatalog = await request(e2e.app.getHttpServer())
      .get(`${API}/platform/resource-catalog`)
      .set(...authHeader(owner.token));
    expect(readCatalog.status).toBe(403);

    const patchPrice = await request(e2e.app.getHttpServer())
      .patch(`${API}/platform/resource-catalog/branches`)
      .set(...authHeader(owner.token))
      .send({ unitPriceMinor: 1 });
    expect(patchPrice.status).toBe(403);

    const activate = await request(e2e.app.getHttpServer())
      .post(`${API}/platform/resource-catalog/branches/active`)
      .set(...authHeader(owner.token))
      .send({ isActive: true });
    expect(activate.status).toBe(403);

    // The owner-facing, tenant-scoped catalog read remains unaffected —
    // this 403 is role-based (super-admin-only), not a general lockout.
    const ownerCatalogRead = await request(e2e.app.getHttpServer())
      .get(`${API}/resource-catalog`)
      .set(...authHeader(owner.token));
    expect(ownerCatalogRead.status).toBe(200);
  });

  it('an unauthenticated caller is refused on both surfaces (401)', async () => {
    const noAuthPurchase = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .send({ itemKey: 'branches', quantity: 1, idempotencyKey: randomUUID() });
    expect(noAuthPurchase.status).toBe(401);

    const noAuthCatalogAdmin = await request(e2e.app.getHttpServer())
      .get(`${API}/platform/resource-catalog`);
    expect(noAuthCatalogAdmin.status).toBe(401);
  });
});
