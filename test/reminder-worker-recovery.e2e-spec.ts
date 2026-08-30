/**
 * T061 (US3, SC-005) — proves a REMINDER-sourced `ScheduledNotification`
 * row inherits the existing recovery/idempotency machinery unchanged:
 * `ReminderSchedulerService` introduces no new send or recovery code (T051's
 * own requirement), it only creates rows via the UNCHANGED
 * `NotificationSchedulerService.schedule`, so the CLAIM and reap-reclaim
 * conditional UPDATEs — already exhaustively unit-tested generically in
 * `notification-dispatch.service.spec.ts` — must behave identically for a
 * reminder row as for any other. What a mocked-repository unit test cannot
 * prove is that Postgres genuinely serializes a concurrent claim race into
 * exactly one winner (same reasoning as
 * `test/integration/source-ref-idempotency.int-spec.ts`), so that part runs
 * for real here — against the EXACT SQL shape
 * `NotificationDispatchService.processScheduled`/`reapAndRequeue` use for
 * their CLAIM and RECLAIM steps, reproduced directly against the repository
 * rather than through the full service, because this sandbox has no live
 * Redis and both methods' later steps (rate limiting, queue enqueueing) —
 * generic machinery unrelated to reminders specifically, and already proven
 * elsewhere — depend on one.
 */
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { User } from '../src/entities/Auth&RBAC/User';
import { NotificationTemplate } from '../src/entities/Notifications/NotificationTemplate';
import { ScheduledNotification } from '../src/entities/Notifications/ScheduledNotification';
import { AppointmentStatus } from '../src/entities/enums';
import {
  CLAIMABLE_STATUSES,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_STATUS,
  RECIPIENT_TYPE,
} from '../src/modules/notifications/notification.constants';
import { reminderSourceRef } from '../src/modules/notifications/reminder-scheduler.service';

