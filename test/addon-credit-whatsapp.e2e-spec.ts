/**
 * Pricing Catalog plan §24 — "addon-credit-whatsapp.e2e-spec.ts — the same
 * spillover through a different enforcement seam."
 *
 * Proves the credit-spillover mechanism generalizes to a second metered
 * metric (`WHATSAPP_MESSAGES`, unitSize 1 — unlike AI tokens' 1,000), not
 * just AI tokens — same `incrementIfWithinLimit` seam, a genuinely
 * different `USAGE_METRIC`/catalog item/ledger row.
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
  seedUsage,
} from './utils/subscription-e2e-fixtures';
import { ResourcePriceCatalog } from '../src/entities/ResourcePricing/ResourcePriceCatalog';
import { ResourcePurchase } from '../src/entities/ResourcePricing/ResourcePurchase';
import { UsageService } from '../src/modules/subscription-billing/usage.service';
import { TenantMetricCreditsService } from '../src/modules/subscription-billing/tenant-metric-credits.service';

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

describe('Add-on credit purchase — WhatsApp messages (plan §24) — real Postgres', () => {
  let e2e: E2eApp;
  let usage: UsageService;
  let credits: TenantMetricCreditsService;

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    await activateCatalogItem(e2e, 'WHATSAPP_MESSAGES', '50');
    usage = e2e.moduleRef.get(UsageService, { strict: false });
    credits = e2e.moduleRef.get(TenantMetricCreditsService, { strict: false });
  }, 60_000);

  afterAll(async () => {
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  it('a purchased WhatsApp-message credit balance funds sends once the plan allowance is exhausted', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'wa-credit', {
      max_whatsapp_messages: 10,
    });
    await seedUsage(e2e, owner.tenantId, owner.subscriptionId, 'whatsapp_messages_used', 10);

    const refused = await usage.incrementIfWithinLimit(
      owner.tenantId,
      'WHATSAPP_MESSAGES' as never,
      1,
    );
    expect(refused.applied).toBe(false);
    expect(refused.fundedBy).toBe('none');

    const purchaseRes = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'WHATSAPP_MESSAGES', quantity: 20, idempotencyKey: randomUUID() });
    expect(purchaseRes.status).toBe(201);

    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    const purchase = await purchases.findOneOrFail({
      where: { id: purchaseRes.body.purchase.id },
      relations: { payment: true },
    });
    expect(purchase.delta_units).toBe('20'); // unitSize 1 for WhatsApp — quantity == delta

    await postWebhook(e2e, purchase.payment!.gateway_payment_id!);
    expect((await purchases.findOneOrFail({ where: { id: purchase.id } })).status).toBe('completed');

    const balance = await credits.balanceMap(owner.tenantId);
    expect(balance.get('WHATSAPP_MESSAGES')?.balanceUnits).toBe(20);

    const admitted = await usage.incrementIfWithinLimit(
      owner.tenantId,
      'WHATSAPP_MESSAGES' as never,
      1,
    );
    expect(admitted.applied).toBe(true);
    expect(admitted.fundedBy).toBe('credit');

    const balanceAfter = await credits.balanceMap(owner.tenantId);
    expect(balanceAfter.get('WHATSAPP_MESSAGES')?.balanceUnits).toBe(19);
  });
});
