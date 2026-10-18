import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { TenantService } from './tenant.service';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { TenantApprovalEvent } from '../../entities/SaaS-Core/TenantApprovalEvent';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { TenantApprovalStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

describe('TenantService', () => {
  let service: TenantService;
  let tenants: MockRepository;
  let settings: MockRepository;
  let approvalEvents: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;

  beforeEach(async () => {
    tenants = createMockRepository();
    settings = createMockRepository();
    approvalEvents = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: getRepositoryToken(TenantSetting), useValue: settings },
        { provide: getRepositoryToken(TenantApprovalEvent), useValue: approvalEvents },
        { provide: DataSource, useValue: dataSource },
        {
          provide: AccessControlService,
          useValue: { assertAccess: jest.fn() },
        },
        { provide: ActivityAuditService, useValue: { record: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(TenantService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    const dto = { name: 'Clinic', slug: 'clinic', contactEmail: 'c@x.com' } as any;

    it('creates a tenant with default settings and a CREATED audit event', async () => {
      tenants.findOne.mockResolvedValueOnce(null); // slug free
      tenants.findOne.mockResolvedValueOnce(null); // email free

      await service.create(dto, 'admin-1');

      expect(manager.create).toHaveBeenCalledWith(Tenant, expect.objectContaining({ slug: 'clinic' }));
      expect(manager.create).toHaveBeenCalledWith(TenantSetting, expect.any(Object));
      expect(manager.create).toHaveBeenCalledWith(
        TenantApprovalEvent,
        expect.objectContaining({ action: 'CREATED', acted_by: 'admin-1' }),
      );
    });

    it('rejects a taken slug', async () => {
      tenants.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create(dto, 'admin-1')).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('rejects a contact email already in use', async () => {
      tenants.findOne.mockResolvedValueOnce(null); // slug free
      tenants.findOne.mockResolvedValueOnce({ id: 'existing' }); // email taken
      await expect(service.create(dto, 'admin-1')).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  describe('approval lifecycle (state machine)', () => {
    it('approves a PENDING_VERIFICATION tenant and activates it', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'ten-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
        is_active: false,
      });

      await service.approve('ten-1', 'admin-1', 'looks good');

      const saved = manager.save.mock.calls[0][0];
      expect(saved.approval_status).toBe(TenantApprovalStatus.APPROVED);
      expect(saved.is_active).toBe(true);
    });

    it('suspends an APPROVED tenant and deactivates it', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'ten-1',
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      });
      await service.suspend('ten-1', 'admin-1');
      const saved = manager.save.mock.calls[0][0];
      expect(saved.approval_status).toBe(TenantApprovalStatus.SUSPENDED);
      expect(saved.is_active).toBe(false);
    });

    it('rejects an illegal transition (APPROVED → APPROVED is not allowed)', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'ten-1',
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      });
      await expect(service.approve('ten-1', 'admin-1')).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    });

    it('throws when the tenant does not exist', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(service.suspend('nope', 'admin-1')).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_FOUND,
      });
    });
  });

  describe('default branch provisioning on approval', () => {
    it('creates one default branch when a tenant is approved with none yet', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'ten-1',
        approval_status: TenantApprovalStatus.PENDING_VERIFICATION,
        is_active: false,
        default_timezone: 'Asia/Riyadh',
      });
      manager.count.mockResolvedValueOnce(0); // no branches yet

      await service.approve('ten-1', 'admin-1');

      expect(manager.count).toHaveBeenCalledWith(Branch, {
        where: { tenant: { id: 'ten-1' } },
      });
      expect(manager.create).toHaveBeenCalledWith(
        Branch,
        expect.objectContaining({
          name: 'Main Branch',
          timezone: 'Asia/Riyadh',
          is_active: true,
        }),
      );
    });

    it('does not create a second default branch on re-approval (idempotent)', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'ten-1',
        approval_status: TenantApprovalStatus.SUSPENDED,
        is_active: false,
        default_timezone: 'UTC',
      });
      manager.count.mockResolvedValueOnce(1); // already has a branch

      await service.approve('ten-1', 'admin-1');

      expect(manager.create).not.toHaveBeenCalledWith(Branch, expect.anything());
    });
  });

  describe('settings', () => {
    it('lazily creates a settings row when none exists', async () => {
      settings.findOne.mockResolvedValueOnce(null);
      tenants.findOne.mockResolvedValueOnce({ id: 'ten-1' }); // findById existence check
      settings.save.mockResolvedValueOnce({ id: 'set-1' });
      const result = await service.getSettings('ten-1');
      expect(settings.save).toHaveBeenCalled();
      expect(result).toEqual({ id: 'set-1' });
    });

    it('updates existing settings', async () => {
      settings.findOne.mockResolvedValueOnce({ id: 'set-1', payment_required: true });
      settings.save.mockImplementationOnce(async (s: any) => s);
      const result = await service.updateSettings('ten-1', { paymentRequired: false } as any);
      expect(result).toEqual(expect.objectContaining({ payment_required: false }));
    });

    it('merges the T011 self-service/reminder switches, leaving unspecified fields unchanged', async () => {
      settings.findOne.mockResolvedValueOnce({
        id: 'set-1',
        self_cancellation_enabled: false,
        self_reschedule_enabled: false,
        reminders_enabled: false,
        reminder_lead_minutes: [],
      });
      settings.save.mockImplementationOnce(async (s: any) => s);
      const result = await service.updateSettings('ten-1', {
        selfCancellationEnabled: true,
        remindersEnabled: true,
        reminderLeadMinutes: [1440, 60],
      } as any);
      expect(result).toEqual(
        expect.objectContaining({
          self_cancellation_enabled: true,
          self_reschedule_enabled: false, // untouched by this call
          reminders_enabled: true,
          reminder_lead_minutes: [1440, 60],
        }),
      );
    });
  });

  describe('queries', () => {
    it('lists tenants with status filter, search and pagination', async () => {
      tenants.findAndCount.mockResolvedValueOnce([[{ id: 'ten-1' }], 1]);
      const res = await service.findAll({ page: 1, limit: 20, status: TenantApprovalStatus.APPROVED, search: 'clin' } as any);
      expect(res).toEqual({ data: [{ id: 'ten-1' }], total: 1, page: 1, limit: 20 });
    });

    it('returns a tenant by id', async () => {
      tenants.findOne.mockResolvedValueOnce({ id: 'ten-1' });
      await expect(service.findById('ten-1')).resolves.toEqual({ id: 'ten-1' });
    });

    // P4-1 (015-db-api-efficiency-audit, R-09): T028's consumer analysis
    // found no consumer of the `settings` sub-object this used to join, so
    // T029 dropped the relation — plain-column `where`, one round trip
    // instead of two. This is the regression guard for that: the join must
    // never come back.
    it('loads by plain-column where — no relations, one repository call', async () => {
      tenants.findOne.mockResolvedValueOnce({ id: 'ten-1', name: 'Al-Noor' });

      const result = await service.findById('ten-1');

      expect(tenants.findOne).toHaveBeenCalledTimes(1);
      expect(tenants.findOne).toHaveBeenCalledWith({ where: { id: 'ten-1' } });
      const call = tenants.findOne.mock.calls[0][0];
      expect(call).not.toHaveProperty('relations');
      expect(result).toEqual({ id: 'ten-1', name: 'Al-Noor' });
    });

    it('returned tenant shape carries no settings key when the repository omits it', async () => {
      tenants.findOne.mockResolvedValueOnce({
        id: 'ten-1',
        name: 'Al-Noor',
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      });

      const result = await service.findById('ten-1');

      expect(result).not.toHaveProperty('settings');
    });

    it('throws when a tenant is not found', async () => {
      tenants.findOne.mockResolvedValueOnce(null);
      await expect(service.findById('nope')).rejects.toMatchObject({ code: ErrorCode.TENANT_NOT_FOUND });
    });

    it('updates the tenant profile', async () => {
      tenants.findOne.mockResolvedValueOnce({ id: 'ten-1', name: 'Old', contact_email: 'a@x.com' });
      tenants.save.mockImplementationOnce(async (t: any) => t);
      const res = await service.updateProfile('ten-1', { name: 'New' } as any);
      expect(res).toEqual(expect.objectContaining({ name: 'New' }));
    });

    it('returns the approval-event history', async () => {
      tenants.findOne.mockResolvedValueOnce({ id: 'ten-1', settings: null });
      approvalEvents.find.mockResolvedValueOnce([{ id: 'ev-1', action: 'APPROVED' }]);
      await expect(service.getApprovalEvents('ten-1')).resolves.toEqual([{ id: 'ev-1', action: 'APPROVED' }]);
    });
  });
});