describe('Reminder rows inherit the existing recovery/idempotency machinery (T061, US3)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let customerId: string;
  let templateId: string;
  let appointmentId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'reminder-recovery');
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: owner.tenantId } as Tenant,
        name: `Branch ${suffix}`,
        timezone: 'UTC',
        is_active: true,
      }),
    );
    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: owner.tenantId } as Tenant,
        full_name: `Patient ${suffix}`,
        phone: `+9665${suffix}`,
        email: `patient-${suffix}@example.test`,
      }),
    );
    customerId = customer.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `doctor-${suffix}@example.test`,
        full_name: `Dr ${suffix}`,
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: { id: owner.tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: `Dr ${suffix}`,
        is_available_for_booking: true,
      }),
    );

    const appt = await ds.getRepository(Appointment).save(
      ds.getRepository(Appointment).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        customer: { id: customerId } as Customer,
        staff: { id: staff.id } as StaffProfile,
        start_at: new Date(Date.now() + 48 * 3600_000),
        end_at: new Date(Date.now() + 49 * 3600_000),
        status: AppointmentStatus.CONFIRMED,
        source: 'MANUAL' as never,
        currency: 'SAR',
      }),
    );
    appointmentId = appt.id;

    // EMAIL channel — the test environment's EmailProviderFactory falls back
    // to a simulated success provider (NoopEmailProvider) with no real
    // network call and no external credentials required, same as every
    // other e2e spec that reaches a "successful send".
    const template = await ds.getRepository(NotificationTemplate).save(
      ds.getRepository(NotificationTemplate).create({
        tenant: { id: owner.tenantId } as Tenant,
        name: `Reminder ${suffix}`,
        channel: NOTIFICATION_CHANNEL.EMAIL,
        content_en: 'Reminder: your appointment is coming up.',
        is_active: true,
      }),
    );
    templateId = template.id;
  }, 120_000);

  afterAll(async () => {
    await e2e.dataSource.query(
      `DELETE FROM scheduled_notifications WHERE "tenantId" = $1`,
      [owner.tenantId],
    );
    await e2e.dataSource.query(
      `DELETE FROM appointments WHERE "tenantId" = $1`,
      [owner.tenantId],
    );
    await e2e.app.close();
  }, 30_000);

  async function seedReminderRow(leadMinutes: number): Promise<string> {
    const row = await e2e.dataSource.getRepository(ScheduledNotification).save(
      e2e.dataSource.getRepository(ScheduledNotification).create({
        tenant: { id: owner.tenantId } as Tenant,
        template: { id: templateId } as NotificationTemplate,
        appointment: { id: appointmentId } as Appointment,
        recipient_type: RECIPIENT_TYPE.CUSTOMER,
        recipient_id: customerId,
        scheduled_at: new Date(Date.now() - 1000), // already due
        status: NOTIFICATION_STATUS.SCHEDULED,
        source_ref: reminderSourceRef(appointmentId, leadMinutes),
      }),
    );
    return row.id;
  }

  /** Reproduces `processScheduled`'s step-1 CLAIM query verbatim (same
   *  WHERE/SET shape), against the real repository — the exact seam
   *  `notification-dispatch.service.spec.ts` mocks away. */
  async function claim(id: string) {
    return e2e.dataSource
      .getRepository(ScheduledNotification)
      .createQueryBuilder()
      .update(ScheduledNotification)
      .set({
        status: NOTIFICATION_STATUS.PROCESSING,
        attempts: () => 'attempts + 1',
        processing_at: () => 'now()',
      })
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId: owner.tenantId })
      .andWhere('status IN (:...claimable)', { claimable: CLAIMABLE_STATUSES })
      .execute();
  }

  it('at-most-once: two concurrent claims of the SAME reminder row — Postgres admits exactly one winner', async () => {
    const id = await seedReminderRow(1440);

    const [a, b] = await Promise.all([claim(id), claim(id)]);
    const affected = [a.affected ?? 0, b.affected ?? 0].sort();

    // Exactly one of the two concurrent UPDATEs actually matched a row
    // still in a claimable status — the other's WHERE clause no longer
    // matches because the first has already flipped it to PROCESSING.
    expect(affected).toEqual([0, 1]);

    const row = await e2e.dataSource
      .getRepository(ScheduledNotification)
      .findOne({
        where: { id },
      });
    expect(row?.status).toBe(NOTIFICATION_STATUS.PROCESSING);
    expect(row?.attempts).toBe(1); // not 2 — the loser never touched it
  });

  it('reap sweep reclaims a reminder row stranded in PROCESSING by a crashed/restarted worker', async () => {
    const id = await seedReminderRow(60);

    // Simulate: a worker claimed the row (PROCESSING) but crashed before
    // ever reaching the send-phase guard (send_attempted stays false) —
    // exactly what the reclaim step of `reapAndRequeue` recovers, without a
    // real process restart.
    await e2e.dataSource.getRepository(ScheduledNotification).update(
      { id },
      {
        status: NOTIFICATION_STATUS.PROCESSING,
        processing_at: new Date(Date.now() - 10 * 60_000), // 10 min ago — stale
        send_attempted: false,
      },
    );

    // Reproduces `reapAndRequeue`'s reclaim UPDATE verbatim.
    const staleBefore = new Date(Date.now() - 5 * 60_000); // PROCESSING_STALE_MS
    const reclaim = await e2e.dataSource
      .getRepository(ScheduledNotification)
      .createQueryBuilder()
      .update(ScheduledNotification)
      .set({ status: NOTIFICATION_STATUS.SCHEDULED, processing_at: null })
      .where('status = :proc', { proc: NOTIFICATION_STATUS.PROCESSING })
      .andWhere('processing_at < :staleBefore', { staleBefore })
      .andWhere('send_attempted = :attempted', { attempted: false })
      .andWhere('id = :id', { id })
      .execute();

    expect(reclaim.affected).toBe(1);

    const row = await e2e.dataSource
      .getRepository(ScheduledNotification)
      .findOne({
        where: { id },
      });
    expect(row?.status).toBe(NOTIFICATION_STATUS.SCHEDULED);
    expect(row?.processing_at).toBeNull();

    // Now claimable again — the patient still receives it exactly once,
    // via the SAME CLAIM guarantee proven above.
    const reclaimed = await claim(id);
    expect(reclaimed.affected).toBe(1);
  });
});
