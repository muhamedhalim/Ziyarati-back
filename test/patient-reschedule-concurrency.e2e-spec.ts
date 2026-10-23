/**
 * T039 (US2, SC-003) — pins the concurrency guarantee BEFORE T041/T042
 * build the routes: many patient-initiated reschedule confirmations racing
 * for the SAME practitioner window must admit exactly one winner, with
 * zero overlapping appointments afterwards — the same
 * `appointments_no_overlap` EXCLUSION-constraint guarantee
 * `appointment-availability.e2e-spec.ts` already proves for fresh bookings,
 * now proven for the patient reschedule path. Written first; every request
 * below targets the FINAL contract, so today this suite is expected to
 * fail ONLY because `POST .../reschedule` does not exist yet (404) — not
 * because of a setup/compile error.
 *
 * Real, many-way concurrency (not just two) — AC-2 #6 calls for "1,000
 * simultaneous confirmations"; this suite fires a smaller-but-genuinely-
 * concurrent batch (`CONCURRENCY`) for the same reason the sibling
 * "two simultaneous bookings" test in `appointment-availability.e2e-spec.ts`
 * uses two rather than a thousand: correctness here is guaranteed by a
 * Postgres EXCLUSION constraint, which is deterministic — not probabilistic
 * — so it does not get "more true" at higher N. A thousand real HTTP round
 * trips would add infrastructure load without adding proof.
 */
import request from 'supertest';
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
import { TenantSetting } from '../src/entities/SaaS-Core/TenantSetting';
import { Customer } from '../src/entities/CRM/Customer';
import { Service } from '../src/entities/Services/Service';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { User } from '../src/entities/Auth&RBAC/User';
import { AppointmentStatus, PatientActionPurpose } from '../src/entities/enums';
import { PatientActionLinkService } from '../src/modules/patient-actions/patient-action-link.service';

const API = '/api/v1';
// Below this environment's DB_POOL_MAX (10) — at or above it, connection-
// pool contention (not the exclusion constraint) becomes the bottleneck,
// which would test pool sizing rather than the race this suite targets.
const CONCURRENCY = 5;

/** Far-future Wednesday so nothing collides with other suites; branch is
 *  forced to UTC so wall-clock == stored instant. */
const DAY = '2031-06-11';
const WEDNESDAY = 3;
const at = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

describe('Patient reschedule — concurrency (T039, US2, SC-003)', () => {
  let e2e: E2eApp;
  let links: PatientActionLinkService;
  let owner: OwnerFixture;
  let branchId: string;
  let customerId: string;
  let staffId: string;
  let serviceId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    links = e2e.app.get(PatientActionLinkService);
    owner = await createOwnerFixture(e2e, 'reschedule-race');
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: owner.tenantId } as Tenant,
        name: 'Race Branch',
        timezone: 'UTC',
        is_active: true,
      }),
    );
    branchId = branch.id;

    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: owner.tenantId } as Tenant,
        full_name: 'Race Patient',
        phone: `+9665${suffix}`,
        email: `race-patient-${suffix}@example.test`,
      }),
    );
    customerId = customer.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `race-doctor-${suffix}@example.test`,
        full_name: 'Dr Race',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        public_slug: `stf-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: owner.tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: 'Dr Race',
        is_available_for_booking: true,
      }),
    );
    staffId = staff.id;

    await ds.getRepository(WorkingHour).save(
      ds.getRepository(WorkingHour).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        day_of_week: WEDNESDAY,
        start_time: '09:00',
        end_time: '17:00',
        is_closed: false,
      }),
    );
    await ds.getRepository(StaffSchedule).save(
      ds.getRepository(StaffSchedule).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        staff: { id: staffId } as StaffProfile,
        day_of_week: WEDNESDAY,
        start_time: '09:00',
        end_time: '17:00',
        is_active: true,
      }),
    );

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: owner.tenantId } as Tenant,
        name: 'Race Consultation',
        duration_minutes: 60,
        base_price: 200,
        is_active: true,
      }),
    );
    serviceId = service.id;

    await ds.getRepository(TenantSetting).save(
      ds.getRepository(TenantSetting).create({
        tenant: { id: owner.tenantId } as Tenant,
        self_reschedule_enabled: true,
        cancellation_hours: 1, // race appointments are seeded far outside this
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await e2e.dataSource.query(`DELETE FROM appointments WHERE "tenantId" = $1`, [
      owner.tenantId,
    ]);
    await e2e.app.close();
  }, 30_000);

  it('CONCURRENCY distinct appointments racing to reschedule into the SAME window: exactly one wins, zero overlaps', async () => {
    const ds = e2e.dataSource;
    const apptRepo = ds.getRepository(Appointment);

    // Each racer starts life at its OWN distinct original time (so seeding
    // them doesn't itself collide on `appointments_no_overlap`), then all
    // CONCURRENTLY attempt to move to the exact same target window.
    const tokens: string[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const originalStart = new Date(`${DAY}T${String(9 + i).padStart(2, '0')}:00:00.000Z`);
      const appt = await apptRepo.save(
        apptRepo.create({
          tenant: { id: owner.tenantId } as Tenant,
          branch: { id: branchId } as Branch,
          customer: { id: customerId } as Customer,
          staff: { id: staffId } as StaffProfile,
          start_at: originalStart,
          end_at: new Date(originalStart.getTime() + 3600_000),
          status: AppointmentStatus.CONFIRMED,
          source: 'MANUAL' as never,
          currency: 'SAR',
        }),
      );
      const token = await links.issue(owner.tenantId, appt, PatientActionPurpose.RESCHEDULE);
      tokens.push(token);
    }

    // A window on a DIFFERENT day so it can never collide with any racer's
    // own original slot (which would make "exactly one wins" trivially true
    // for the wrong reason).
    const targetStartAt = '2031-06-18T14:00:00.000Z';

    const results = await Promise.all(
      tokens.map((token) =>
        request(e2e.app.getHttpServer())
          .post(`${API}/public/appointments/action/${token}/reschedule`)
          .send({ startAt: targetStartAt }),
      ),
    );

    const successes = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(CONCURRENCY - 1);

    // Zero overlap: at most one appointment for this staff occupies the
    // target window afterwards.
    const atTarget = await apptRepo
      .createQueryBuilder('a')
      .where('a."tenantId" = :tenantId', { tenantId: owner.tenantId })
      .andWhere('a."staffId" = :staffId', { staffId })
      .andWhere('a.start_at = :start', { start: targetStartAt })
      .getMany();
    expect(atTarget).toHaveLength(1);
  }, 60_000);
});
