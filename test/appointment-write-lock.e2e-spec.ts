/**
 * CR-39 - appointment writes take the row lock BEFORE they read.
 *
 * `cancel`, `reschedule`, `update` and the payment-outcome path all read the appointment, mutate
 * it and `save()` it, and `save()` rewrites every column that differs from what was read. Without
 * a lock a payment outcome that read PENDING_PAYMENT could commit CONFIRMED over a cancellation
 * that committed in between (and a cancel's stale copy could reset a PAID booking to unpaid).
 *
 * Deterministic, no timing luck: a second connection holds the row lock; the service call must
 * BLOCK on it, and once the other transaction commits a CANCELLED status the service must act on
 * that committed state rather than on a stale read.
 */
import { randomUUID } from 'node:crypto';

import { createE2eApp, createOwnerFixture, type E2eApp, type OwnerFixture } from './utils/whatsapp-e2e-app';
import { AppointmentsService } from '../src/modules/appointment/appointment.service';
import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Customer } from '../src/entities/CRM/Customer';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { AppointmentPaymentStatus, AppointmentStatus } from '../src/entities/enums';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Appointment writes serialise on the row lock (CR-39)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let appointmentId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'aptlock');
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
        phone: `+9665${suffix.slice(0, 8)}`,
        email: `patient-${suffix}@example.test`,
      }),
    );
    const start = new Date('2032-06-16T10:00:00.000Z');
    const apt = await ds.getRepository(Appointment).save(
      ds.getRepository(Appointment).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        customer: { id: customer.id } as Customer,
        start_at: start,
        end_at: new Date(start.getTime() + 30 * 60_000),
        status: AppointmentStatus.PENDING_PAYMENT,
        payment_status: AppointmentPaymentStatus.UNPAID,
      } as Partial<Appointment>),
    );
    appointmentId = apt.id;
  }, 120_000);

  afterAll(async () => {
    await e2e.app.close();
  }, 30_000);

  it('a payment outcome blocks behind a concurrent writer and then acts on its COMMITTED state', async () => {
    const ds = e2e.dataSource;
    const service = e2e.app.get(AppointmentsService);

    // A second connection - the "cancel" - takes the row lock and holds it.
    const other = ds.createQueryRunner();
    await other.connect();
    await other.startTransaction();
    await other.query('SELECT id FROM appointments WHERE id = $1 FOR UPDATE', [appointmentId]);

    let settled = false;
    const outcome = service
      .applyPaymentOutcome(owner.tenantId, appointmentId, 'paid')
      .finally(() => {
        settled = true;
      });

    // Without the lock the service would read PENDING_PAYMENT immediately and finish.
    await sleep(750);
    expect(settled).toBe(false);

    // The other writer cancels and commits.
    await other.query(`UPDATE appointments SET status = 'CANCELLED' WHERE id = $1`, [appointmentId]);
    await other.commitTransaction();
    await other.release();

    // D-2: a payment that lands on a booking that was cancelled meanwhile never revives it and never
    // marks it paid. The service reports `booking_closed` so the caller raises a reconciliation
    // exception for a person (the Payment row is what records that money moved).
    await expect(outcome).resolves.toBe('booking_closed');

    const row = await ds.getRepository(Appointment).findOneByOrFail({ id: appointmentId });
    // Acting on the COMMITTED state: a stale PENDING_PAYMENT read would have saved CONFIRMED + PAID
    // over the committed cancellation.
    expect(row.status).toBe(AppointmentStatus.CANCELLED);
    expect(row.payment_status).toBe(AppointmentPaymentStatus.UNPAID);
  }, 60_000);
});
