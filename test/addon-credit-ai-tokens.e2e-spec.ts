/**
 * Pricing Catalog plan §24 — "addon-credit-ai-tokens.e2e-spec.ts — exhaust
 * plan allowance; a turn 422s [here: incrementIfWithinLimit refuses]; buy
 * credits; the turn succeeds; the balance drops by the settled tokens; the
 * balance survives a period rollover and a plan change."
 *
 * Exercises the credit-spillover mechanism via the real, injected
 * `UsageService`/`TenantMetricCreditsService` against real Postgres (real
 * guarded UPDATEs, real ledger, real credits table) — the data-layer
 * correctness this phase is actually verifying. The full AI-chat HTTP
 * surface (OpenAI-backed) is covered by its own existing suite; the NEW
 * mechanism here is the credit ledger, not the chat pipeline on top of it.
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
import { SubscriptionPlan } from '../src/entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../src/entities/SaaS-Core/Subscription';
import { BillingCycle } from '../src/entities/enums';

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

describe('Add-on credit purchase — AI tokens (plan §9/§24) — real Postgres', () => {
  let e2e: E2eApp;
  let usage: UsageService;
  let credits: TenantMetricCreditsService;

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    await activateCatalogItem(e2e, 'AI_TOKENS', '2000'); // priced per 1,000 tokens
    usage = e2e.moduleRef.get(UsageService, { strict: false });
    credits = e2e.moduleRef.get(TenantMetricCreditsService, { strict: false });
  }, 60_000);

  afterAll(async () => {
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  it('a purchased credit balance funds the next turn once the plan allowance is exhausted, survives a settle, a period rollover, and a plan change', async () => {
    const owner = await createSubscribedOwnerFixture(e2e, 'ai-credit', {
      max_ai_tokens: '2000',
    });
    await seedUsage(e2e, owner.tenantId, owner.subscriptionId, 'ai_tokens_used', 2000);

    // 1. Plan allowance exhausted — admission refused, no credit yet.
    const refused = await usage.incrementIfWithinLimit(owner.tenantId, 'AI_TOKENS' as never, 1);
    expect(refused.applied).toBe(false);
    expect(refused.fundedBy).toBe('none');

    // 2. Buy AI-token credits — quantity 1 = 1,000 tokens (the catalog's unitSize).
    const purchaseRes = await request(e2e.app.getHttpServer())
      .post(`${API}/resource-purchases`)
      .set(...authHeader(owner.token))
      .send({ itemKey: 'AI_TOKENS', quantity: 1, idempotencyKey: randomUUID() });
    expect(purchaseRes.status).toBe(201);

    const purchases = e2e.dataSource.getRepository(ResourcePurchase);
    const purchase = await purchases.findOneOrFail({
      where: { id: purchaseRes.body.purchase.id },
      relations: { payment: true },
    });
    expect(purchase.delta_units).toBe('1000');

    await postWebhook(e2e, purchase.payment!.gateway_payment_id!);

    const settledPurchase = await purchases.findOneOrFail({ where: { id: purchase.id } });
    expect(settledPurchase.status).toBe('completed');

    let balance = await credits.balanceMap(owner.tenantId);
    expect(balance.get('AI_TOKENS')?.balanceUnits).toBe(1000);

    // 3. The SAME turn that was refused now admits, funded by credit — this
    // reserves 1 unit via tryDebit at admission (balance: 1000 → 999).
    const admitted = await usage.incrementIfWithinLimit(owner.tenantId, 'AI_TOKENS' as never, 1);
    expect(admitted.applied).toBe(true);
    expect(admitted.fundedBy).toBe('credit');

    // 4. Settlement debits the REMAINING real cost beyond the 1 already
    // reserved at admission (plan §9's settlement asymmetry: the turn's
    // true token cost is `totalTokens - 1`, settled here as 400) —
    // total debited = 1 (admission) + 400 (settlement) = 401.
    const settleResult = await credits.settle(owner.tenantId, 'AI_TOKENS' as never, 400);
    expect(settleResult.debitedUnits).toBe(400);
    expect(settleResult.overshootUnits).toBe(0);

    balance = await credits.balanceMap(owner.tenantId);
    expect(balance.get('AI_TOKENS')?.balanceUnits).toBe(599); // 1000 - 1 - 400

    // 5. Survives a period rollover — the credits table has no period column
    // at all, so a DIFFERENT periodMonth reads the identical balance.
    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const nextPeriod = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}`;
    const breakdownNextPeriod = await usage.getBreakdown(owner.tenantId, nextPeriod);
    expect(breakdownNextPeriod.metrics.aiTokens.creditBalance).toBe(599);

    // 6. Survives a plan change — swap the subscription onto a brand-new
    // plan; the credit balance is tenant-keyed, not plan-keyed.
    const plans = e2e.dataSource.getRepository(SubscriptionPlan);
    const subscriptions = e2e.dataSource.getRepository(Subscription);
    const newPlan = await plans.save(
      plans.create({
        name: `E2E New Plan ${owner.tenantId.slice(0, 8)}`,
        price: '49.00',
        billing_cycle: BillingCycle.MONTHLY,
        is_active: true,
        is_custom: false,
        max_ai_tokens: '500',
      }),
    );
    await subscriptions.update({ id: owner.subscriptionId }, { plan: { id: newPlan.id } as SubscriptionPlan });

    balance = await credits.balanceMap(owner.tenantId);
    expect(balance.get('AI_TOKENS')?.balanceUnits).toBe(599);

    const breakdownAfterPlanChange = await usage.getBreakdown(owner.tenantId);
    expect(breakdownAfterPlanChange.metrics.aiTokens.creditBalance).toBe(599);
    expect(breakdownAfterPlanChange.metrics.aiTokens.limit).toBe(1099); // 500 (new plan) + 599 (credit)
  });
});
