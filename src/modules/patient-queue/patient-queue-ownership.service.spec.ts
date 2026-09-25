import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';
import { StaffScopeService } from '../../core/staff-scope/staff-scope.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AppRedisService } from '../../queue/app-redis.service';
import { PatientQueueService } from './patient-queue.service';
import { QueueEntry } from '../../entities/Calendar&Appointments/QueueEntry';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { AppointmentsService } from '../appointment/appointment.service';
import { QueueState, AppointmentStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const USER = 'u1';
const BRANCH = 'b1';
const OWN_STAFF = 'staff-own';

const NOT_FOUND = Object.assign(new Error('refused'), {
  code: ErrorCode.NOT_FOUND,
});

/**
 * Provider ownership on the MUTATING queue actions. Before the doctor role
 * gained `appointments.status.update`, every action checked tenant + branch
 * only, never the assigned provider. The decision itself lives in
 * `StaffScopeService.assertMayDriveAppointment` (its own spec); this proves the
 * queue asks it — with the appointment's CURRENT staff, BEFORE the branch rule
 * and BEFORE any state is claimed — and obeys it.
 */
describe('PatientQueueService write actions — provider ownership', () => {
  let service: PatientQueueService;
  let entries: MockRepository;
  let appointmentsRepo: MockRepository;
  let branchUsers: MockRepository;
  let staffScope: {
    resolveOwnStaffId: jest.Mock;
    assertMayDriveAppointment: jest.Mock;
  };
  let changeStatus: jest.Mock;
  let claim: jest.SpyInstance;

  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    branch: { id: BRANCH },
    // The appointment's CURRENT staff is the source of truth. `entry.staff` is
    // a snapshot taken at check-in — deliberately different here.
    appointment: {
      id: 'a1',
      status: AppointmentStatus.CONFIRMED,
      staff: { id: OWN_STAFF },
    },
    staff: { id: 'stale-snapshot-staff' },
    customer: { id: 'c1' },
    ...over,
  });

  beforeEach(async () => {
    entries = createMockRepository();
    appointmentsRepo = createMockRepository();
    branchUsers = createMockRepository();
    staffScope = {
      resolveOwnStaffId: jest.fn(),
      assertMayDriveAppointment: jest.fn().mockResolvedValue(true),
    };
    changeStatus = jest.fn().mockResolvedValue(undefined);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientQueueService,
        { provide: getRepositoryToken(QueueEntry), useValue: entries },
        {
          provide: getRepositoryToken(Appointment),
          useValue: appointmentsRepo,
        },
        {
          provide: getRepositoryToken(Branch),
          useValue: createMockRepository(),
        },
        { provide: getRepositoryToken(BranchUser), useValue: branchUsers },
        { provide: AppointmentsService, useValue: { changeStatus } },
        {
          provide: ActivityAuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
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
        { provide: StaffScopeService, useValue: staffScope },
      ],
    }).compile();
    service = moduleRef.get(PatientQueueService);

    // Tenant-wide branch membership (no rows) unless a test says otherwise.
    branchUsers.find.mockResolvedValue([]);
    claim = jest
      .spyOn(service as never, 'claim' as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, 'reload' as never)
      .mockResolvedValue({ id: 'e1' } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  const TRANSITIONS: Array<[string, (id: string) => Promise<unknown>]> = [
    ['call', (id) => service.call(TENANT, USER, id)],
    ['start', (id) => service.start(TENANT, USER, id)],
    ['complete', (id) => service.complete(TENANT, USER, id)],
    ['skip', (id) => service.skip(TENANT, USER, id)],
    ['recall', (id) => service.recall(TENANT, USER, id)],
    ['noShow', (id) => service.noShow(TENANT, USER, id)],
  ];

  describe.each(TRANSITIONS)('%s', (_name, run) => {
    it('asks the ownership gate with the appointment’s CURRENT staff (not the stale entry.staff snapshot) and the queue’s own not-found message', async () => {
      entries.findOne.mockResolvedValueOnce(entry());

      await run('e1');

      expect(staffScope.assertMayDriveAppointment).toHaveBeenCalledWith(
        TENANT,
        OWN_STAFF,
        'Queue entry not found',
      );
    });

    it('refuses another provider’s entry BEFORE any state is claimed or the appointment driven — a late refusal would already have moved the entry', async () => {
      entries.findOne.mockResolvedValueOnce(entry());
      staffScope.assertMayDriveAppointment.mockRejectedValueOnce(NOT_FOUND);

      await expect(run('e1')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });

      expect(claim).not.toHaveBeenCalled();
      expect(changeStatus).not.toHaveBeenCalled();
    });

    it('checks ownership BEFORE the branch rule, so a foreign entry in a foreign branch is a 404, never a branch-level 403 that confirms it exists', async () => {
      branchUsers.find.mockResolvedValue([
        { branch: { id: 'my-only-branch' } },
      ]);
      entries.findOne.mockResolvedValueOnce(entry({ branch: { id: 'other' } }));
      staffScope.assertMayDriveAppointment.mockRejectedValueOnce(NOT_FOUND);

      await expect(run('e1')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('still enforces the existing branch confinement for a provider who passes the ownership gate', async () => {
      branchUsers.find.mockResolvedValue([
        { branch: { id: 'my-only-branch' } },
      ]);
      entries.findOne.mockResolvedValueOnce(entry({ branch: { id: 'other' } }));

      await expect(run('e1')).rejects.toMatchObject({
        code: ErrorCode.PERMISSION_DENIED,
      });
      expect(claim).not.toHaveBeenCalled();
    });

    it('a missing entry is still the plain NOT_FOUND, and the gate is never consulted', async () => {
      entries.findOne.mockResolvedValueOnce(null);

      await expect(run('nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(staffScope.assertMayDriveAppointment).not.toHaveBeenCalled();
    });

    it('loads the appointment WITH its staff relation — the gate needs the current assignee', async () => {
      entries.findOne.mockResolvedValueOnce(entry());

      await run('e1');

      expect(entries.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          relations: expect.objectContaining({
            appointment: { staff: true },
          }),
        }),
      );
    });
  });

  describe('checkIn', () => {
    const appt = (over: Record<string, unknown> = {}) => ({
      id: 'a1',
      status: AppointmentStatus.CONFIRMED,
      branch: { id: BRANCH, timezone: 'Asia/Riyadh' },
      customer: { id: 'c1' },
      staff: { id: OWN_STAFF, user: { full_name: 'Dr Own' } },
      ...over,
    });

    it('refuses another provider’s appointment with the appointment 404, before any state is inspected or any queue row is written', async () => {
      appointmentsRepo.findOne.mockResolvedValueOnce(appt());
      staffScope.assertMayDriveAppointment.mockRejectedValueOnce(NOT_FOUND);

      await expect(
        service.checkIn(TENANT, USER, { appointmentId: 'a1' } as never),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

      expect(staffScope.assertMayDriveAppointment).toHaveBeenCalledWith(
        TENANT,
        OWN_STAFF,
      );
      expect(entries.save).not.toHaveBeenCalled();
    });

    it('runs the ownership gate before the terminal-status conflict, so a foreign COMPLETED appointment is a 404, not a 409 that confirms it exists', async () => {
      appointmentsRepo.findOne.mockResolvedValueOnce(
        appt({ status: AppointmentStatus.COMPLETED }),
      );
      staffScope.assertMayDriveAppointment.mockRejectedValueOnce(NOT_FOUND);

      await expect(
        service.checkIn(TENANT, USER, { appointmentId: 'a1' } as never),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('a missing appointment is still the plain NOT_FOUND and the gate is not consulted', async () => {
      appointmentsRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.checkIn(TENANT, USER, { appointmentId: 'nope' } as never),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(staffScope.assertMayDriveAppointment).not.toHaveBeenCalled();
    });

    it('a provider passing the gate checks in normally — one WAITING entry keyed to the appointment’s staff', async () => {
      appointmentsRepo.findOne.mockResolvedValueOnce(appt());
      entries.create.mockImplementation((v: unknown) => v);
      entries.save.mockImplementation(async (v: any) => ({
        ...v,
        id: 'e-new',
      }));

      await service.checkIn(TENANT, USER, { appointmentId: 'a1' } as never);

      expect(entries.save).toHaveBeenCalledTimes(1);
      expect(entries.create).toHaveBeenCalledWith(
        expect.objectContaining({
          state: QueueState.WAITING,
          staff: { id: OWN_STAFF },
        }),
      );
    });
  });
});
