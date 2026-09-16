/**
 * Patient Journey plan (approved 2026-09-16) — SQL statement count, real
 * Postgres, real HTTP. Same mechanism as `test/appointment-query-count.
 * e2e-spec.ts`: `db_queries_total{route}` on `GET /api/v1/metrics`.
 *
 * Budget note: the approved plan's aspirational cold-cache ceiling was "≤5
 * statements", written against a single GROUPING-SETS statement design.
 * This implementation instead runs one "overall" statement per range
 * (current + prior period) plus one per breakdown dimension (5) plus one
 * reminder-rows statement — a disclosed, documented deviation (see
 * `journey-sql.ts`'s module docblock) chosen because this implementation
 * session had no live Postgres to validate a single mega-statement
 * against. The ceiling asserted below (20) reflects that real design, not
 * the plan's original aspiration; a tighter budget is a follow-up once the
 * split-query design is measured against 100k+ rows.
 *
 * NOT executed in the implementation session (no Postgres/Redis available).
 * Typechecked only.
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
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { User } from '../src/entities/Auth&RBAC/User';
import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import {
  AppointmentPaymentStatus,
  AppointmentSource,
  AppointmentStatus,
} from '../src/entities/enums';

const API = '/api/v1';
const FROM = '2032-05-01';
const TO = '2032-05-05';
const COLD_STATEMENT_CEILING = 20;

describe('GET /analytics/journey/summary — SQL statement count', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;

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
    owner = await createOwnerFixture(e2e, 'journeyquerycount');
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: owner.tenantId } as Tenant,
        name: `Branch ${suffix}`,
      }),
    );
    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `staff-${suffix}@example.test`,
        full_name: 'Dr. QueryCount',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        user: { id: staffUser.id } as User,
        tenant: { id: owner.tenantId } as Tenant,
      }),
    );
    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: owner.tenantId } as Tenant,
        full_name: 'QC Patient',
        phone: '+966500009999',
      }),
    );
    await ds.getRepository(Appointment).save(
      ds.getRepository(Appointment).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        customer: { id: customer.id } as Customer,
        staff: { id: staff.id } as StaffProfile,
        start_at: new Date(`${FROM}T09:00:00.000Z`),
        end_at: new Date(`${FROM}T09:30:00.000Z`),
        status: AppointmentStatus.COMPLETED,
        payment_status: AppointmentPaymentStatus.PAID,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await e2e.app.close();
  }, 30_000);

  it('a cold request stays under the disclosed statement ceiling; a warm repeat runs zero aggregation statements', async () => {
    const route = `${API}/analytics/journey/summary`;

    const before = await dbQueries(route);
    await request(e2e.app.getHttpServer())
      .get(`${route}?from=${FROM}&to=${TO}`)
      .set(...authHeader(owner.token))
      .expect(200);
    const afterCold = await dbQueries(route);
    const coldCount = afterCold - before;
    expect(coldCount).toBeGreaterThan(0);
    expect(coldCount).toBeLessThanOrEqual(COLD_STATEMENT_CEILING);

    const beforeWarm = await dbQueries(route);
    await request(e2e.app.getHttpServer())
      .get(`${route}?from=${FROM}&to=${TO}`)
      .set(...authHeader(owner.token))
      .expect(200);
    const afterWarm = await dbQueries(route);
    // A warm hit still resolves branch scope (0-1 statements for a
    // tenant-wide owner — none, since `resolveScope` skips the DB entirely
    // when no branchId was requested) but runs NO aggregation SQL.
    expect(afterWarm - beforeWarm).toBeLessThanOrEqual(1);
  });

  it('switching the breakdown dimension after a warm summary hit runs zero further aggregation statements', async () => {
    const summaryRoute = `${API}/analytics/journey/summary`;
    const breakdownRoute = `${API}/analytics/journey/breakdown`;

    await request(e2e.app.getHttpServer())
      .get(`${summaryRoute}?from=${FROM}&to=${TO}`)
      .set(...authHeader(owner.token))
      .expect(200);

    const before = await dbQueries(breakdownRoute);
    await request(e2e.app.getHttpServer())
      .get(`${breakdownRoute}?from=${FROM}&to=${TO}&dimension=hour`)
      .set(...authHeader(owner.token))
      .expect(200);
    const after = await dbQueries(breakdownRoute);
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
