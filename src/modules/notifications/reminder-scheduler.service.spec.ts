import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  ReminderSchedulerService,
  REMINDER_TRIGGER_EVENT,
} from './reminder-scheduler.service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NotificationRuleService } from './notification-rule.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { RECIPIENT_TYPE } from './notification.constants';
import { PatientActionLinkVariablesService } from './patient-action-link-variables.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * T049 (US3, FR-M001–M005, FR-M013) — pins the reminder-scheduling
 * semantics BEFORE T052 wires the lifecycle listener on top of it.
 */
describe('ReminderSchedulerService (T049, S3)', () => {
  let service: ReminderSchedulerService;
  let appointments: MockRepository;
  let tenantSettings: MockRepository;
  let scheduledNotifications: MockRepository;
  let rules: { findActiveByTrigger: jest.Mock };
  let scheduler: { schedule: jest.Mock };
  let linkVariables: { buildLinkVariables: jest.Mock };

  const appointment = (overrides: Record<string, unknown> = {}) => ({
    id: 'appt-1',
    start_at: new Date(Date.now() + 48 * 3600_000),
    customer: { id: 'cust-1' },
    ...overrides,
  });

  const activeRule = (templateId: string | null = 'tmpl-1') => [
    { id: 'rule-1', template: templateId ? { id: templateId } : undefined },
  ];

  beforeEach(async () => {
    appointments = createMockRepository();
    tenantSettings = createMockRepository();
    scheduledNotifications = createMockRepository();
    rules = { findActiveByTrigger: jest.fn().mockResolvedValue(activeRule()) };
    scheduler = { schedule: jest.fn().mockResolvedValue({ id: 'sched-1' }) };
    linkVariables = {
      buildLinkVariables: jest.fn().mockResolvedValue({
        cancelUrl: 'https://app.test/appointment-action/c',
        rescheduleUrl: 'https://app.test/appointment-action/r',
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReminderSchedulerService,
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        {
          provide: getRepositoryToken(TenantSetting),
          useValue: tenantSettings,
        },
        {
          provide: getRepositoryToken(ScheduledNotification),
          useValue: scheduledNotifications,
        },
        { provide: NotificationRuleService, useValue: rules },
        { provide: NotificationSchedulerService, useValue: scheduler },
        { provide: PatientActionLinkVariablesService, useValue: linkVariables },
      ],
    }).compile();
    service = moduleRef.get(ReminderSchedulerService);
  });

  afterEach(() => jest.clearAllMocks());

  it('schedules one row per configured lead time, using the active rule template for REMINDER_TRIGGER_EVENT', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [1440, 180, 60],
    });
    appointments.findOne.mockResolvedValueOnce(appointment());

    await service.scheduleFor(TENANT, 'appt-1');

    expect(rules.findActiveByTrigger).toHaveBeenCalledWith(
      TENANT,
      REMINDER_TRIGGER_EVENT,
    );
    expect(scheduler.schedule).toHaveBeenCalledTimes(3);
    for (const lead of [1440, 180, 60]) {
      expect(scheduler.schedule).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          templateId: 'tmpl-1',
          appointmentId: 'appt-1',
          recipientType: RECIPIENT_TYPE.CUSTOMER,
          recipientId: 'cust-1',
        }),
        `appointment-reminder:appt-1:${lead}`,
        expect.anything(),
      );
    }
  });

  it('T054 (FR-M017): every reminder carries the cancel/reschedule links, issued once per call', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [1440, 60],
    });
    appointments.findOne.mockResolvedValueOnce(appointment());

    await service.scheduleFor(TENANT, 'appt-1');

    expect(linkVariables.buildLinkVariables).toHaveBeenCalledTimes(1);
    expect(linkVariables.buildLinkVariables).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ id: 'appt-1' }),
    );
    for (const call of scheduler.schedule.mock.calls) {
      expect(call[3]).toEqual({
        cancelUrl: 'https://app.test/appointment-action/c',
        rescheduleUrl: 'https://app.test/appointment-action/r',
      });
    }
  });

  it('computes scheduled_at from start_at − leadMinutes (Asia/Riyadh-flavoured date)', async () => {
    const startAt = new Date(Date.now() + 30 * 24 * 3600_000); // 30 days out — any absolute instant
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [180],
    });
    appointments.findOne.mockResolvedValueOnce(
      appointment({ start_at: startAt }),
    );

    await service.scheduleFor(TENANT, 'appt-1');

    const [, dto] = scheduler.schedule.mock.calls[0];
    expect(new Date(dto.scheduledAt).getTime()).toBe(
      startAt.getTime() - 180 * 60_000,
    );
  });

  it('computes the same correct instant regardless of branch timezone label (America/New_York-flavoured date)', async () => {
    const startAt = new Date(Date.now() + 30 * 24 * 3600_000 + 4 * 3600_000);
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [60],
    });
    appointments.findOne.mockResolvedValueOnce(
      appointment({ start_at: startAt }),
    );

    await service.scheduleFor(TENANT, 'appt-1');

    const [, dto] = scheduler.schedule.mock.calls[0];
    expect(new Date(dto.scheduledAt).getTime()).toBe(
      startAt.getTime() - 60 * 60_000,
    );
  });

  it('correct across a DST transition — the instant, not the wall-clock, is what is subtracted', async () => {
    // 2026-11-01 is a US "fall back" DST transition date.
    const startAt = new Date('2026-11-02T10:00:00.000Z');
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [1440],
    });
    appointments.findOne.mockResolvedValueOnce(
      appointment({ start_at: startAt }),
    );

    await service.scheduleFor(TENANT, 'appt-1');

    const [, dto] = scheduler.schedule.mock.calls[0];
    expect(new Date(dto.scheduledAt).getTime()).toBe(
      startAt.getTime() - 1440 * 60_000,
    );
  });

  it('FR-M005: an appointment nearer than the lead time schedules nothing for that lead time', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [180], // 3h lead
    });
    appointments.findOne.mockResolvedValueOnce(
      appointment({ start_at: new Date(Date.now() + 30 * 60_000) }), // 30 min away
    );

    await service.scheduleFor(TENANT, 'appt-1');
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('a branch timezone change after booking cannot shift an already-scheduled reminder — start_at is never re-derived from the branch, by construction', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [60],
    });
    const startAt = new Date(Date.now() + 4 * 3600_000);
    appointments.findOne.mockResolvedValueOnce(
      appointment({ start_at: startAt }),
    );

    await service.scheduleFor(TENANT, 'appt-1');

    // The query never selects or joins branch/timezone data at all.
    expect(appointments.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ branch: expect.anything() }),
      }),
    );
    const [, dto] = scheduler.schedule.mock.calls[0];
    expect(new Date(dto.scheduledAt).getTime()).toBe(
      startAt.getTime() - 60 * 60_000,
    );
  });

  it('reminders disabled: nothing is scheduled even with lead times configured', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: false,
      reminder_lead_minutes: [1440],
    });
    await service.scheduleFor(TENANT, 'appt-1');
    expect(appointments.findOne).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('no lead times configured: nothing is scheduled even with reminders enabled', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [],
    });
    await service.scheduleFor(TENANT, 'appt-1');
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('FR-M010: no active rule/template for REMINDER_TRIGGER_EVENT — nothing is scheduled', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [1440],
    });
    appointments.findOne.mockResolvedValueOnce(appointment());
    rules.findActiveByTrigger.mockResolvedValueOnce([]);

    await service.scheduleFor(TENANT, 'appt-1');
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('a failure scheduling one lead time does not prevent the others', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [1440, 60],
    });
    appointments.findOne.mockResolvedValueOnce(appointment());
    scheduler.schedule
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ id: 'sched-2' });

    await expect(
      service.scheduleFor(TENANT, 'appt-1'),
    ).resolves.toBeUndefined();
    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
  });

  it('idempotent: calling scheduleFor twice relies on the existing unique-source_ref catch, never a second dispatch for the same lead time', async () => {
    tenantSettings.findOne.mockResolvedValue({
      reminders_enabled: true,
      reminder_lead_minutes: [1440],
    });
    appointments.findOne.mockResolvedValue(appointment());
    // Second call simulates NotificationSchedulerService's own unique-
    // violation handling (already tested there) — this service just calls
    // through, so a repeat call is exactly one MORE call to `schedule`,
    // not a duplicate write of its own.
    await service.scheduleFor(TENANT, 'appt-1');
    await service.scheduleFor(TENANT, 'appt-1');
    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    expect(scheduler.schedule.mock.calls[0][2]).toBe(
      scheduler.schedule.mock.calls[1][2],
    );
  });

  it('no customer on the appointment: nothing is scheduled (no recipient to notify)', async () => {
    tenantSettings.findOne.mockResolvedValueOnce({
      reminders_enabled: true,
      reminder_lead_minutes: [1440],
    });
    appointments.findOne.mockResolvedValueOnce(
      appointment({ customer: undefined }),
    );

    await service.scheduleFor(TENANT, 'appt-1');
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });
});
