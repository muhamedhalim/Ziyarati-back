import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AppRedisService } from '../../queue/app-redis.service';
import { PatientQueueService } from './patient-queue.service';
import { QueueEntry } from '../../entities/Calendar&Appointments/QueueEntry';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { AppointmentsService } from '../appointment/appointment.service';
import {
  QueueState,
  AppointmentStatus,
  AppointmentPaymentStatus,
} from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const USER = 'u1';
const BRANCH = 'b1';

describe('PatientQueueService.list (FR-Q008/FR-Q013/FR-Q014)', () => {
  let service: PatientQueueService;
  let entries: MockRepository;
  let branches: MockRepository;
  let branchUsers: MockRepository;

  beforeEach(async () => {
    entries = createMockRepository();
    branches = createMockRepository();
    branchUsers = createMockRepository();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientQueueService,
        { provide: getRepositoryToken(QueueEntry), useValue: entries },
        {
          provide: getRepositoryToken(Appointment),
          useValue: createMockRepository(),
        },
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: getRepositoryToken(BranchUser), useValue: branchUsers },
        { provide: AppointmentsService, useValue: { changeStatus: jest.fn() } },
        {
          provide: ActivityAuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        // The REAL BranchScopeService over this suite's own `branchUsers`
        // mock — FR-Q014's cases assert on rows returned from that mock, so
        // keeping the real lookup keeps them testing the real path. Redis
        // always rejects here, which makes the service fall through to the
        // repository, deterministically.
        BranchScopeService,
        {
          provide: AppRedisService,
          useValue: {
            application: {
              get: jest.fn().mockRejectedValue(new Error('no redis')),
              set: jest.fn().mockRejectedValue(new Error('no redis')),
            },
          },
        },
        { provide: TenantContextService, useValue: new TenantContextService() },
      ],
    }).compile();
    service = moduleRef.get(PatientQueueService);
  });

  afterEach(() => jest.clearAllMocks());

  /** Item 5 — an invalid/nonexistent branchId must 404, never reach `entries.find`. */
  it('throws NOT_FOUND for a nonexistent (or cross-tenant) branchId instead of querying the queue', async () => {
    branches.findOne.mockResolvedValueOnce(null);

    await expect(
      service.list(TENANT, USER, { branchId: 'does-not-exist' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

    expect(entries.find).not.toHaveBeenCalled();
  });

  it("rejects a branch outside the caller's own assigned branches (FR-Q014)", async () => {
    branches.findOne.mockResolvedValueOnce({
      id: BRANCH,
      timezone: 'Asia/Riyadh',
    });
    branchUsers.find.mockResolvedValueOnce([
      { branch: { id: 'some-other-branch' } },
    ]);

    await expect(
      service.list(TENANT, USER, { branchId: BRANCH } as any),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });

    expect(entries.find).not.toHaveBeenCalled();
  });

  it('scopes the read to (tenant, branch, business_date) and orders the result (regression for the calledById column drift)', async () => {
    branches.findOne.mockResolvedValueOnce({
      id: BRANCH,
      timezone: 'Asia/Riyadh',
    });
    branchUsers.find.mockResolvedValueOnce([]); // tenant-wide caller — no branch restriction

    const appointment = {
      id: 'appt-1',
      start_at: new Date('2032-04-14T09:00:00Z'),
      status: AppointmentStatus.CONFIRMED,
      payment_status: AppointmentPaymentStatus.PAID,
    };
    entries.find.mockResolvedValueOnce([
      {
        id: 'qe-1',
        state: QueueState.WAITING,
        arrived_at: new Date('2032-04-14T08:55:00Z'),
        appointment,
        customer: { id: 'cust-1', full_name: 'Sara' },
        staff: null,
      },
    ]);

    const result = await service.list(TENANT, USER, {
      branchId: BRANCH,
      date: '2032-04-14',
    } as any);

    expect(entries.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenant: { id: TENANT },
          branch: { id: BRANCH },
          business_date: '2032-04-14',
        }),
      }),
    );
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('qe-1');
    expect(result.data[0].position).toBe(1);
  });

  describe('myBranches (FR-Q014)', () => {
    it('returns every tenant branch for a caller with no branch assignment', async () => {
      branchUsers.find.mockResolvedValueOnce([]);
      branches.find.mockResolvedValueOnce([{ id: 'b1' }, { id: 'b2' }]);

      const result = await service.myBranches(TENANT, USER);

      expect(branches.find).toHaveBeenCalledWith({
        where: { tenant: { id: TENANT } },
        order: { created_at: 'ASC' },
      });
      expect(result).toEqual([{ id: 'b1' }, { id: 'b2' }]);
    });

    it('narrows to only the assigned branches for a branch-restricted caller', async () => {
      branchUsers.find.mockResolvedValueOnce([
        { branch: { id: BRANCH } },
      ]);
      branches.find.mockResolvedValueOnce([{ id: BRANCH }]);

      const result = await service.myBranches(TENANT, USER);

      const call = branches.find.mock.calls[0][0];
      expect(call.where.tenant).toEqual({ id: TENANT });
      expect(call.where.id).toMatchObject({ _value: [BRANCH] });
      expect(result).toEqual([{ id: BRANCH }]);
    });
  });
});
