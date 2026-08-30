import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AppointmentAuditService, APPOINTMENT_AUDIT_ACTION } from './appointment-audit.service';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

describe('AppointmentAuditService (T034, FR-G005)', () => {
  let service: AppointmentAuditService;
  let auditLogs: MockRepository;

  beforeEach(async () => {
    auditLogs = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AppointmentAuditService,
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
    await service.record(APPOINTMENT_AUDIT_ACTION.CANCELLED_BY_PATIENT, 't1', 'appt-1', {
      origin: 'PATIENT',
    });
    const created = auditLogs.create.mock.calls[0][0];
    const serialized = JSON.stringify(created);
    expect(serialized).not.toMatch(/token|digest|phone|email/i);
  });

  it('a write failure is swallowed — never propagates', async () => {
    auditLogs.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record(APPOINTMENT_AUDIT_ACTION.CANCELLED_BY_PATIENT, 't1', 'appt-1'),
    ).resolves.toBeUndefined();
  });
});
