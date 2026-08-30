import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PatientCancellationService } from './patient-cancellation.service';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AppointmentsService } from '../appointment/appointment.service';
import { AppointmentAuditService } from '../appointment/appointment-audit.service';
import { PatientActionLinkService } from './patient-action-link.service';
import { PaymentLinkService } from '../payments/payment-link.service';
import { PatientChangeWindowService } from './patient-change-window.service';
import { ErrorCode } from '../../common/errors';
import { AppointmentActionOrigin } from '../../entities/enums';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * T027 (US1, FR-C007) — pins the cancellation-window semantics BEFORE T029
 * implements them. Written first; must fail (module not found) until
 * `PatientCancellationService` exists.
 */
describe('PatientCancellationService — cancellation window (T027, FR-C007)', () => {
  let service: PatientCancellationService;
  let tenantSettings: MockRepository;
  let appointments: { cancel: jest.Mock };
  let links: { consume: jest.Mock };
  let paymentLinks: { disable: jest.Mock; findActiveForAppointment: jest.Mock };
  let appointmentAudit: { record: jest.Mock };

  beforeEach(async () => {
    tenantSettings = createMockRepository();
    appointments = { cancel: jest.fn() };
    links = { consume: jest.fn() };
    paymentLinks = { disable: jest.fn(), findActiveForAppointment: jest.fn().mockResolvedValue([]) };
    appointmentAudit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientCancellationService,
        PatientChangeWindowService,
        { provide: getRepositoryToken(TenantSetting), useValue: tenantSettings },
        { provide: AppointmentsService, useValue: appointments },
        { provide: PatientActionLinkService, useValue: links },
        { provide: PaymentLinkService, useValue: paymentLinks },
        { provide: AppointmentAuditService, useValue: appointmentAudit },
      ],
    }).compile();
    service = moduleRef.get(PatientCancellationService);
  });

  afterEach(() => jest.clearAllMocks());

  it('allows cancellation OUTSIDE the window', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({ cancellation_hours: 24 });
    const startAt = new Date(Date.now() + 48 * 3600_000); // 48h away — outside a 24h window
    await expect(
      service.assertCancellationAllowed(TENANT, startAt),
    ).resolves.toBeUndefined();
  });

  it('refuses cancellation INSIDE the window', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({ cancellation_hours: 24 });
    const startAt = new Date(Date.now() + 2 * 3600_000); // 2h away — inside a 24h window
    await expect(
      service.assertCancellationAllowed(TENANT, startAt),
    ).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      publicContext: { blockedReason: 'WINDOW_CLOSED' },
    });
  });

  it('applies the window IN FORCE AT REQUEST TIME, not at link-issue time', async () => {
    // The clinic tightened its window AFTER the link was issued; the request
    // must be evaluated against the CURRENT setting, not whatever was true
    // when the link was minted (the service has no notion of "issue time"
    // at all — it always reads the live setting, which is the point).
    tenantSettings.findOne.mockResolvedValueOnce({ cancellation_hours: 1 });
    const startAt = new Date(Date.now() + 2 * 3600_000); // 2h away
    // With the CURRENT (tightened) 1h window this is outside it — allowed.
    await expect(
      service.assertCancellationAllowed(TENANT, startAt),
    ).resolves.toBeUndefined();

    tenantSettings.findOne.mockResolvedValueOnce({ cancellation_hours: 6 });
    // Same appointment, window now loosened back to 6h — now inside it.
    await expect(
      service.assertCancellationAllowed(TENANT, startAt),
    ).rejects.toMatchObject({ publicContext: { blockedReason: 'WINDOW_CLOSED' } });
  });

  it('falls back to the 24-hour platform default when the clinic has no settings row', async () => {
    tenantSettings.findOne.mockResolvedValueOnce(null);
    const insideDefault = new Date(Date.now() + 10 * 3600_000); // 10h away
    await expect(
      service.assertCancellationAllowed(TENANT, insideDefault),
    ).rejects.toMatchObject({ publicContext: { blockedReason: 'WINDOW_CLOSED' } });

    tenantSettings.findOne.mockResolvedValueOnce(null);
    const outsideDefault = new Date(Date.now() + 30 * 3600_000); // 30h away
    await expect(
      service.assertCancellationAllowed(TENANT, outsideDefault),
    ).resolves.toBeUndefined();
  });
});

/**
 * T029/T030 (US1, FR-C013, FR-C014) — the full delegate-not-duplicate flow,
 * and the two payment-safety cases: a paid appointment moves no money, an
 * unpaid appointment's active payment link is closed.
 */
