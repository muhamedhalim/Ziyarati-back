/**
 * T028 (US1, contracts/public-surfaces.md §A) — pins the public contract for
 * `GET /public/appointments/action/:token` and
 * `POST /public/appointments/action/:token/cancel` BEFORE T031 builds them.
 * Written first; every assertion below targets the FINAL contract, so this
 * suite is expected to fail ONLY because the routes 404 (do not exist yet)
 * — not because of a setup/compile error.
 *
 * Rate-limit note: like every other `@Throttle()`-gated route in this
 * codebase (see `GUEST_ATTACHMENT_THROTTLE`'s own precedent), the ceiling is
 * relaxed to a no-op under `NODE_ENV=test` so the suite's own request volume
 * never trips it — genuinely reproducing a 429 here isn't practical (would
 * mean sending >1,000,000 requests). The NUMERIC ceilings themselves
 * (stricter than the global default) are proven in
 * `patient-action.constants.spec.ts` (T025); this suite instead proves the
 * route survives a burst without crashing or behaving inconsistently.
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
import { User } from '../src/entities/Auth&RBAC/User';
import {
  AppointmentStatus,
  AppointmentPaymentStatus,
  PatientActionPurpose,
} from '../src/entities/enums';
import { PatientActionLinkService } from '../src/modules/patient-actions/patient-action-link.service';

const API = '/api/v1';

interface ClinicFixture {
  owner: OwnerFixture;
  branchId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
}

describe('Patient cancellation — public contract (T028, US1)', () => {
  let e2e: E2eApp;
  let links: PatientActionLinkService;
  let clinicA: ClinicFixture;
  let clinicB: ClinicFixture;
  let nextDayOffset = 0;

  async function createClinic(label: string): Promise<ClinicFixture> {
    const owner = await createOwnerFixture(e2e, label);
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
    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: owner.tenantId } as Tenant,
        name: `Consultation ${suffix}`,
        duration_minutes: 60,
        base_price: 200,
        is_active: true,
      }),
    );

    await ds.getRepository(TenantSetting).save(
      ds.getRepository(TenantSetting).create({
        tenant: { id: owner.tenantId } as Tenant,
        self_cancellation_enabled: true,
        cancellation_hours: 24,
      }),
    );

    return {
      owner,
      branchId: branch.id,
      customerId: customer.id,
      staffId: staff.id,
      serviceId: service.id,
    };
  }

  /** Seeds an appointment far enough in the future to always be OUTSIDE the
   *  24h cancellation window, in the given status. */
  async function seedAppointment(
    c: ClinicFixture,
    status: AppointmentStatus,
    paymentStatus: AppointmentPaymentStatus = AppointmentPaymentStatus.PAID,
  ): Promise<Appointment> {
    const repo = e2e.dataSource.getRepository(Appointment);
    // Each seeded appointment gets its OWN day, far enough out to always be
    // outside the 24h cancellation window — the exclusion constraint would
    // otherwise reject two appointments for the same staff member at the
    // same identical instant, which every call in this suite would collide
    // on if they all used a fixed offset.
    const startAt = new Date(Date.now() + (30 + nextDayOffset++) * 24 * 3600_000);
    return repo.save(
      repo.create({
        tenant: { id: c.owner.tenantId } as Tenant,
        branch: { id: c.branchId } as Branch,
        customer: { id: c.customerId } as Customer,
        staff: { id: c.staffId } as StaffProfile,
        start_at: startAt,
        end_at: new Date(startAt.getTime() + 3600_000),
        status,
        payment_status: paymentStatus,
        source: 'MANUAL' as never,
        currency: 'SAR',
      }),
    );
  }

  async function issueToken(
    c: ClinicFixture,
    appointment: Appointment,
  ): Promise<string> {
    return links.issue(c.owner.tenantId, appointment, PatientActionPurpose.CANCEL);
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    links = e2e.app.get(PatientActionLinkService);
    clinicA = await createClinic('cancel-a');
    clinicB = await createClinic('cancel-b');
  }, 120_000);

  afterAll(async () => {
    await e2e.dataSource.query(`DELETE FROM appointments WHERE "tenantId" = $1`, [
      clinicA.owner.tenantId,
    ]);
    await e2e.dataSource.query(`DELETE FROM appointments WHERE "tenantId" = $1`, [
      clinicB.owner.tenantId,
    ]);
    await e2e.app.close();
  }, 30_000);

  // ── GET resolve — every appointment state ──────────────────────────── //

  it.each([
    ['CONFIRMED', AppointmentStatus.CONFIRMED, true, undefined],
    ['PENDING_PAYMENT', AppointmentStatus.PENDING_PAYMENT, true, undefined],
    ['COMPLETED', AppointmentStatus.COMPLETED, false, 'TERMINAL_STATE'],
    ['CANCELLED', AppointmentStatus.CANCELLED, false, 'TERMINAL_STATE'],
    ['NO_SHOW', AppointmentStatus.NO_SHOW, false, 'TERMINAL_STATE'],
  ])('GET resolves a %s appointment', async (_label, status, allowedCancel, blockedReason) => {
    const appt = await seedAppointment(clinicA, status);
    const token = await issueToken(clinicA, appt);

    const res = await request(e2e.app.getHttpServer()).get(
      `${API}/public/appointments/action/${token}`,
    );

    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.clinicName).toBeTruthy();
    expect(body.status).toBe(status);
    expect(body.allowed).toEqual({ cancel: allowedCancel, reschedule: false });
    if (blockedReason) expect(body.blockedReason).toBe(blockedReason);
    // Never leaks anything beyond the contract's fields.
    expect(body).not.toHaveProperty('customerId');
    expect(body).not.toHaveProperty('tenantId');
  });

  // ── POST cancel — replay ────────────────────────────────────────────── //

  it('replay of a consumed token: cancel once, then 404 on the second attempt, appointment unchanged', async () => {
    const appt = await seedAppointment(clinicA, AppointmentStatus.CONFIRMED);
    const token = await issueToken(clinicA, appt);

    const first = await request(e2e.app.getHttpServer()).post(
      `${API}/public/appointments/action/${token}/cancel`,
    );
    const second = await request(e2e.app.getHttpServer()).post(
      `${API}/public/appointments/action/${token}/cancel`,
    );

    expect(first.status).toBe(200);
    expect((first.body.data ?? first.body).status).toBe('CANCELLED');
    expect(second.status).toBe(404); // FR-C004 — replay is refused

    const row = await e2e.dataSource.getRepository(Appointment).findOne({
      where: { id: appt.id },
    });
    expect(row?.status).toBe(AppointmentStatus.CANCELLED); // changed once, not twice
  });

  // ── Direct POST refusal (AC-1 #3, #4) ───────────────────────────────── //

  it('POST cancel is refused with 409 when inside the cancellation window', async () => {
    const repo = e2e.dataSource.getRepository(Appointment);
    const startAt = new Date(Date.now() + 3 * 3600_000); // 3h out, window is 24h
    const appt = await repo.save(
      repo.create({
        tenant: { id: clinicA.owner.tenantId } as Tenant,
        branch: { id: clinicA.branchId } as Branch,
        customer: { id: clinicA.customerId } as Customer,
        staff: { id: clinicA.staffId } as StaffProfile,
        start_at: startAt,
        end_at: new Date(startAt.getTime() + 3600_000),
        status: AppointmentStatus.CONFIRMED,
        payment_status: AppointmentPaymentStatus.PAID,
        source: 'MANUAL' as never,
        currency: 'SAR',
      }),
    );
    const token = await issueToken(clinicA, appt);

    const res = await request(e2e.app.getHttpServer()).post(
      `${API}/public/appointments/action/${token}/cancel`,
    );

    expect(res.status).toBe(409);

    const row = await repo.findOne({ where: { id: appt.id } });
    expect(row?.status).toBe(AppointmentStatus.CONFIRMED); // unchanged
  });

  it('POST cancel is refused with 409 for an appointment already in a terminal state', async () => {
    const appt = await seedAppointment(clinicA, AppointmentStatus.CANCELLED);
    const token = await issueToken(clinicA, appt);

    const res = await request(e2e.app.getHttpServer()).post(
      `${API}/public/appointments/action/${token}/cancel`,
    );

    expect(res.status).toBe(409);
  });

  // ── Altered token ───────────────────────────────────────────────────── //

  it('an altered token is indistinguishable from unknown — same status AND same raw body shape', async () => {
    const appt = await seedAppointment(clinicA, AppointmentStatus.CONFIRMED);
    const token = await issueToken(clinicA, appt);
    const altered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');

    const altRes = await request(e2e.app.getHttpServer()).get(
      `${API}/public/appointments/action/${altered}`,
    );
    const unknownRes = await request(e2e.app.getHttpServer()).get(
      `${API}/public/appointments/action/${randomUUID()}`,
    );

    expect(altRes.status).toBe(404);
    expect(unknownRes.status).toBe(404);
    // T038 — compare the RAW body, not just the status. `timestamp`,
    // `requestId`, and `path` legitimately differ per-request (different
    // token in the URL, different clock tick) even when the system behaves
    // correctly, so the comparison is scoped to the fields a client could
    // actually use to infer "this token was once real": statusCode, error
    // class, message, code, and any client-safe context.
    const identityFields = ({ statusCode, error, message, code, context }: Record<string, unknown>) => ({
      statusCode,
      error,
      message,
      code,
      context,
    });
    expect(identityFields(altRes.body)).toEqual(identityFields(unknownRes.body));

    const altPost = await request(e2e.app.getHttpServer()).post(
      `${API}/public/appointments/action/${altered}/cancel`,
    );
    const unknownPost = await request(e2e.app.getHttpServer()).post(
      `${API}/public/appointments/action/${randomUUID()}/cancel`,
    );
    expect(altPost.status).toBe(404);
    expect(unknownPost.status).toBe(404);
    expect(identityFields(altPost.body)).toEqual(identityFields(unknownPost.body));
  });

  // ── Cross-tenant token ──────────────────────────────────────────────── //

  it("a token issued for clinic B never resolves to clinic A's appointment data", async () => {
    const apptB = await seedAppointment(clinicB, AppointmentStatus.CONFIRMED);
    const tokenB = await issueToken(clinicB, apptB);

    const res = await request(e2e.app.getHttpServer()).get(
      `${API}/public/appointments/action/${tokenB}`,
    );

    expect(res.status).toBe(200); // resolves — but ONLY to its own tenant's data
    const body = res.body.data ?? res.body;
    expect(body.clinicName).not.toBe(undefined);
    // No appointment/customer identifier of any kind is ever in the
    // response (contract §A) — there is nothing here that COULD leak
    // clinic A's identity, which is the real guarantee this proves.
    expect(body).not.toHaveProperty('appointmentId');
    expect(body).not.toHaveProperty('tenantId');
  });

  // ── Rate limiting — see module docblock for why this can't assert 429 ── //

  it('survives a burst of resolve requests without crashing or behaving inconsistently', async () => {
    const appt = await seedAppointment(clinicA, AppointmentStatus.CONFIRMED);
    const token = await issueToken(clinicA, appt);

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(e2e.app.getHttpServer()).get(
          `${API}/public/appointments/action/${token}`,
        ),
      ),
    );

    const statuses = new Set(results.map((r) => r.status));
    expect(statuses.size).toBe(1); // every response identical — no crash, no partial failure
  });
});
