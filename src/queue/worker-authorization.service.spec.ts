import { UnrecoverableError } from 'bullmq';

import { WorkerAuthorizationService } from './worker-authorization.service';
import { TenantLookupService } from '../core/tenant-context/tenant-lookup.service';
import { AuthService } from '../modules/auth/auth.service';
import { AccessControlService } from '../modules/subscription-billing/access-control.service';
import { FeatureKey } from '../modules/subscription-billing/feature-registry';
import {
  AccessSource,
  QuotaPolicy,
} from '../modules/subscription-billing/tenant-access-decision';
import { TenantApprovalStatus } from '../entities/enums';
import { JOB } from './queue.constants';
import { PERMISSION, ROLE } from '../rbac/rbac.constants';

describe('WorkerAuthorizationService', () => {
  let service: WorkerAuthorizationService;
  let tenantLookup: { findById: jest.Mock };
  let users: { findOne: jest.Mock };
  let authService: { buildAuthenticatedUser: jest.Mock };
  let access: { resolve: jest.Mock; shouldBlock: jest.Mock };

  const approvedTenant = {
    id: 't1',
    approval_status: TenantApprovalStatus.APPROVED,
    is_active: true,
  };
  const activeMember = { id: 'u1', is_active: true, tenant: { id: 't1' } };

  beforeEach(() => {
    tenantLookup = { findById: jest.fn() };
    users = { findOne: jest.fn() };
    authService = { buildAuthenticatedUser: jest.fn() };
    access = {
      resolve: jest.fn().mockResolvedValue({
        allowed: true,
        tenantId: 't1',
        featureKey: null,
        source: AccessSource.ACTIVE_SUBSCRIPTION,
        quotaPolicy: QuotaPolicy.PLAN_ENFORCED,
      }),
      // true = ENFORCE, the production default (see AccessPolicyModeService).
      shouldBlock: jest.fn().mockReturnValue(true),
    };
    service = new WorkerAuthorizationService(
      tenantLookup as unknown as TenantLookupService,
      users as never,
      authService as unknown as AuthService,
      access as unknown as AccessControlService,
    );
  });

  describe('system-tier jobs (e.g. notifications.reap)', () => {
    it('skips entirely — no tenant lookup, no actor lookup', async () => {
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_REAP, { tenantId: null }),
      ).resolves.toBeUndefined();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('proceeds (does not throw) even if a system-tier job unexpectedly carries a tenantId — logged, not fatal', async () => {
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_REAP, { tenantId: 't1' }),
      ).resolves.toBeUndefined();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
    });
  });

  // REL-005 — payments.outcome applies the consequences of money that has ALREADY
  // moved. Tenant tier would reject it permanently (UnrecoverableError, no retry)
  // for a tenant suspended or deactivated in the meantime, stranding a captured
  // payment with no booking and no entitlement.
  describe('payments.outcome (REL-005) — system tier even though every row carries a tenantId', () => {
    it('is NOT rejected for a suspended / unapproved / inactive tenant', async () => {
      tenantLookup.findById.mockResolvedValue({
        id: 't1',
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: false,
      });
      await expect(
        service.assertAuthorized(JOB.PAYMENTS_OUTCOME, { tenantId: 't1' }),
      ).resolves.toBeUndefined();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
    });

    it('is registered, so it is not caught by the fail-closed unregistered-job rule', async () => {
      await expect(
        service.assertAuthorized(JOB.PAYMENTS_OUTCOME, { tenantId: 't1' }),
      ).resolves.toBeUndefined();
    });

    it('asks nothing of the access policy (no entitlement gate on a captured payment)', async () => {
      await service.assertAuthorized(JOB.PAYMENTS_OUTCOME, { tenantId: 't1' });
      expect(access.resolve).not.toHaveBeenCalled();
    });
  });

  describe('tenant-tier jobs (e.g. notifications.dispatch — job type ALWAYS carries a real tenantId)', () => {
    it('allows a job for an APPROVED, active tenant', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects (UnrecoverableError) a job for a tenant that is not APPROVED', async () => {
      tenantLookup.findById.mockResolvedValueOnce({
        ...approvedTenant,
        approval_status: TenantApprovalStatus.SUSPENDED,
      });
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects a job for a tenant that is APPROVED but deactivated', async () => {
      tenantLookup.findById.mockResolvedValueOnce({
        ...approvedTenant,
        is_active: false,
      });
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects a job for a tenant that no longer exists', async () => {
      tenantLookup.findById.mockResolvedValueOnce(null);
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 'ghost',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('REJECTS a tenant-tier job whose tenantId is null — the silent-downgrade bug this tiering fixes (gap-closure pass)', async () => {
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: null,
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(tenantLookup.findById).not.toHaveBeenCalled();
    });

    it('caches the tenant result — a second job for the same tenant within the TTL does not re-query', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
      });
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
      });
      expect(tenantLookup.findById).toHaveBeenCalledTimes(1);
    });

    it('Phase 6 — tenant cache expires after its 30s TTL and re-queries, reflecting a tenant suspended mid-window', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
      });
      expect(tenantLookup.findById).toHaveBeenCalledTimes(1);

      // Still within the 30s TTL — the stale (now-wrong) cached "ok" is served.
      jest.spyOn(Date, 'now').mockReturnValue(now + 29_000);
      tenantLookup.findById.mockResolvedValueOnce({
        ...approvedTenant,
        approval_status: TenantApprovalStatus.SUSPENDED,
      });
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1' }),
      ).resolves.toBeUndefined();
      expect(tenantLookup.findById).toHaveBeenCalledTimes(1);

      // Past the TTL — a fresh lookup runs and the suspension is observed.
      jest.spyOn(Date, 'now').mockReturnValue(now + 30_001);
      tenantLookup.findById.mockResolvedValueOnce({
        ...approvedTenant,
        approval_status: TenantApprovalStatus.SUSPENDED,
      });
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1' }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(tenantLookup.findById).toHaveBeenCalledTimes(2);
      jest.restoreAllMocks();
    });

    it('"system" is treated as a placeholder, not a real actor — no actor lookup', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
        actorId: 'system',
      });
      expect(users.findOne).not.toHaveBeenCalled();
    });
  });

  describe('system-or-tenant tier (a job name genuinely serving BOTH roles, e.g. whatsapp.webhookProcess)', () => {
    it('treats a null tenantId as the system/sweep invocation — no tenant lookup', async () => {
      await expect(
        service.assertAuthorized(JOB.WHATSAPP_WEBHOOK_PROCESS, {
          tenantId: null,
        }),
      ).resolves.toBeUndefined();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
    });

    it('validates the tenant when a real tenantId IS present', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await expect(
        service.assertAuthorized(JOB.WHATSAPP_WEBHOOK_PROCESS, {
          tenantId: 't1',
        }),
      ).resolves.toBeUndefined();
      expect(tenantLookup.findById).toHaveBeenCalledWith('t1');
    });
  });

  describe('unregistered job names — FAIL CLOSED (gap-closure pass, §0.8.7)', () => {
    it('rejects permanently (UnrecoverableError) rather than falling back to a permissive default', async () => {
      await expect(
        service.assertAuthorized('some.unregistered.job', { tenantId: null }),
      ).rejects.toThrow(UnrecoverableError);
    });

    it('rejects a job with NO tenantId at all just as loudly — fail-closed applies regardless of payload shape', async () => {
      await expect(
        service.assertAuthorized('some.other.unregistered.job', {
          tenantId: 't1',
        }),
      ).rejects.toThrow(/No authorization policy registered/);
    });

    it('never reaches tenant/actor lookups for an unregistered job — rejected before any DB call', async () => {
      await expect(
        service.assertAuthorized('yet.another.unregistered.job', {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).rejects.toThrow();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
      expect(users.findOne).not.toHaveBeenCalled();
    });
  });

  describe('actor validation (actorId present, any tier that requires a tenantId)', () => {
    it('allows a job whose actor exists, is active, and belongs to the tenant', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce(activeMember);
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects when the actor does not exist', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce(null);
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
          actorId: 'ghost',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects when the actor is deactivated', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce({
        ...activeMember,
        is_active: false,
      });
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects when the actor belongs to a DIFFERENT tenant than the job claims (forged/stale actorId)', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce({
        ...activeMember,
        tenant: { id: 't2' },
      });
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('still rejects an actor job outright when the TENANT check fails first (actor lookup never runs)', async () => {
      tenantLookup.findById.mockResolvedValueOnce({
        ...approvedTenant,
        is_active: false,
      });
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('caches the actor result per (tenant, actor) pair', async () => {
      tenantLookup.findById.mockResolvedValue(approvedTenant);
      users.findOne.mockResolvedValueOnce(activeMember);
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
        actorId: 'u1',
      });
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
        actorId: 'u1',
      });
      expect(users.findOne).toHaveBeenCalledTimes(1);
    });

    it('Phase 6 — actor cache expires after its 30s TTL and re-queries, reflecting an actor deactivated mid-window', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      tenantLookup.findById.mockResolvedValue(approvedTenant);
      users.findOne.mockResolvedValueOnce(activeMember);
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
        actorId: 'u1',
      });
      expect(users.findOne).toHaveBeenCalledTimes(1);

      jest.spyOn(Date, 'now').mockReturnValue(now + 30_001);
      users.findOne.mockResolvedValueOnce({ ...activeMember, is_active: false });
      await expect(
        service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(users.findOne).toHaveBeenCalledTimes(2);
      jest.restoreAllMocks();
    });
  });

  /**
   * Background work used to evaluate NOTHING about entitlement — grepping
   * `src/worker` and `src/queue` for the access policy returned zero hits — so
   * a queued WhatsApp send, campaign fan-out or AI turn ran for a tenant whose
   * capability was suspended, lapsed, or never granted. The queue is the LAST
   * gate on those paths: nothing downstream of it re-checks.
   */
  describe('entitlement (tenant-scoped jobs)', () => {
    it('asks the policy for the capability the job declares', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized(JOB.WHATSAPP_SEND, { tenantId: 't1' });
      expect(access.resolve).toHaveBeenCalledWith('t1', FeatureKey.WHATSAPP);
    });

    it('permanently rejects a job the tenant is not entitled to', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      access.resolve.mockResolvedValueOnce({
        allowed: false,
        tenantId: 't1',
        featureKey: FeatureKey.CAMPAIGNS,
        source: AccessSource.DENIED,
        quotaPolicy: QuotaPolicy.BLOCKED,
        reason: 'no subscription',
      });

      // UnrecoverableError, not a retry: entitlement does not fix itself on a
      // backoff, and retrying would land the job in a DLQ telling a misleading
      // "transient failure" story.
      await expect(
        service.assertAuthorized(JOB.CAMPAIGNS_LAUNCH, { tenantId: 't1' }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('fails CLOSED when the decision cannot be resolved', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      access.resolve.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.assertAuthorized(JOB.AI_EXECUTE, { tenantId: 't1' }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('skips the check for jobs that declare no capability', async () => {
      // Webhook delivery ships events already produced, and inbound ingest must
      // keep accepting data so nothing is lost while a tenant is blocked.
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized(JOB.WEBHOOKS_DELIVER, { tenantId: 't1' });
      expect(access.resolve).not.toHaveBeenCalled();
    });

    it('never runs for system-tier sweeps', async () => {
      await service.assertAuthorized(JOB.NOTIFICATIONS_REAP, {
        tenantId: null,
      });
      expect(access.resolve).not.toHaveBeenCalled();
    });

    // Plan §18 — shadow mode must reach the SAME verdict HTTP does, and record
    // it, without stopping production traffic.
    it('records but does not reject in shadow mode', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      access.resolve.mockResolvedValueOnce({
        allowed: false,
        tenantId: 't1',
        featureKey: FeatureKey.CAMPAIGNS,
        source: AccessSource.DENIED,
        quotaPolicy: QuotaPolicy.BLOCKED,
      });
      access.shouldBlock.mockReturnValueOnce(false);

      await expect(
        service.assertAuthorized(JOB.CAMPAIGNS_LAUNCH, { tenantId: 't1' }),
      ).resolves.toBeUndefined();
      expect(access.shouldBlock).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: false }),
        { surface: 'worker', detail: JOB.CAMPAIGNS_LAUNCH },
      );
    });

    /**
     * "We could not tell" is an infrastructure failure, not an entitlement
     * finding. Shadowing it would turn a database outage into an open door on
     * every background path at once, which is the opposite of what a rollout
     * safety net is for.
     */
    it('still fails CLOSED in shadow mode when the decision cannot be resolved', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      access.resolve.mockRejectedValueOnce(new Error('db down'));
      access.shouldBlock.mockReturnValue(false);

      await expect(
        service.assertAuthorized(JOB.AI_EXECUTE, { tenantId: 't1' }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(access.shouldBlock).not.toHaveBeenCalled();
    });
  });

  describe('permission check (workflow.action — the one job type with a requiredPermission)', () => {
    beforeEach(() => {
      tenantLookup.findById.mockResolvedValue(approvedTenant);
      users.findOne.mockResolvedValue(activeMember);
    });

    it('allows an actor who holds the required permission', async () => {
      authService.buildAuthenticatedUser.mockResolvedValueOnce({
        id: 'u1',
        tenantId: 't1',
        email: null,
        roles: [],
        permissions: [PERMISSION.AI_MANAGE],
      });
      await expect(
        service.assertAuthorized(JOB.WORKFLOW_ACTION, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects an actor who no longer holds the required permission', async () => {
      authService.buildAuthenticatedUser.mockResolvedValueOnce({
        id: 'u1',
        tenantId: 't1',
        email: null,
        roles: [],
        permissions: [],
      });
      await expect(
        service.assertAuthorized(JOB.WORKFLOW_ACTION, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('super_admin bypasses the permission check, mirroring PermissionsGuard', async () => {
      authService.buildAuthenticatedUser.mockResolvedValueOnce({
        id: 'u1',
        tenantId: 't1',
        email: null,
        roles: [ROLE.SUPER_ADMIN],
        permissions: [],
      });
      await expect(
        service.assertAuthorized(JOB.WORKFLOW_ACTION, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).resolves.toBeUndefined();
    });

    it('does NOT check permission when no actor is present (system-triggered workflow run)', async () => {
      await expect(
        service.assertAuthorized(JOB.WORKFLOW_ACTION, { tenantId: 't1' }),
      ).resolves.toBeUndefined();
      expect(authService.buildAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('caches the permission result per (actor, permission) pair', async () => {
      authService.buildAuthenticatedUser.mockResolvedValue({
        id: 'u1',
        tenantId: 't1',
        email: null,
        roles: [],
        permissions: [PERMISSION.AI_MANAGE],
      });
      await service.assertAuthorized(JOB.WORKFLOW_ACTION, {
        tenantId: 't1',
        actorId: 'u1',
      });
      await service.assertAuthorized(JOB.WORKFLOW_ACTION, {
        tenantId: 't1',
        actorId: 'u1',
      });
      expect(authService.buildAuthenticatedUser).toHaveBeenCalledTimes(1);
    });

    it('Phase 6 — permission cache expires after its 30s TTL and re-queries, reflecting a permission revoked mid-window', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      authService.buildAuthenticatedUser.mockResolvedValueOnce({
        id: 'u1',
        tenantId: 't1',
        email: null,
        roles: [],
        permissions: [PERMISSION.AI_MANAGE],
      });
      await service.assertAuthorized(JOB.WORKFLOW_ACTION, {
        tenantId: 't1',
        actorId: 'u1',
      });
      expect(authService.buildAuthenticatedUser).toHaveBeenCalledTimes(1);

      // Past the TTL (actor cache expires alongside it, re-validated the same way).
      jest.spyOn(Date, 'now').mockReturnValue(now + 30_001);
      authService.buildAuthenticatedUser.mockResolvedValueOnce({
        id: 'u1',
        tenantId: 't1',
        email: null,
        roles: [],
        permissions: [],
      });
      await expect(
        service.assertAuthorized(JOB.WORKFLOW_ACTION, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(authService.buildAuthenticatedUser).toHaveBeenCalledTimes(2);
      jest.restoreAllMocks();
    });

    it('treats a lookup failure (inactive/missing user) as lacking the permission, not a crash', async () => {
      authService.buildAuthenticatedUser.mockRejectedValueOnce(
        new Error('user inactive'),
      );
      await expect(
        service.assertAuthorized(JOB.WORKFLOW_ACTION, {
          tenantId: 't1',
          actorId: 'u1',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('does not check permission for a job type with no requiredPermission declared (notifications.dispatch)', async () => {
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
        actorId: 'u1',
      });
      expect(authService.buildAuthenticatedUser).not.toHaveBeenCalled();
    });
  });
});
