import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PatientRescheduleService } from './patient-reschedule.service';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AppointmentsService } from '../appointment/appointment.service';
import { AppointmentAuditService } from '../appointment/appointment-audit.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { PatientActionLinkService } from './patient-action-link.service';
import { PatientChangeWindowService } from './patient-change-window.service';
import { AppointmentActionOrigin } from '../../entities/enums';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * T041 (US2, FR-R001–R015) — the delegate-not-duplicate reschedule flow,
 * mirroring `patient-cancellation.service.spec.ts`'s shape for the sibling
 * action.
 */
describe('PatientRescheduleService', () => {
  let service: PatientRescheduleService;
  let tenantSettings: MockRepository;
  let appointments: { reschedule: jest.Mock };
  let availability: { publicWindows: jest.Mock };
  let links: { consume: jest.Mock };
  let appointmentAudit: { record: jest.Mock };

  const linkFor = (appointmentOverrides: Record<string, unknown> = {}) =>
    ({
      id: 'link-1',
      appointment: {
        id: 'appt-1',
        start_at: new Date(Date.now() + 48 * 3600_000),
        end_at: new Date(Date.now() + 49 * 3600_000),
        branch: { id: 'branch-1' },
        staff: { id: 'staff-1' },
        ...appointmentOverrides,
      },
    }) as any;

  beforeEach(async () => {
    tenantSettings = createMockRepository();
    tenantSettings.findOne.mockResolvedValue({
      self_reschedule_enabled: true,
      cancellation_hours: 24,
    });
    appointments = {
      reschedule: jest.fn().mockResolvedValue({
        id: 'appt-1',
        status: 'CONFIRMED',
        start_at: new Date(),
      }),
    };
    availability = {
      publicWindows: jest
        .fn()
        .mockResolvedValue({ timezone: 'UTC', windows: [] }),
    };
    links = { consume: jest.fn().mockResolvedValue(1) };
    appointmentAudit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientRescheduleService,
        PatientChangeWindowService,
        {
          provide: getRepositoryToken(TenantSetting),
          useValue: tenantSettings,
        },
        { provide: AppointmentsService, useValue: appointments },
        { provide: AvailabilityService, useValue: availability },
        { provide: PatientActionLinkService, useValue: links },
        { provide: AppointmentAuditService, useValue: appointmentAudit },
      ],
    }).compile();
    service = moduleRef.get(PatientRescheduleService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── describeRescheduleEligibility ───────────────────────────────────── //

  it('DISABLED_BY_CLINIC when self-reschedule is off', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      self_reschedule_enabled: false,
      cancellation_hours: 24,
    });
    const res = await service.describeRescheduleEligibility(TENANT, {
      status: 'CONFIRMED' as any,
      start_at: new Date(Date.now() + 48 * 3600_000),
    });
    expect(res).toEqual({
      allowed: false,
      blockedReason: 'DISABLED_BY_CLINIC',
    });
  });

  it('TERMINAL_STATE for a cancelled appointment', async () => {
    const res = await service.describeRescheduleEligibility(TENANT, {
      status: 'CANCELLED' as any,
      start_at: new Date(Date.now() + 48 * 3600_000),
    });
    expect(res).toEqual({ allowed: false, blockedReason: 'TERMINAL_STATE' });
  });

  it('WINDOW_CLOSED inside the change window', async () => {
    const res = await service.describeRescheduleEligibility(TENANT, {
      status: 'CONFIRMED' as any,
      start_at: new Date(Date.now() + 2 * 3600_000),
    });
    expect(res).toEqual({ allowed: false, blockedReason: 'WINDOW_CLOSED' });
  });

  it('allowed=true outside the window with self-reschedule on', async () => {
    const res = await service.describeRescheduleEligibility(TENANT, {
      status: 'CONFIRMED' as any,
      start_at: new Date(Date.now() + 48 * 3600_000),
    });
    expect(res).toEqual({ allowed: true });
  });

  // ── getAvailability ─────────────────────────────────────────────────── //

  it('delegates to AvailabilityService.publicWindows using the EXISTING branch/staff and the service duration', async () => {
    const appt = linkFor().appointment;
    await service.getAvailability(TENANT, appt, '2031-01-01', '2031-01-05');
    expect(availability.publicWindows).toHaveBeenCalledWith(TENANT, {
      branchId: 'branch-1',
      staffId: 'staff-1',
      fromDate: '2031-01-01',
      toDate: '2031-01-05',
      slotMinutes: 60,
      notBefore: expect.any(Date),
    });
  });

  it('never offers a slot that has already started (passes "now" as the floor)', async () => {
    const before = Date.now();
    await service.getAvailability(
      TENANT,
      linkFor().appointment,
      '2031-01-01',
      '2031-01-05',
    );
    const { notBefore } = availability.publicWindows.mock.calls[0][1];
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(before);
    expect(notBefore.getTime()).toBeLessThanOrEqual(Date.now());
  });

  // ── rescheduleViaLink ────────────────────────────────────────────────── //

  it('delegates the write to AppointmentsService.reschedule — no userId, origin=PATIENT, no scheduling logic here', async () => {
    await service.rescheduleViaLink(
      TENANT,
      linkFor(),
      '2031-02-01T10:00:00.000Z',
    );
    expect(appointments.reschedule).toHaveBeenCalledWith(
      TENANT,
      null,
      'appt-1',
      { newStartAt: '2031-02-01T10:00:00.000Z' },
      AppointmentActionOrigin.PATIENT,
    );
  });

  it('consumes the link after a successful reschedule', async () => {
    await service.rescheduleViaLink(
      TENANT,
      linkFor(),
      '2031-02-01T10:00:00.000Z',
    );
    expect(links.consume).toHaveBeenCalledWith('link-1');
  });

  it('T045: audits with the appointment id, PATIENT origin, and previous/new times — no token/contact detail', async () => {
    await service.rescheduleViaLink(
      TENANT,
      linkFor(),
      '2031-02-01T10:00:00.000Z',
    );
    expect(appointmentAudit.record).toHaveBeenCalledWith(
      'appointment.rescheduled_by_patient',
      TENANT,
      'appt-1',
      expect.objectContaining({ origin: AppointmentActionOrigin.PATIENT }),
      // Context arg: branch, so the Activity log can answer "where". Still no
      // actor — a signed link has no authenticated user.
      expect.objectContaining({ branchId: null }),
    );
    const [, , , details] = appointmentAudit.record.mock.calls[0];
    expect(details).toHaveProperty('previousStartAt');
    expect(details).toHaveProperty('newStartAt');
  });

  it.each([
    ['disabled', { self_reschedule_enabled: false, cancellation_hours: 24 }],
    ['never configured', null],
  ])(
    'BUG-03: refuses when the clinic has online rescheduling %s — the write enforces the opt-in, not just the GET',
    async (_label, settings) => {
      tenantSettings.findOne.mockResolvedValue(settings);
      await expect(
        service.rescheduleViaLink(
          TENANT,
          linkFor(),
          '2031-02-01T10:00:00.000Z',
        ),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        publicContext: { blockedReason: 'DISABLED_BY_CLINIC' },
      });
      expect(appointments.reschedule).not.toHaveBeenCalled();
      expect(links.consume).not.toHaveBeenCalled();
    },
  );

  it('refuses when the change window is closed — AppointmentsService.reschedule is never reached', async () => {
    const nearLink = linkFor({ start_at: new Date(Date.now() + 3600_000) }); // 1h away, inside 24h window
    await expect(
      service.rescheduleViaLink(TENANT, nearLink, '2031-02-01T10:00:00.000Z'),
    ).rejects.toMatchObject({
      publicContext: { blockedReason: 'WINDOW_CLOSED' },
    });
    expect(appointments.reschedule).not.toHaveBeenCalled();
    expect(links.consume).not.toHaveBeenCalled();
  });
});
