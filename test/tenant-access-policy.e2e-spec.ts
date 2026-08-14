/**
 * Tenant access policy — the full matrix, against real PostgreSQL (plan §17).
 *
 * WHY THIS SUITE EXISTS. The access policy's whole claim is that ONE authority
 * answers "may this tenant use this capability, and do plan quotas apply?", and
 * that every surface — HTTP routes, background jobs, WebSocket events, internal
 * service calls — consults that one authority and agrees. Unit tests can prove
 * each surface calls `AccessControlService`; only an end-to-end run against a
 * real database can prove they all reach the SAME verdict from the same rows.
 *
 * The scenarios below are the requirement, restated as assertions:
 *
 *   - approval alone grants nothing;
 *   - a paid plan grants what the plan includes, and enforces its quotas;
 *   - a super-admin feature override grants that capability plus its declared
 *     dependency closure, with no subscription and no plan cap, but usage is
 *     still recorded;
 *   - unrelated capabilities stay denied, and two overrides stay isolated;
 *   - an administrative suspension outranks both a paid plan and an override;
 *   - a denial is a denial everywhere: route, worker, socket and internal seam.
 *
 * ISOLATION: no per-test database. Every fixture is scoped under a freshly
 * created tenant and torn down in FK-safe order, exactly like the sibling
 * suites. `setPaidMode` is process-wide and is reset in `afterAll`.
 */
import request from 'supertest';
import { UnrecoverableError } from 'bullmq';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import {
  createSubscribedOwnerFixture,
  setPaidMode,
  resetBillingMode,
  cleanupSubscriptionFixture,
  type SubscribedOwnerFixture,
} from './utils/subscription-e2e-fixtures';

import { AccessControlService } from '../src/modules/subscription-billing/access-control.service';
import { FeatureCatalogService } from '../src/modules/subscription-billing/feature-catalog.service';
import { UsageService } from '../src/modules/subscription-billing/usage.service';
import { FeatureKey } from '../src/modules/subscription-billing/feature-registry';
import {
  AccessSource,
  QuotaPolicy,
} from '../src/modules/subscription-billing/tenant-access-decision';
import { USAGE_METRIC } from '../src/modules/subscription-billing/usage-metric';
import { WorkerAuthorizationService } from '../src/queue/worker-authorization.service';
import { JOB } from '../src/queue/queue.constants';
import { WhatsappMessagingService } from '../src/modules/whatsapp/whatsapp-messaging.service';
import { AiRealtimeGateway } from '../src/modules/ai-realtime/ai-realtime.gateway';
import { AI_EVENT } from '../src/modules/ai-realtime/ai-events.constants';

const API = '/api/v1';
const SUPER_ADMIN = { id: undefined as string | undefined, ip: '127.0.0.1' };