describe('PatientCancellationService.cancelViaLink (T029/T030)', () => {
  let service: PatientCancellationService;
  let tenantSettings: MockRepository;
  let appointments: { cancel: jest.Mock };
  let links: { consume: jest.Mock };
  let paymentLinks: { disable: jest.Mock; findActiveForAppointment: jest.Mock };
  let appointmentAudit: { record: jest.Mock };

  const linkFor = (appointmentOverrides: Record<string, unknown> = {}) =>
    ({
      id: 'link-1',
      appointment: {
        id: 'appt-1',
        start_at: new Date(Date.now() + 48 * 3600_000),
        ...appointmentOverrides,
      },
    }) as any;

  beforeEach(async () => {
    tenantSettings = createMockRepository();
    tenantSettings.findOne.mockResolvedValue({ cancellation_hours: 24 });
    appointments = { cancel: jest.fn().mockResolvedValue({ id: 'appt-1', status: 'CANCELLED' }) };
    links = { consume: jest.fn().mockResolvedValue(1) };
    paymentLinks = { disable: jest.fn(), findActiveForAppointment: jest.fn().mockResolvedValue([]) };
    appointmentAudit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientCancellationService,
        PatientChangeWindowService,
        { provide: getRepositoryToken(TenantSetting), useValue: tenantSettings },
        { provide: AppointmentsService, useValue: appointments },
        { provide: PatientActionLinkService, useValue: links },
        { provide: PaymentLinkService, useValue: paymentLinks },
        { provide: AppointmentAuditService, useValue: appointmentAudit },
      ],
    }).compile();
    service = moduleRef.get(PatientCancellationService);
  });

  afterEach(() => jest.clearAllMocks());

  it('delegates the write to AppointmentsService.cancel rather than reimplementing it — no userId, origin=PATIENT', async () => {
    await service.cancelViaLink(TENANT, linkFor(), 'change of plans');
    expect(appointments.cancel).toHaveBeenCalledWith(
      TENANT,
      null,
      'appt-1',
      { reason: 'change of plans' },
      AppointmentActionOrigin.PATIENT,
    );
  });

  it('consumes the link after a successful cancellation', async () => {
    await service.cancelViaLink(TENANT, linkFor());
    expect(links.consume).toHaveBeenCalledWith('link-1');
  });

  it('T034: audits the cancellation with the appointment id and PATIENT origin — no token/contact detail', async () => {
    await service.cancelViaLink(TENANT, linkFor());
    expect(appointmentAudit.record).toHaveBeenCalledWith(
      'appointment.cancelled_by_patient',
      TENANT,
      'appt-1',
      { origin: AppointmentActionOrigin.PATIENT },
    );
  });

  it('a PAID appointment: no refundAmount is ever passed — money is never moved', async () => {
    await service.cancelViaLink(TENANT, linkFor());
    const [, , , dto] = appointments.cancel.mock.calls[0];
    expect(dto).not.toHaveProperty('refundAmount');
  });

  it('a PENDING_PAYMENT appointment: its active payment link is disabled and becomes unusable', async () => {
    paymentLinks.findActiveForAppointment.mockResolvedValueOnce([{ id: 'plink-1' }]);
    await service.cancelViaLink(TENANT, linkFor());
    expect(paymentLinks.findActiveForAppointment).toHaveBeenCalledWith(TENANT, 'appt-1');
    expect(paymentLinks.disable).toHaveBeenCalledWith(TENANT, 'plink-1');
  });

  it('no active payment link: disable is never called (nothing to close)', async () => {
    paymentLinks.findActiveForAppointment.mockResolvedValueOnce([]);
    await service.cancelViaLink(TENANT, linkFor());
    expect(paymentLinks.disable).not.toHaveBeenCalled();
  });

  // ── T031: describeCancelEligibility (GET response) ─────────────────
  it('describeCancelEligibility: DISABLED_BY_CLINIC when self-service is off', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      self_cancellation_enabled: false,
      cancellation_hours: 24,
    });
    const res = await service.describeCancelEligibility(TENANT, {
      status: 'CONFIRMED' as any,
      start_at: new Date(Date.now() + 48 * 3600_000),
    });
    expect(res).toEqual({ allowed: false, blockedReason: 'DISABLED_BY_CLINIC' });
  });

  it('describeCancelEligibility: TERMINAL_STATE for a completed appointment', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      self_cancellation_enabled: true,
      cancellation_hours: 24,
    });
    const res = await service.describeCancelEligibility(TENANT, {
      status: 'COMPLETED' as any,
      start_at: new Date(Date.now() - 3600_000),
    });
    expect(res).toEqual({ allowed: false, blockedReason: 'TERMINAL_STATE' });
  });

  it('describeCancelEligibility: PAST for a non-terminal appointment whose time has already passed', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      self_cancellation_enabled: true,
      cancellation_hours: 24,
    });
    const res = await service.describeCancelEligibility(TENANT, {
      status: 'CONFIRMED' as any,
      start_at: new Date(Date.now() - 3600_000),
    });
    expect(res).toEqual({ allowed: false, blockedReason: 'PAST' });
  });

  it('describeCancelEligibility: allowed=true outside the window with self-service on', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      self_cancellation_enabled: true,
      cancellation_hours: 24,
    });
    const res = await service.describeCancelEligibility(TENANT, {
      status: 'CONFIRMED' as any,
      start_at: new Date(Date.now() + 48 * 3600_000),
    });
    expect(res).toEqual({ allowed: true });
  });

  it('refuses when the window is closed — AppointmentsService.cancel is never reached', async () => {
    const nearLink = linkFor({ start_at: new Date(Date.now() + 3600_000) }); // 1h away, inside 24h window
    await expect(service.cancelViaLink(TENANT, nearLink)).rejects.toMatchObject({
      publicContext: { blockedReason: 'WINDOW_CLOSED' },
    });
    expect(appointments.cancel).not.toHaveBeenCalled();
    expect(links.consume).not.toHaveBeenCalled();
  });
});
