/**
 * T151 — quota-exhaustion fail-closed behavior (FR-074).
 *
 * `USAGE_METRIC.AI_TOKENS` admission control only ENGAGES when
 * `AccessControlService.isEnforced()` is true, which requires
 * `BillingModeService.isPaidMode() === true` (`access-control.service.ts:384-390`)
 * AND a real, usable `Subscription`+`SubscriptionPlan` (`:402-412`). This
 * environment runs in `PLATFORM_FREE_MODE` (HARNESS_GUIDE gotcha #1), under
 * which admission is a no-op for EVERY tenant — not just the guest discovery
 * tenant (see `w10-guest-cost-exposure.md` §1). Flipping the platform-wide
 * `billing.mode` system_setting via `BillingModeService.set()` would affect
 * every OTHER spec file's app instance sharing the same e2e Postgres row
 * (jest runs spec files in parallel workers — `test/jest-security.json` sets
 * no `runInBand`/`maxWorkers`), so this spec does NOT do that. Instead it
 * boots its own isolated Nest module (same pattern as
 * `fixtures/ai-audit-harness.ts`, duplicated locally rather than editing the
 * shared fixture) with `BillingModeService` overridden at the DI level to
 * always report PAID — this affects only THIS spec's own app instance, never
 * the shared DB setting or any other spec's app instance.
 */
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import cookieParser from 'cookie-parser';

import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { requestContext } from '../../src/common/middleware/request-context.middleware';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { registerSecurityHeaders } from '../../src/config/security-headers';
import {
  AI_COMPLETION_PROVIDERS,
  AI_EMBEDDING_PROVIDER,
} from '../../src/modules/ai/providers/ai-provider.interface';
import { ScriptedAiProvider } from './fixtures/scripted-ai-provider';
import { ScriptedEmbeddingProvider } from './fixtures/scripted-ai-embedding-provider';
import { BillingModeService } from '../../src/modules/subscription-billing/billing-mode.service';
import { BillingMode } from '../../src/modules/subscription-billing/platform-billing.constants';

import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { UsageService } from '../../src/modules/subscription-billing/usage.service';
import { USAGE_METRIC, currentPeriodMonth } from '../../src/modules/subscription-billing/usage-metric';
import { AccessControlService } from '../../src/modules/subscription-billing/access-control.service';
import { FeatureKey } from '../../src/modules/subscription-billing/feature-registry';
import { AccessSource } from '../../src/modules/subscription-billing/tenant-access-decision';
import { Subscription } from '../../src/entities/SaaS-Core/Subscription';
import { SubscriptionPlan } from '../../src/entities/SaaS-Core/SubscriptionPlan';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { FeatureFlag, FeatureFlagSource } from '../../src/entities/SaaS-Core/FeatureFlag';
import { SubscriptionStatus, BillingCycle } from '../../src/entities/enums';

const ALWAYS_PAID_BILLING_MODE = {
  get: async () => BillingMode.PAID,
  isPaidMode: async () => true,
  set: async () => ({ mode: BillingMode.PAID }),
};

