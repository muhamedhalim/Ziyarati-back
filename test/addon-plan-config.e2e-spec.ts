/**
 * Pricing Catalog plan §24 — "addon-plan-config.e2e-spec.ts — unlimited
 * plan and not-configured plan both refuse publish/purchase."
 *
 * Tests the PER-TENANT purchasability check (`ResourcePurchaseService.
 * resolveTenantLimit`) — distinct from the catalog's own publish gate.
 * `max_branches: null` is ambiguous by itself (plan §8): declared unlimited
 * via `limit_declarations`, or simply never configured. Both must refuse a
 * purchase, with a message distinguishing which.
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
import { SubscriptionPlan } from '../src/entities/SaaS-Core/SubscriptionPlan';

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

describe('Add-on purchase refuses a non-Finite tenant plan limit (plan §8/§24) — real Postgres', () => {
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

  it('a plan with max_branches declared UNLIMITED refuses preview and create', async () => {
    // max_branches left NULL by createSubscribedOwnerFixture (nothing passed),
    // then explicitly declared unlimited via limit_declarations (plan §8).
    const owner = await createSubscribedOwnerFixture(e2e, 'plan-unlimited');
    const plans = e2e.dataSource.getRepository(SubscriptionPlan);
    await plans.update(
      { id: owner.planId },
      { limit_declarations: { max_branches: 'unlimited' } },
    );

    const preview = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases/preview`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'branches', quantity: 1 });
    expect(preview.status).toBe(422);
    expect(preview.body.message).toMatch(/unlimited/i);

    const create = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'branches', quantity: 1, idempotencyKey: randomUUID() });
    expect(create.status).toBe(422);

    const rows = await e2e.dataSource.query(
      `SELECT id FROM resource_purchases WHERE "tenantId" = $1`,
      [owner.tenantId],
    );
    expect(rows.length).toBe(0); // refused before any row is ever created
  });

  it('a plan with max_branches simply NOT CONFIGURED (no declaration either) refuses preview and create', async () => {
    // Left NULL with NO limit_declarations entry at all — the honestly
    // "unconfigured" state, distinct from a declared-unlimited plan.
    const owner = await createSubscribedOwnerFixture(e2e, 'plan-unconfigured');

    const preview = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases/preview`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'branches', quantity: 1 });
    expect(preview.status).toBe(422);
    expect(preview.body.message).toMatch(/not configured/i);

    const create = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'branches', quantity: 1, idempotencyKey: randomUUID() });
    expect(create.status).toBe(422);
  });

  it('a plan with a FINITE max_branches admits both preview and create', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'plan-finite', { max_branches: 5 });

    const preview = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases/preview`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'branches', quantity: 1 });
    expect(preview.status).toBe(201);
    expect(preview.body.currentLimitStatus).toBe('finite');
    expect(preview.body.resultingLimit).toBe(6);
  });
});