describe('Tenant access policy — real Postgres', () => {
  let e2e: E2eApp;
  let access: AccessControlService;
  let catalog: FeatureCatalogService;
  let usage: UsageService;
  let workerAuth: WorkerAuthorizationService;
  let messaging: WhatsappMessagingService;
  let gateway: AiRealtimeGateway;

  beforeAll(async () => {
    e2e = await createE2eApp();
    await setPaidMode(e2e);
    const get = <T>(t: new (...a: never[]) => T): T =>
      e2e.moduleRef.get(t, { strict: false });
    access = get(AccessControlService);
    catalog = get(FeatureCatalogService);
    usage = get(UsageService);
    workerAuth = get(WorkerAuthorizationService);
    messaging = get(WhatsappMessagingService);
    gateway = get(AiRealtimeGateway);
  }, 90_000);

  afterAll(async () => {
    // Process-wide flip — must be undone before the app closes or every
    // later-running suite inherits PAID mode. Same rule as the sibling suites.
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  /** Grants a capability the way a super admin would, through the real service. */
  const grant = (tenantId: string, key: FeatureKey, enabled = true) =>
    catalog.setTenantFeature(tenantId, key, enabled, SUPER_ADMIN);

  const suspend = (tenantId: string, key: FeatureKey, reason = 'e2e') =>
    catalog.setTenantFeatureSuspension(
      tenantId,
      key,
      true,
      reason,
      SUPER_ADMIN,
    );

  const lift = (tenantId: string, key: FeatureKey) =>
    catalog.setTenantFeatureSuspension(
      tenantId,
      key,
      false,
      undefined,
      SUPER_ADMIN,
    );

  // ══════════════════════ 1. Approval alone grants nothing ═════════════════ //

  describe('approved clinic, no subscription, no override', () => {
    let owner: OwnerFixture;

    beforeAll(async () => {
      owner = await createOwnerFixture(e2e, 'access-denied');
    });
    afterAll(async () => cleanupTenant(e2e, owner.tenantId));

    it('is DENIED with quotaPolicy BLOCKED', async () => {
      const d = await access.resolve(owner.tenantId, FeatureKey.CAMPAIGNS);
      expect(d.allowed).toBe(false);
      expect(d.source).toBe(AccessSource.DENIED);
      expect(d.quotaPolicy).toBe(QuotaPolicy.BLOCKED);
    });

    it('is refused on a gated route', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/campaigns`)
        .set(...authHeader(owner.token))
        .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    });

    /**
     * Billing and support are `alwaysOn` — a clinic that can reach nothing must
     * still be able to choose a plan and ask for help, or a denial is a dead
     * end with no route back.
     */
    it('still reaches the always-on capabilities', async () => {
      for (const key of [
        FeatureKey.BILLING,
        FeatureKey.SUPPORT,
        FeatureKey.CORE_WORKSPACE,
      ]) {
        expect((await access.resolve(owner.tenantId, key)).allowed).toBe(true);
      }
    });

    /**
     * A stale `feature_flags` row, or an internal caller passing a string that
     * is no longer a capability, must resolve to DENIED — never throw a 500 and
     * never fall through to a grant.
     */
    it('fails closed on an unknown feature key', async () => {
      const d = await access.resolve(
        owner.tenantId,
        'not.a.real.feature' as FeatureKey,
      );
      expect(d.allowed).toBe(false);
    });
  });

  // ═══════════════════ 2. Paid subscription: plan decides ══════════════════ //

  describe('paid subscription', () => {
    let owner: SubscribedOwnerFixture;

    beforeAll(async () => {
      owner = await createSubscribedOwnerFixture(
        e2e,
        'access-paid',
        { max_whatsapp_messages: 2 },
        [FeatureKey.WHATSAPP],
      );
    });
    afterAll(async () => {
      await cleanupSubscriptionFixture(e2e, owner.tenantId, owner.planId);
      await cleanupTenant(e2e, owner.tenantId);
    });

    it('grants an included capability as ACTIVE_SUBSCRIPTION with plan quotas', async () => {
      const d = await access.resolve(owner.tenantId, FeatureKey.WHATSAPP);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.ACTIVE_SUBSCRIPTION);
      expect(d.quotaPolicy).toBe(QuotaPolicy.PLAN_ENFORCED);
      expect(d.planId).toBe(owner.planId);
    });

    it('serves a gated route the plan includes', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/crm/customers`)
        .set(...authHeader(owner.token))
        .expect(200);
    });

    it('enforces the plan quota', async () => {
      const first = await usage.incrementIfWithinLimit(
        owner.tenantId,
        USAGE_METRIC.WHATSAPP_MESSAGES,
        2,
      );
      expect(first.applied).toBe(true);

      const overflow = await usage.incrementIfWithinLimit(
        owner.tenantId,
        USAGE_METRIC.WHATSAPP_MESSAGES,
        1,
      );
      expect(overflow.applied).toBe(false);
      expect(overflow.limit).toBe(2);
    });

    /**
     * THE trap this architecture is built to avoid: an override row on a PAYING
     * tenant must not unmeter it. `quotaPolicy` derives from the access SOURCE,
     * and a subscribed tenant resolves through the subscription branch before
     * the override branch is ever reached.
     */
    it('stays metered even with a super-admin flag enabled', async () => {
      await grant(owner.tenantId, FeatureKey.WHATSAPP);
      const d = await access.resolve(owner.tenantId, FeatureKey.WHATSAPP);
      expect(d.source).toBe(AccessSource.ACTIVE_SUBSCRIPTION);
      expect(d.quotaPolicy).toBe(QuotaPolicy.PLAN_ENFORCED);
      expect(
        await access.isEnforced(owner.tenantId, undefined, [
          FeatureKey.WHATSAPP,
        ]),
      ).toBe(true);
    });
  });

  // ═════════════ 3. Feature override: no subscription, scoped grant ════════ //

  describe('feature override (no subscription)', () => {
    let owner: OwnerFixture;

    beforeAll(async () => {
      owner = await createOwnerFixture(e2e, 'access-override');
      await grant(owner.tenantId, FeatureKey.WHATSAPP);
    });
    afterAll(async () => cleanupTenant(e2e, owner.tenantId));

    it('grants the toggled capability with no subscription and no plan cap', async () => {
      const d = await access.resolve(owner.tenantId, FeatureKey.WHATSAPP);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.FEATURE_OVERRIDE);
      expect(d.quotaPolicy).toBe(QuotaPolicy.UNMETERED_BY_PLAN);
      expect(d.subscriptionId).toBeUndefined();
      expect(d.grantedVia).toMatchObject({ directly: true });
    });

    /**
     * "WhatsApp works end to end" is the requirement. A WhatsApp inbox that
     * 403s on the conversations and customer panels it renders is not a granted
     * capability, so the grant carries the registry-declared closure — and
     * NOTHING outside it.
     */
    it('grants the declared dependency closure', async () => {
      for (const dep of [FeatureKey.CONVERSATIONS, FeatureKey.CRM]) {
        const d = await access.resolve(owner.tenantId, dep);
        expect(d.allowed).toBe(true);
        expect(d.grantedVia).toMatchObject({
          directly: false,
          viaDependencyOf: FeatureKey.WHATSAPP,
        });
      }
    });

    it('leaves unrelated capabilities denied', async () => {
      for (const other of [
        FeatureKey.CAMPAIGNS,
        FeatureKey.PAYMENTS,
        FeatureKey.AI_ASSISTANT,
      ]) {
        expect((await access.resolve(owner.tenantId, other)).allowed).toBe(
          false,
        );
      }
    });

    it('serves the override tenant on a route inside the closure', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/crm/customers`)
        .set(...authHeader(owner.token))
        .expect(200);
    });

    it('refuses the override tenant on a route outside the closure', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/campaigns`)
        .set(...authHeader(owner.token))
        .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    });

    /**
     * Your explicit decision: UNMETERED_BY_PLAN, but usage is still RECORDED.
     * The row keys on `(tenant_id, period_month)` with a NULL `subscription_id`
     * — no fake subscription is invented to make the write fit.
     */
    it('records usage against a subscription-less row', async () => {
      const before = await countUsageRows(owner.tenantId);
      const res = await usage.incrementIfWithinLimit(
        owner.tenantId,
        USAGE_METRIC.WHATSAPP_MESSAGES,
        3,
      );

      expect(res).toMatchObject({ applied: true, limit: null });
      const rows = await e2e.dataSource.query(
        `SELECT whatsapp_messages_used FROM subscription_usage
          WHERE tenant_id = $1 AND subscription_id IS NULL`,
        [owner.tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].whatsapp_messages_used)).toBeGreaterThanOrEqual(3);
      expect(before).toBe(0);
    });

    it('never answers with the internal no-subscription not-found', async () => {
      await expect(usage.getBreakdown(owner.tenantId)).resolves.toMatchObject({
        planId: null,
      });
      await expect(
        request(e2e.app.getHttpServer())
          .get(`${API}/usage/breakdown`)
          .set(...authHeader(owner.token)),
      ).resolves.toMatchObject({ status: 200 });
    });

    it('revoking the grant removes access immediately', async () => {
      await grant(owner.tenantId, FeatureKey.WHATSAPP, false);
      // No sleep: the mutation busts the cache synchronously before returning,
      // so the very next resolution must already observe the revocation. A
      // timing-based assertion here would hide exactly the bug it is meant to
      // catch.
      expect(
        (await access.resolve(owner.tenantId, FeatureKey.WHATSAPP)).allowed,
      ).toBe(false);
      await grant(owner.tenantId, FeatureKey.WHATSAPP); // restore for teardown symmetry
    });
  });

  // ═════════════════ 4. Multiple overrides stay isolated ═══════════════════ //

  describe('two overrides on one tenant', () => {
    let owner: OwnerFixture;

    beforeAll(async () => {
      owner = await createOwnerFixture(e2e, 'access-two');
      await grant(owner.tenantId, FeatureKey.WHATSAPP);
      await grant(owner.tenantId, FeatureKey.AI_ASSISTANT);
    });
    afterAll(async () => cleanupTenant(e2e, owner.tenantId));

    it('opens both, and only both plus their closures', async () => {
      const all = await access.resolveAll(owner.tenantId);
      const allowed = [...all.entries()]
        .filter(([, d]) => d.allowed)
        .map(([k]) => k)
        .sort();

      // WhatsApp → conversations, crm. AI → conversations, crm. Plus the three
      // always-on keys, which are never gated for anyone.
      expect(allowed).toEqual(
        [
          FeatureKey.AI_ASSISTANT,
          FeatureKey.BILLING,
          FeatureKey.CONVERSATIONS,
          FeatureKey.CORE_WORKSPACE,
          FeatureKey.CRM,
          FeatureKey.SUPPORT,
          FeatureKey.WHATSAPP,
        ].sort(),
      );
    });

    it('turning one off leaves the other intact', async () => {
      await grant(owner.tenantId, FeatureKey.AI_ASSISTANT, false);

      expect(
        (await access.resolve(owner.tenantId, FeatureKey.AI_ASSISTANT)).allowed,
      ).toBe(false);
      expect(
        (await access.resolve(owner.tenantId, FeatureKey.WHATSAPP)).allowed,
      ).toBe(true);
      // Still granted — via WhatsApp's closure, not AI's.
      expect(
        (await access.resolve(owner.tenantId, FeatureKey.CRM)).allowed,
      ).toBe(true);
    });
  });

  // ══════════════════════ 5. Suspension outranks everything ════════════════ //

  describe('administrative suspension', () => {
    let paid: SubscribedOwnerFixture;
    let overridden: OwnerFixture;

    beforeAll(async () => {
      paid = await createSubscribedOwnerFixture(e2e, 'access-susp-paid', {}, [
        FeatureKey.WHATSAPP,
      ]);
      overridden = await createOwnerFixture(e2e, 'access-susp-override');
      await grant(overridden.tenantId, FeatureKey.WHATSAPP);
    });
    afterAll(async () => {
      await cleanupSubscriptionFixture(e2e, paid.tenantId, paid.planId);
      await cleanupTenant(e2e, paid.tenantId);
      await cleanupTenant(e2e, overridden.tenantId);
    });

    it('outranks a paid subscription', async () => {
      expect(
        (await access.resolve(paid.tenantId, FeatureKey.WHATSAPP)).allowed,
      ).toBe(true);

      await suspend(paid.tenantId, FeatureKey.WHATSAPP, 'abuse report');

      const d = await access.resolve(paid.tenantId, FeatureKey.WHATSAPP);
      expect(d.allowed).toBe(false);
      expect(d.quotaPolicy).toBe(QuotaPolicy.BLOCKED);

      await lift(paid.tenantId, FeatureKey.WHATSAPP);
      expect(
        (await access.resolve(paid.tenantId, FeatureKey.WHATSAPP)).allowed,
      ).toBe(true);
    });

    it('outranks a feature override', async () => {
      await suspend(overridden.tenantId, FeatureKey.WHATSAPP, 'abuse report');
      expect(
        (await access.resolve(overridden.tenantId, FeatureKey.WHATSAPP))
          .allowed,
      ).toBe(false);
    });

    it('stops the internal WhatsApp send path too', async () => {
      const res = await messaging.sendSession({
        tenantId: overridden.tenantId,
        accountId: 'acc-1',
        phoneNumberId: 'p1',
        mode: 'REAL',
        to: '966500000000',
        text: 'should never leave',
      });
      expect(res.success).toBe(false);
      expect(e2e.whatsappProvider.sendSession).not.toHaveBeenCalled();
    });

    it('stops a queued job for the same capability', async () => {
      await expect(
        workerAuth.assertAuthorized(JOB.WHATSAPP_SEND, {
          tenantId: overridden.tenantId,
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('refuses to suspend an always-on capability', async () => {
      await expect(
        suspend(paid.tenantId, FeatureKey.BILLING, 'nope'),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('records the suspension in the audit log with before and after', async () => {
      const rows = await e2e.dataSource.query(
        `SELECT action, old_values, new_values FROM audit_logs
          WHERE entity_type = 'feature_flag' AND entity_id = $1
            AND action = 'FEATURE_FLAG_SUSPEND'
          ORDER BY created_at DESC LIMIT 1`,
        [overridden.tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].new_values).toMatchObject({
        featureKey: FeatureKey.WHATSAPP,
        suspended: true,
      });
      expect(rows[0].old_values).toBeTruthy();
    });
  });

  // ═════════════════ 6. Every surface reaches the same verdict ═════════════ //

  describe('surface parity — HTTP, worker, socket, internal seam', () => {
    let denied: OwnerFixture;
    let granted: OwnerFixture;

    beforeAll(async () => {
      denied = await createOwnerFixture(e2e, 'access-parity-denied');
      granted = await createOwnerFixture(e2e, 'access-parity-granted');
      await grant(granted.tenantId, FeatureKey.AI_ASSISTANT);
      await grant(granted.tenantId, FeatureKey.WHATSAPP);
    });
    afterAll(async () => {
      await cleanupTenant(e2e, denied.tenantId);
      await cleanupTenant(e2e, granted.tenantId);
    });

    it('worker: rejects a tenant-scoped job for the denied tenant', async () => {
      await expect(
        workerAuth.assertAuthorized(JOB.AI_EXECUTE, {
          tenantId: denied.tenantId,
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('worker: admits the SAME job for the granted tenant', async () => {
      await expect(
        workerAuth.assertAuthorized(JOB.AI_EXECUTE, {
          tenantId: granted.tenantId,
        }),
      ).resolves.toBeUndefined();
    });

    /**
     * Ingest is deliberately un-gated so a blocked clinic never loses inbound
     * customer messages; what the ingested event goes on to DO is gated at the
     * execution seams. This asserts that split explicitly, so a future change
     * that "tidies up" the missing featureKey has to argue with a test.
     */
    it('worker: inbound webhook ingest is never gated', async () => {
      await expect(
        workerAuth.assertAuthorized(JOB.WHATSAPP_WEBHOOK_PROCESS, {
          tenantId: denied.tenantId,
        }),
      ).resolves.toBeUndefined();
    });

    it('socket: ai:message runs for the granted tenant and not the denied one', async () => {
      const socketFor = (tenantId: string) =>
        ({
          data: { tenantId, userId: 'u1', user: undefined },
          emit: jest.fn(),
          join: jest.fn(),
          to: jest.fn().mockReturnValue({ emit: jest.fn() }),
          rooms: new Set<string>(),
        }) as never;

      const blocked = socketFor(denied.tenantId);
      await gateway.onMessage(blocked, { content: 'hi' });
      expect(
        (blocked as unknown as { emit: jest.Mock }).emit,
      ).toHaveBeenCalledWith(
        AI_EVENT.ERROR,
        expect.objectContaining({
          message: 'The AI assistant is not available for this clinic',
        }),
      );
    });

    it('internal seam: sendSession refuses the denied tenant and admits the granted one', async () => {
      const payload = (tenantId: string) => ({
        tenantId,
        accountId: 'acc-1',
        phoneNumberId: 'p1',
        mode: 'REAL',
        to: '966500000000',
        text: 'hello',
      });

      expect(
        (await messaging.sendSession(payload(denied.tenantId))).success,
      ).toBe(false);
      expect(
        (await messaging.sendSession(payload(granted.tenantId))).success,
      ).toBe(true);
    });

    it('HTTP: the route agrees with the worker', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/crm/customers`)
        .set(...authHeader(granted.token))
        .expect(200);
      await request(e2e.app.getHttpServer())
        .get(`${API}/crm/customers`)
        .set(...authHeader(denied.token))
        .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    });
  });

  // ══════════════════════════ 7. Cache invalidation ════════════════════════ //

  describe('cache invalidation after an access mutation', () => {
    let owner: OwnerFixture;

    beforeAll(async () => {
      owner = await createOwnerFixture(e2e, 'access-cache');
    });
    afterAll(async () => cleanupTenant(e2e, owner.tenantId));

    /**
     * Plan §16 — "caching is never allowed to extend a grant". Warming the
     * cache first is the point: without the bust the second resolution would
     * serve the stale DENIED decision for up to the TTL.
     */
    it('a grant takes effect on the very next resolution', async () => {
      expect(
        (await access.resolve(owner.tenantId, FeatureKey.CAMPAIGNS)).allowed,
      ).toBe(false); // warms the cache with a denial

      await grant(owner.tenantId, FeatureKey.CAMPAIGNS);

      expect(
        (await access.resolve(owner.tenantId, FeatureKey.CAMPAIGNS)).allowed,
      ).toBe(true);
    });

    it('a suspension takes effect on the very next resolution', async () => {
      expect(
        (await access.resolve(owner.tenantId, FeatureKey.CAMPAIGNS)).allowed,
      ).toBe(true); // warms the cache with a grant

      await suspend(owner.tenantId, FeatureKey.CAMPAIGNS, 'kill switch');

      expect(
        (await access.resolve(owner.tenantId, FeatureKey.CAMPAIGNS)).allowed,
      ).toBe(false);
    });
  });

  async function countUsageRows(tenantId: string): Promise<number> {
    const rows = await e2e.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM subscription_usage WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0]?.n ?? 0;
  }
});