describe('AI abuse — quota-exhaustion fail-closed (T151)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let provider: ScriptedAiProvider;
  let seed: AiAuditSeed;
  let planId: string;
  let subscriptionId: string;

  const AI_TOKENS_LIMIT = 100;

  beforeAll(async () => {
    provider = new ScriptedAiProvider();
    const embedding = new ScriptedEmbeddingProvider(16);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_COMPLETION_PROVIDERS)
      .useValue([provider])
      .overrideProvider(AI_EMBEDDING_PROVIDER)
      .useValue(embedding)
      .overrideProvider(BillingModeService)
      .useValue(ALWAYS_PAID_BILLING_MODE)
      .compile();

    app = moduleRef.createNestApplication();
    registerSecurityHeaders(app);
    const tenantContext = app.get(TenantContextService);
    app.use(requestContext);
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) =>
      tenantContext.run(() => {
        tenantContext.setCorrelationId(req.requestId ?? null);
        next();
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    await app.init();

    dataSource = app.get(DataSource);
    seed = await seedAiAudit(app, dataSource);

    // A real, usable subscription for tenantA — required for `isEnforced()`
    // to reach `PLAN_ENFORCED` rather than short-circuiting to DENIED (no
    // subscription at all) or the free-mode/override branches.
    const plans = dataSource.getRepository(SubscriptionPlan);
    const plan = await plans.save(
      plans.create({
        name: 'T151 probe plan',
        price: '0',
        billing_cycle: BillingCycle.MONTHLY,
        max_ai_tokens: String(AI_TOKENS_LIMIT),
      }),
    );
    planId = plan.id;

    const subscriptions = dataSource.getRepository(Subscription);
    const subscription = await subscriptions.save(
      subscriptions.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        plan: { id: plan.id } as SubscriptionPlan,
        status: SubscriptionStatus.ACTIVE,
        starts_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
        ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        auto_renew: true,
      }),
    );
    subscriptionId = subscription.id;

    // `FeatureKey.AI_ASSISTANT` defaults to `defaultEnabled: false` in the
    // registry (feature-registry.ts:215) — under PLATFORM_FREE_MODE this
    // never matters (branch 2 of `AccessControlService.decide()` admits every
    // capability before this check is reached), but this spec deliberately
    // forces PAID mode, which routes through branch 4 ("a usable subscription
    // grants the capability when the plan includes it AND it is switched on
    // for this tenant") — so an explicit, AUTHORITATIVE feature-flag grant is
    // required, exactly as a real paid-mode deployment would need one from
    // the billing-upgrade flow or a platform admin. This is fixture setup to
    // reach the code under test (quota admission), not the behavior under
    // test itself.
    const flags = dataSource.getRepository(FeatureFlag);
    await flags.save(
      flags.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        feature_key: FeatureKey.AI_ASSISTANT,
        is_enabled: true,
        source: FeatureFlagSource.PLATFORM_ADMIN,
        is_suspended: false,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await dataSource.query(`DELETE FROM feature_flags WHERE "tenantId" = $1 AND feature_key = $2`, [seed.tenantA.id, FeatureKey.AI_ASSISTANT]).catch(() => undefined);
    await dataSource.query(`DELETE FROM subscription_usage WHERE subscription_id = $1`, [subscriptionId]).catch(() => undefined);
    await dataSource.query(`DELETE FROM subscriptions WHERE id = $1`, [subscriptionId]).catch(() => undefined);
    await dataSource.query(`DELETE FROM subscription_plans WHERE id = $1`, [planId]).catch(() => undefined);
    await teardownAiAuditSeed(dataSource, seed);
    await app.close();
  }, 60_000);

  it('sanity: entitlement resolves ALLOWED via a real ACTIVE_SUBSCRIPTION now that paid mode + the feature flag are both set up', async () => {
    const access = app.get(AccessControlService);
    const decision = await access.resolve(seed.tenantA.id, FeatureKey.AI_ASSISTANT);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe(AccessSource.ACTIVE_SUBSCRIPTION);
  });

  it('sanity: with usage well under the plan limit, a turn is admitted and the provider IS invoked (proves the mechanism only blocks when actually exhausted)', async () => {
    const conversations = app.get(AiConversationService);
    const execution = app.get(AiExecutionService);
    const usage = app.get(UsageService);
    const conv = await conversations.start(seed.tenantA.id, {});

    provider.reset();
    provider.script([{ content: 'Under-limit scripted reply.', promptTokens: 5, completionTokens: 5 }]);

    const result = await execution.sendMessage(seed.tenantA.id, conv.id, { content: 'well under limit' }, 'REST');

    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(provider.callCount).toBe(1);

    const row = await dataSource.query(
      `SELECT ai_tokens_used FROM subscription_usage WHERE subscription_id = $1 AND period_month = $2`,
      [subscriptionId, currentPeriodMonth()],
    );
    expect(Number(row[0]?.ai_tokens_used ?? 0)).toBeGreaterThan(0);
    expect(Number(row[0]?.ai_tokens_used ?? 0)).toBeLessThan(AI_TOKENS_LIMIT);

    await dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    // Confirm this test's own admission call directly too.
    const probe = await usage.incrementIfWithinLimit(seed.tenantA.id, USAGE_METRIC.AI_TOKENS, 1);
    expect(probe.applied).toBe(true);
    await usage.release(seed.tenantA.id, USAGE_METRIC.AI_TOKENS, 1);
  }, 30_000);

  it('once usage is driven to the plan limit, further requests fail CLOSED with zero unmetered work (provider spy shows zero invocations)', async () => {
    // Drive usage to exactly the limit directly (simulating prior consumption
    // within the period), rather than looping turns — deterministic and fast.
    await dataSource.query(
      `INSERT INTO subscription_usage (tenant_id, subscription_id, period_month, ai_tokens_used, whatsapp_messages_used, appointments_used, campaigns_used)
       VALUES ($1, $2, $3, $4, 0, 0, 0)
       ON CONFLICT (subscription_id, period_month)
       DO UPDATE SET ai_tokens_used = EXCLUDED.ai_tokens_used`,
      [seed.tenantA.id, subscriptionId, currentPeriodMonth(), String(AI_TOKENS_LIMIT)],
    );

    const conversations = app.get(AiConversationService);
    const execution = app.get(AiExecutionService);
    const usage = app.get(UsageService);
    const conv = await conversations.start(seed.tenantA.id, {});

    // Direct admission-control probe first (isolates the mechanism itself).
    const admission = await usage.incrementIfWithinLimit(seed.tenantA.id, USAGE_METRIC.AI_TOKENS, 1);
    expect(admission.applied).toBe(false);
    expect(admission.used).toBe(AI_TOKENS_LIMIT);
    expect(admission.limit).toBe(AI_TOKENS_LIMIT);

    // End-to-end: a real turn attempt through AiExecutionService.
    provider.reset();
    provider.script([{ content: 'Should never be reached.' }]); // proves it truly never fires

    await expect(
      execution.sendMessage(seed.tenantA.id, conv.id, { content: 'exhausted quota attempt' }, 'REST'),
    ).rejects.toMatchObject({
      code: expect.stringContaining('UNPROCESSABLE'),
    });

    expect(provider.callCount).toBe(0); // zero unmetered work

    // No user message was even persisted — the admission check runs before
    // the DB write (ai-execution.service.ts:244-275).
    const messages = await dataSource.query(`SELECT COUNT(*)::int AS count FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    expect(messages[0].count).toBe(0);

    await dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);
});
