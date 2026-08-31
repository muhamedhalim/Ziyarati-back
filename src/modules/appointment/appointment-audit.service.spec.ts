import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  AppointmentAuditService,
  APPOINTMENT_AUDIT_ACTION,
} from './appointment-audit.service';
import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

/**
 * T034 (FR-G005), plus the clinic-wide Activity follow-up.
 *
 * The REAL `ActivityAuditService` is provided (over a mock repository) rather
 * than a stub: the INSERT moved there, so stubbing it would leave the row
 * this service actually writes untested — the assertions below are about the
 * row that reaches the database, which is the only thing the Activity page
 * can ever read.
 */
describe('AppointmentAuditService (T034, FR-G005)', () => {
  let service: AppointmentAuditService;
  let auditLogs: MockRepository;

  beforeEach(async () => {
    auditLogs = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AppointmentAuditService,
        ActivityAuditService,
        { provide: getRepositoryToken(AuditLog), useValue: auditLogs },
      ],
    }).compile();
    service = moduleRef.get(AppointmentAuditService);
  });

  afterEach(() => jest.clearAllMocks());

  it('writes the appointment id and details, no user (no staff actor)', async () => {
    await service.record(
      APPOINTMENT_AUDIT_ACTION.CANCELLED_BY_PATIENT,
      't1',
      'appt-1',
      { origin: 'PATIENT' },
    );
    const created = auditLogs.create.mock.calls[0][0];
    expect(created).toEqual(
      expect.objectContaining({
        action: 'appointment.cancelled_by_patient',
        entity_type: 'Appointment',
        entity_id: 'appt-1',
        new_values: { origin: 'PATIENT' },
      }),
    );
    expect(created.user).toBeUndefined(); // no staff actor
  });

  it('never records a token, digest, or patient contact detail', async () => {
    await service.record(
      APPOINTMENT_AUDIT_ACTION.CANCELLED_BY_PATIENT,
      't1',
      'appt-1',
      {
        origin: 'PATIENT',
      },
    );
    const created = auditLogs.create.mock.calls[0][0];
    const serialized = JSON.stringify(created);
    expect(serialized).not.toMatch(/token|digest|phone|email/i);
  });

  it('a write failure is swallowed — never propagates', async () => {
    auditLogs.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record(
        APPOINTMENT_AUDIT_ACTION.CANCELLED_BY_PATIENT,
        't1',
        'appt-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('records the AUTHENTICATED actor, the branch, and a non-sensitive label', async () => {
    await service.record(
      APPOINTMENT_AUDIT_ACTION.CREATED,
      't1',
      'appt-1',
      { status: 'CONFIRMED' },
      {
        actorUserId: 'receptionist-1',
        branchId: 'branch-1',
        entityLabel: 'Dental cleaning',
      },
    );
    const created = auditLogs.create.mock.calls[0][0];
    expect(created).toEqual(
      expect.objectContaining({
        action: 'appointment.created',
        user: { id: 'receptionist-1' },
        branch: { id: 'branch-1' },
        entity_label: 'Dental cleaning',
      }),
    );
  });

  it('carries `before` for an update action, so changedFields can name what moved', async () => {
    await service.record(
      APPOINTMENT_AUDIT_ACTION.STATUS_CHANGED,
      't1',
      'appt-1',
      { status: 'COMPLETED' },
      { actorUserId: 'u1', before: { status: 'IN_PROGRESS' } },
    );
    const created = auditLogs.create.mock.calls[0][0];
    expect(created.old_values).toEqual({ status: 'IN_PROGRESS' });
    expect(created.new_values).toEqual({ status: 'COMPLETED' });
  });

  it('truncates an over-long label rather than failing the (best-effort) write', async () => {
    await service.record(
      APPOINTMENT_AUDIT_ACTION.CREATED,
      't1',
      'appt-1',
      undefined,
      { entityLabel: 'x'.repeat(500) },
    );
    const created = auditLogs.create.mock.calls[0][0];
    expect(created.entity_label).toHaveLength(160);
  });
});
