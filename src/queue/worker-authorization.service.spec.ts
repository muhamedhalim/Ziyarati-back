import { UnrecoverableError } from 'bullmq';

import { WorkerAuthorizationService } from './worker-authorization.service';
import { TenantLookupService } from '../core/tenant-context/tenant-lookup.service';
import { TenantApprovalStatus } from '../entities/enums';

describe('WorkerAuthorizationService', () => {
  let service: WorkerAuthorizationService;
  let tenantLookup: { findById: jest.Mock };
  let users: { findOne: jest.Mock };

  const approvedTenant = { id: 't1', approval_status: TenantApprovalStatus.APPROVED, is_active: true };
  const activeMember = { id: 'u1', is_active: true, tenant: { id: 't1' } };

  beforeEach(() => {
    tenantLookup = { findById: jest.fn() };
    users = { findOne: jest.fn() };
    service = new WorkerAuthorizationService(
      tenantLookup as unknown as TenantLookupService,
      users as never,
    );
  });

  describe('system jobs (tenantId: null)', () => {
    it('skips entirely — no tenant lookup, no actor lookup', async () => {
      await expect(service.assertAuthorized({ tenantId: null })).resolves.toBeUndefined();
      expect(tenantLookup.findById).not.toHaveBeenCalled();
      expect(users.findOne).not.toHaveBeenCalled();
    });
  });

  describe('tenant jobs (tenantId set, no real actorId)', () => {
    it('allows a job for an APPROVED, active tenant', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await expect(service.assertAuthorized({ tenantId: 't1' })).resolves.toBeUndefined();
    });

    it('rejects (UnrecoverableError) a job for a tenant that is not APPROVED', async () => {
      tenantLookup.findById.mockResolvedValueOnce({ ...approvedTenant, approval_status: TenantApprovalStatus.SUSPENDED });
      await expect(service.assertAuthorized({ tenantId: 't1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects a job for a tenant that is APPROVED but deactivated', async () => {
      tenantLookup.findById.mockResolvedValueOnce({ ...approvedTenant, is_active: false });
      await expect(service.assertAuthorized({ tenantId: 't1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects a job for a tenant that no longer exists', async () => {
      tenantLookup.findById.mockResolvedValueOnce(null);
      await expect(service.assertAuthorized({ tenantId: 'ghost' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('caches the tenant result — a second job for the same tenant within the TTL does not re-query', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized({ tenantId: 't1' });
      await service.assertAuthorized({ tenantId: 't1' });
      expect(tenantLookup.findById).toHaveBeenCalledTimes(1);
    });

    it('"system" is treated as a placeholder, not a real actor — no actor lookup', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      await service.assertAuthorized({ tenantId: 't1', actorId: 'system' });
      expect(users.findOne).not.toHaveBeenCalled();
    });
  });

  describe('actor jobs (tenantId + a real actorId)', () => {
    it('allows a job whose actor exists, is active, and belongs to the tenant', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce(activeMember);
      await expect(service.assertAuthorized({ tenantId: 't1', actorId: 'u1' })).resolves.toBeUndefined();
    });

    it('rejects when the actor does not exist', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce(null);
      await expect(service.assertAuthorized({ tenantId: 't1', actorId: 'ghost' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects when the actor is deactivated', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce({ ...activeMember, is_active: false });
      await expect(service.assertAuthorized({ tenantId: 't1', actorId: 'u1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('rejects when the actor belongs to a DIFFERENT tenant than the job claims (forged/stale actorId)', async () => {
      tenantLookup.findById.mockResolvedValueOnce(approvedTenant);
      users.findOne.mockResolvedValueOnce({ ...activeMember, tenant: { id: 't2' } });
      await expect(service.assertAuthorized({ tenantId: 't1', actorId: 'u1' })).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('still rejects an actor job outright when the TENANT check fails first (actor lookup never runs)', async () => {
      tenantLookup.findById.mockResolvedValueOnce({ ...approvedTenant, is_active: false });
      await expect(service.assertAuthorized({ tenantId: 't1', actorId: 'u1' })).rejects.toBeInstanceOf(UnrecoverableError);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('caches the actor result per (tenant, actor) pair', async () => {
      tenantLookup.findById.mockResolvedValue(approvedTenant);
      users.findOne.mockResolvedValueOnce(activeMember);
      await service.assertAuthorized({ tenantId: 't1', actorId: 'u1' });
      await service.assertAuthorized({ tenantId: 't1', actorId: 'u1' });
      expect(users.findOne).toHaveBeenCalledTimes(1);
    });
  });
});
