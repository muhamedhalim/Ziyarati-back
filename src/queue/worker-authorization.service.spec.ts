import { UnrecoverableError } from 'bullmq';

import { WorkerAuthorizationService } from './worker-authorization.service';
import { TenantLookupService } from '../core/tenant-context/tenant-lookup.service';
import { AuthService } from '../modules/auth/auth.service';
import { TenantApprovalStatus } from '../entities/enums';
import { JOB } from './queue.constants';
import { PERMISSION, ROLE } from '../rbac/rbac.constants';

describe('WorkerAuthorizationService', () => {
  let service: WorkerAuthorizationService;
  let tenantLookup: { findById: jest.Mock };
  let users: { findOne: jest.Mock };
  let authService: { buildAuthenticatedUser: jest.Mock };

  const approvedTenant = { id: 't1', approval_status: TenantApprovalStatus.APPROVED, is_active: true };
  const activeMember = { id: 'u1', is_active: true, tenant: { id: 't1' } };

  beforeEach(() => {
    tenantLookup = { findById: jest.fn() };
    users = { findOne: jest.fn() };
    authService = { buildAuthenticatedUser: jest.fn() };
    service = new WorkerAuthorizationService(
      tenantLookup as unknown as TenantLookupService,
      users as never,
      authService as unknown as AuthService,
    );
  });

  describe('system-tier jobs (e.g. notifications.reap)', () => {
    it('skips entirely — no tenant lookup, no actor lookup', async () => {
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_REAP, { tenantId: null })).resolves.toBeUndefined();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('proceeds (does not throw) even if a system-tier job unexpectedly carries a tenantId — logged, not fatal', async () => {
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_REAP, { tenantId: 't1' })).resolves.toBeUndefined();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
    });
  });

  describe('tenant-tier jobs (e.g. notifications.dispatch — job type ALWAYS carries a real tenantId)', () => {
    it('allows a job for an APPROVED, active tenant', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1' })).resolves.toBeUndefined();
    });

    it('rejects (UnrecoverableError) a job for a tenant that is not APPROVED', async () => {
      tenantLookup.findById.mockResolvedValueOnce({ ...approvedTenant, approval_status: TenantApprovalStatus.SUSPENDED });
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects a job for a tenant that is APPROVED but deactivated', async () => {
      tenantLookup.findById.mockResolvedValueOnce({ ...approvedTenant, is_active: false });
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects a job for a tenant that no longer exists', async () => {
      tenantLookup.findById.mockResolvedValueOnce(null);
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 'ghost' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('REJECTS a tenant-tier job whose tenantId is null — the silent-downgrade bug this tiering fixes (gap-closure pass)', async () => {
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: null })).rejects.toBeInstanceOf(UnrecoverableError);
      expect(tenantLookup.findById).not.toHaveBeenCalled();
    });

    it('caches the tenant result — a second job for the same tenant within the TTL does not re-query', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1' });
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1' });
      expect(tenantLookup.findById).toHaveBeenCalledTimes(1);
    });

    it('"system" is treated as a placeholder, not a real actor — no actor lookup', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'system' });
      expect(users.findOne).not.toHaveBeenCalled();
    });
  });

  describe('system-or-tenant tier (a job name genuinely serving BOTH roles, e.g. whatsapp.webhookProcess)', () => {
    it('treats a null tenantId as the system/sweep invocation — no tenant lookup', async () => {
      await expect(service.assertAuthorized(JOB.WHATSAPP_WEBHOOK_PROCESS, { tenantId: null })).resolves.toBeUndefined();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
    });

    it('validates the tenant when a real tenantId IS present', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await expect(service.assertAuthorized(JOB.WHATSAPP_WEBHOOK_PROCESS, { tenantId: 't1' })).resolves.toBeUndefined();
      expect(tenantLookup.findById).toHaveBeenCalledWith('t1');
    });
  });

  describe('unregistered job names — FAIL CLOSED (gap-closure pass, §0.8.7)', () => {
    it('rejects permanently (UnrecoverableError) rather than falling back to a permissive default', async () => {
      await expect(service.assertAuthorized('some.unregistered.job', { tenantId: null })).rejects.toThrow(UnrecoverableError);
    });

    it('rejects a job with NO tenantId at all just as loudly — fail-closed applies regardless of payload shape', async () => {
      await expect(service.assertAuthorized('some.other.unregistered.job', { tenantId: 't1' })).rejects.toThrow(
        /No authorization policy registered/,
      );
    });

    it('never reaches tenant/actor lookups for an unregistered job — rejected before any DB call', async () => {
      await expect(service.assertAuthorized('yet.another.unregistered.job', { tenantId: 't1', actorId: 'u1' })).rejects.toThrow();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
      expect(users.findOne).not.toHaveBeenCalled();
    });
  });

  describe('actor validation (actorId present, any tier that requires a tenantId)', () => {
    it('allows a job whose actor exists, is active, and belongs to the tenant', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce(activeMember);
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'u1' })).resolves.toBeUndefined();
    });

    it('rejects when the actor does not exist', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce(null);
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'ghost' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects when the actor is deactivated', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce({ ...activeMember, is_active: false });
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'u1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects when the actor belongs to a DIFFERENT tenant than the job claims (forged/stale actorId)', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce({ ...activeMember, tenant: { id: 't2' } });
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'u1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('still rejects an actor job outright when the TENANT check fails first (actor lookup never runs)', async () => {
      tenantLookup.findById.mockResolvedValueOnce({ ...approvedTenant, is_active: false });
      await expect(service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'u1' })).rejects.toBeInstanceOf(UnrecoverableError);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('caches the actor result per (tenant, actor) pair', async () => {
      tenantLookup.findById.mockResolvedValue(approvedTenant);
      users.findOne.mockResolvedValueOnce(activeMember);
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'u1' });
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'u1' });
      expect(users.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('permission check (workflow.action — the one job type with a requiredPermission)', () => {
    beforeEach(() => {
      tenantLookup.findById.mockResolvedValue(approvedTenant);
      users.findOne.mockResolvedValue(activeMember);
    });

    it('allows an actor who holds the required permission', async () => {
      authService.buildAuthenticatedUser.mockResolvedValueOnce({ id: 'u1', tenantId: 't1', email: null, roles: [], permissions: [PERMISSION.AI_MANAGE] });
      await expect(service.assertAuthorized(JOB.WORKFLOW_ACTION, { tenantId: 't1', actorId: 'u1' })).resolves.toBeUndefined();
    });

    it('rejects an actor who no longer holds the required permission', async () => {
      authService.buildAuthenticatedUser.mockResolvedValueOnce({ id: 'u1', tenantId: 't1', email: null, roles: [], permissions: [] });
      await expect(service.assertAuthorized(JOB.WORKFLOW_ACTION, { tenantId: 't1', actorId: 'u1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('super_admin bypasses the permission check, mirroring PermissionsGuard', async () => {
      authService.buildAuthenticatedUser.mockResolvedValueOnce({ id: 'u1', tenantId: 't1', email: null, roles: [ROLE.SUPER_ADMIN], permissions: [] });
      await expect(service.assertAuthorized(JOB.WORKFLOW_ACTION, { tenantId: 't1', actorId: 'u1' })).resolves.toBeUndefined();
    });

    it('does NOT check permission when no actor is present (system-triggered workflow run)', async () => {
      await expect(service.assertAuthorized(JOB.WORKFLOW_ACTION, { tenantId: 't1' })).resolves.toBeUndefined();
      expect(authService.buildAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('caches the permission result per (actor, permission) pair', async () => {
      authService.buildAuthenticatedUser.mockResolvedValue({ id: 'u1', tenantId: 't1', email: null, roles: [], permissions: [PERMISSION.AI_MANAGE] });
      await service.assertAuthorized(JOB.WORKFLOW_ACTION, { tenantId: 't1', actorId: 'u1' });
      await service.assertAuthorized(JOB.WORKFLOW_ACTION, { tenantId: 't1', actorId: 'u1' });
      expect(authService.buildAuthenticatedUser).toHaveBeenCalledTimes(1);
    });

    it('treats a lookup failure (inactive/missing user) as lacking the permission, not a crash', async () => {
      authService.buildAuthenticatedUser.mockRejectedValueOnce(new Error('user inactive'));
      await expect(service.assertAuthorized(JOB.WORKFLOW_ACTION, { tenantId: 't1', actorId: 'u1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('does not check permission for a job type with no requiredPermission declared (notifications.dispatch)', async () => {
      await service.assertAuthorized(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1', actorId: 'u1' });
      expect(authService.buildAuthenticatedUser).not.toHaveBeenCalled();
    });
  });
});
