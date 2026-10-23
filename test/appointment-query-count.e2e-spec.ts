/**
 * P2 (Phase 6) — per-booking SQL statement count, real Postgres, real HTTP.
 *
 * Answers the question `trace-create.js` answers against the perf-audit
 * stack, but from inside the jest e2e suite against `ziyarati_e2e` — the
 * perf-audit stack's `ziyarati_perf` database is several dozen migrations
 * behind current `head` (confirmed while trying to boot it for this exact
 * measurement) and catching it up is out of scope for this phase, whereas
 * `ziyarati_e2e` is already current. Uses the SAME mechanism trace-create.js
 * does: `db_queries_total{route="/api/v1/appointments"}` on `GET
 * /api/v1/metrics`, which counts every SQL statement that runs inside the
 * request's AsyncLocalStorage context — including the ones
 * `AvailabilityService`'s sibling services run on their OWN pooled
 * connections outside the write transaction (see `typeorm.config.ts`'s own
 * comment on `recordDbQuery`).
 *
 * This file is the BEFORE/AFTER instrument for Phase 6: run once before any
 * P2 code change (baseline) and once after (regression-asserted below).
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { Service } from '../src/entities/Services/Service';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { User } from '../src/entities/Auth&RBAC/User';

const API = '/api/v1';
const DAY = '2032-06-16'; // a Wednesday, far enough out to never collide
const WEDNESDAY = 3;
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const SAMPLES = Number(process.env.QUERY_COUNT_SAMPLES || 5);

interface ClinicFixture {
  owner: OwnerFixture;
  branchId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
}

describe('POST /appointments — per-booking SQL statement count (P2 / Phase 6)', () => {
  let e2e: E2eApp;
  let clinic: ClinicFixture;

  async function createClinic(): Promise<ClinicFixture> {
    const owner = await createOwnerFixture(e2e, 'querycount');
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
        public_slug: `stf-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: owner.tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: `Dr ${suffix}`,
        is_available_for_booking: true,
      }),
    );
    await ds.getRepository(WorkingHour).save(
      ds.getRepository(WorkingHour).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        day_of_week: WEDNESDAY,
        start_time: '09:00',
        end_time: '17:00',
        is_closed: false,
      }),
    );
    await ds.getRepository(StaffSchedule).save(
      ds.getRepository(StaffSchedule).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        staff: { id: staff.id } as StaffProfile,
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
        name: `Consultation ${suffix}`,
        duration_minutes: 30,
        base_price: 150,
        is_active: true,
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

  async function dbQueries(route: string): Promise<number> {
    const res = await request(e2e.app.getHttpServer()).get(`${API}/metrics`);
    let total = 0;
    for (const line of res.text.split('\n')) {
      if (!line.startsWith('db_queries_total{')) continue;
      const m = /^db_queries_total\{route="([^"]*)"\}\s+([0-9.]+)$/.exec(
        line.trim(),
      );
      if (!m || m[1] !== route) continue;
      total += Number(m[2]);
    }
    return total;
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    clinic = await createClinic();
  }, 120_000);

  afterAll(async () => {
    await e2e.app.close();
  }, 30_000);

  it('measures the SQL statement count for SAMPLES successful bookings, minute-apart, non-colliding', async () => {
    const route = `${API}/appointments`;
    const samples: { status: number; queries: number }[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      const start = new Date(at('10:00'));
      start.setUTCDate(start.getUTCDate() + i * 7); // successive Wednesdays
      const before = await dbQueries(route);
      const res = await request(e2e.app.getHttpServer())
        .post(route)
        .set(...authHeader(clinic.owner.token))
        .send({
          branchId: clinic.branchId,
          customerId: clinic.customerId,
          staffId: clinic.staffId,
          serviceIds: [clinic.serviceId],
          startAt: start.toISOString(),
        });
      const after = await dbQueries(route);
      samples.push({ status: res.status, queries: after - before });
    }

    const ok = samples.filter((s) => s.status === 201);
    expect(ok.length).toBe(SAMPLES);

    const sorted = ok.map((s) => s.queries).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    console.log(
      `[P2] POST /appointments SQL statements — samples: ${sorted.join(', ')} — median: ${median}`,
    );

    // Regression ceiling. Measured median before Phase 6 (P2): 46 (5/5
    // samples identical). After threading the already-validated branch/staff
    // rows through to AvailabilityService instead of letting it re-fetch
    // them: 42 (5/5 samples identical) — see
    // tests/load/reports/P2_QUERY_COUNT_REDUCTION.md. A small margin above
    // 42 avoids this failing on an unrelated, deliberate +1 query; update
    // this number only alongside a measured before/after in that report.
    expect(median).toBeLessThanOrEqual(45);
  });

  afterEach(async () => {
    await e2e.dataSource.query(
      `DELETE FROM appointments WHERE "tenantId" = $1`,
      [clinic.owner.tenantId],
    );
  });
});
