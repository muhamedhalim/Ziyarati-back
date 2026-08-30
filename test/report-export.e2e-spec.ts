/**
 * T178 (spec 014, US13, F13) — pins FR-X001, FR-X004 and FR-X005 as real
 * HTTP requests against the REAL AppModule:
 *
 *  1. Row-count and value equivalence — the exported file's data matches
 *     exactly what the on-screen report (`GET /analytics/reports/staff`)
 *     returns for the same filters.
 *  2. Branch scoping is honoured — an export filtered to one branch omits
 *     activity from another branch, exactly like the on-screen report.
 *  3. A caller without `reports.export` is refused (403) — the permission
 *     that has existed, been granted, and been enforced NOWHERE is finally
 *     enforced by this route.
 *  4. A cross-tenant export job id is refused identically (404) to an
 *     unknown one — no enumeration.
 *
 * Red before T181 (ReportExportService) / T184 (ReportExportController)
 * exist.
 */
import request from 'supertest';
import superagent from 'superagent';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

/**
 * The OOXML spreadsheet MIME (`application/vnd.openxmlformats-officedocument
 * .spreadsheetml.sheet`) contains the substring "xml" (inside
 * "openXMLformats"), which trips superagent's naive text-detection heuristic
 * — without this, it silently UTF-8-decodes the binary XLSX bytes into
 * `res.text`, corrupting the zip container. Forcing the raw
 * `application/octet-stream` binary parser is the standard supertest
 * workaround for downloading any binary file whose declared type isn't
 * `application/octet-stream` itself.
 */
const asBinary = <T extends request.Test>(req: T): T =>
  req.buffer(true).parse(superagent.parse['application/octet-stream']) as T;

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceLink } from '../src/entities/Calendar&Appointments/AppointmentService';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { Service } from '../src/entities/Services/Service';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { RolePermission } from '../src/entities/Auth&RBAC/RolePermission';
import { Permission } from '../src/entities/Auth&RBAC/Permission';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { ExportJob } from '../src/entities/System/ExportJob';
import { ExportJobFormat, ExportJobState } from '../src/entities/enums';
import { AppointmentSource, AppointmentStatus } from '../src/entities/enums';
import { PERMISSION } from '../src/rbac/rbac.constants';

const API = '/api/v1';
/** Far-future Wednesday so nothing collides with other suites. */
const DAY = '2031-09-03';

async function parseXlsxRows(
  buffer: Buffer,
): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  const headers = (sheet.getRow(1).values as unknown[])
    .slice(1)
    .map((h) => String(h));
  const rows: Record<string, unknown>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const values = (sheet.getRow(r).values as unknown[]).slice(1);
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => (row[h] = values[i]));
    rows.push(row);
  }
  return rows;
}

describe('Report Export (T178, HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let branchAId: string;
  let branchBId: string;
  let noExportToken: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 't178');
    const ds = e2e.dataSource;
    const tenantId = owner.tenantId;

    const branchA = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Branch A',
        timezone: 'UTC',
        is_active: true,
      }),
    );
    branchAId = branchA.id;
    const branchB = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Branch B',
        timezone: 'UTC',
        is_active: true,
      }),
    );
    branchBId = branchB.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `t178-doctor-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'Dr T178',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: { id: tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: 'Dr T178',
        is_available_for_booking: true,
      }),
    );

    await ds.getRepository(WorkingHour).save(
      ds.getRepository(WorkingHour).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchAId } as Branch,
        day_of_week: 3, // Wednesday
        start_time: '08:00',
        end_time: '20:00',
        is_closed: false,
      }),
    );
    await ds.getRepository(StaffSchedule).save(
      ds.getRepository(StaffSchedule).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchAId } as Branch,
        staff: { id: staff.id } as StaffProfile,
        day_of_week: 3,
        start_time: '08:00',
        end_time: '20:00',
        is_active: true,
      }),
    );

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: tenantId } as Tenant,
        name: 'T178 Consultation',
        duration_minutes: 30,
        base_price: 100,
        is_active: true,
      }),
    );

    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: tenantId } as Tenant,
        full_name: 'T178 Patient',
        phone: '+966511111178',
        email: `t178-patient-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );

    // ONE completed appointment in Branch A — the exactly-one-row fixture
    // both the on-screen report and the export must agree on.
    const appt = await ds.getRepository(Appointment).save(
      ds.getRepository(Appointment).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchAId } as Branch,
        customer: { id: customer.id } as Customer,
        staff: { id: staff.id } as StaffProfile,
        start_at: new Date(`${DAY}T09:00:00.000Z`),
        end_at: new Date(`${DAY}T09:30:00.000Z`),
        status: AppointmentStatus.COMPLETED,
        source: AppointmentSource.MANUAL,
        currency: 'SAR',
      }),
    );
    await ds.getRepository(AppointmentServiceLink).save(
      ds.getRepository(AppointmentServiceLink).create({
        tenant: { id: tenantId } as Tenant,
        appointment: { id: appt.id } as Appointment,
        service: { id: service.id } as Service,
        price: 100,
        duration_minutes: 30,
      }),
    );

    // A second actor holding EVERY analytics/reports permission EXCEPT
    // `reports.export` — proves the permission is actually enforced, not
    // just implied by a broader analytics grant.
    const permissions = ds.getRepository(Permission);
    const roles = ds.getRepository(Role);
    const rolePermissions = ds.getRepository(RolePermission);
    const users = ds.getRepository(User);
    const userRoles = ds.getRepository(UserRole);

    const grantSlugs = [
      PERMISSION.ANALYTICS_REPORTS_READ,
      PERMISSION.ANALYTICS_DASHBOARD_READ,
    ];
    const perms = await permissions
      .createQueryBuilder('p')
      .where('p.slug IN (:...slugs)', { slugs: grantSlugs })
      .getMany();

    const suffix = `t178-noexport-${randomUUID().slice(0, 8)}`;
    const role = await roles.save(
      roles.create({
        tenant: { id: tenantId } as Tenant,
        name: `T178 ${suffix}`,
        slug: suffix,
        is_system: false,
      }),
    );
    await rolePermissions.save(
      perms.map((p) => rolePermissions.create({ role, permission: p })),
    );
    const noExportUser = await users.save(
      users.create({
        tenant: { id: tenantId } as Tenant,
        email: `${suffix}@example.test`,
        full_name: 'T178 No Export',
        is_active: true,
      }),
    );
    await userRoles.save(
      userRoles.create({
        user: { id: noExportUser.id } as User,
        role: { id: role.id } as Role,
      }),
    );
    noExportToken = await e2e.jwt.signAsync(
      { sub: noExportUser.id, tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );
  }, 120_000);

  afterAll(async () => {
    const q = (sql: string) => e2e.dataSource.query(sql, [owner.tenantId]);
    await q(`DELETE FROM export_jobs WHERE "tenantId" = $1`);
    await q(
      `DELETE FROM appointment_services WHERE "appointmentId" IN (SELECT id FROM appointments WHERE "tenantId" = $1)`,
    );
    await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
    await q(`DELETE FROM services WHERE "tenantId" = $1`);
    await q(`DELETE FROM customers WHERE "tenantId" = $1`);
    await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`);
    await q(`DELETE FROM working_hours WHERE "tenantId" = $1`);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
    await q(
      `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
    );
    await q(
      `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
    );
    await q(`DELETE FROM roles WHERE "tenantId" = $1`);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM users WHERE "tenantId" = $1`);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`);
    await q(`DELETE FROM tenants WHERE id = $1`);
    await e2e.app.close();
  }, 60_000);

  describe('FR-X001 — row-count and value equivalence against the on-screen report', () => {
    it('the exported XLSX contains exactly the same row the live report endpoint returns', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(owner.token);
      const from = DAY;
      const to = DAY;

      const live = await request(server)
        .get(`${API}/analytics/reports/staff`)
        .query({ from, to })
        .set(...auth);
      expect(live.status).toBe(200);
      expect(live.body).toHaveLength(1);

      const exported = await asBinary(
        request(server)
          .post(`${API}/reports/export`)
          .set(...auth),
      ).send({ report: 'staff-performance', filters: { from, to } });

      expect(exported.status).toBe(200);
      const rows = await parseXlsxRows(exported.body as Buffer);
      expect(rows).toHaveLength(1);
      expect(rows[0].Staff).toBe(live.body[0].name);
      expect(Number(rows[0]['Total Appointments'])).toBe(
        live.body[0].total_appointments,
      );
    });
  });

  describe('FR-X004 — branch scoping is honoured', () => {
    it('filtering the export to a branch with no activity yields zero rows', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(owner.token);

      const exported = await asBinary(
        request(server)
          .post(`${API}/reports/export`)
          .set(...auth),
      ).send({
        report: 'staff-performance',
        filters: { from: DAY, to: DAY, branchId: branchBId },
      });

      expect(exported.status).toBe(200);
      const rows = await parseXlsxRows(exported.body as Buffer);
      expect(rows).toHaveLength(0);
    });

    it('filtering to the branch WITH activity still returns the one row', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(owner.token);

      const exported = await asBinary(
        request(server)
          .post(`${API}/reports/export`)
          .set(...auth),
      ).send({
        report: 'staff-performance',
        filters: { from: DAY, to: DAY, branchId: branchAId },
      });

      expect(exported.status).toBe(200);
      const rows = await parseXlsxRows(exported.body as Buffer);
      expect(rows).toHaveLength(1);
    });
  });

  describe('FR-X005 — reports.export is enforced', () => {
    it('a caller holding analytics.reports.read but NOT reports.export is refused (403)', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/reports/export`)
        .set(...authHeader(noExportToken))
        .send({ report: 'staff-performance', filters: {} });
      expect(res.status).toBe(403);
    });

    it('the same caller CAN still read the live report — this is an export-specific refusal', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/analytics/reports/staff`)
        .set(...authHeader(noExportToken));
      expect(res.status).toBe(200);
    });
  });

  describe('FR-X011 — a cross-tenant export job id is refused identically to an unknown one', () => {
    let otherTenantId: string;
    let otherJobId: string;

    beforeAll(async () => {
      const otherOwner = await createOwnerFixture(e2e, 't178-other');
      otherTenantId = otherOwner.tenantId;
      const job = await e2e.dataSource.getRepository(ExportJob).save(
        e2e.dataSource.getRepository(ExportJob).create({
          tenant: { id: otherTenantId } as Tenant,
          requestedBy: { id: otherOwner.userId } as User,
          report: 'staff-performance',
          format: ExportJobFormat.XLSX,
          filters: {},
          branch_scope: null,
          state: ExportJobState.READY,
          storage_key: `${otherTenantId}/exports/x.xlsx`,
          row_count: 1,
        }),
      );
      otherJobId = job.id;
    });

    afterAll(async () => {
      const q = (sql: string) => e2e.dataSource.query(sql, [otherTenantId]);
      await q(`DELETE FROM export_jobs WHERE "tenantId" = $1`);
      await q(
        `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      );
      await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM users WHERE "tenantId" = $1`);
      await q(`DELETE FROM tenants WHERE id = $1`);
    });

    it("another tenant's job id returns 404 on status", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/reports/export/${otherJobId}`)
        .set(...authHeader(owner.token));
      expect(res.status).toBe(404);
    });

    it("another tenant's job id returns 404 on download — byte-identical to an unknown id", async () => {
      const known = await request(e2e.app.getHttpServer())
        .get(`${API}/reports/export/${otherJobId}/download`)
        .set(...authHeader(owner.token));
      const unknown = await request(e2e.app.getHttpServer())
        .get(`${API}/reports/export/${randomUUID()}/download`)
        .set(...authHeader(owner.token));

      expect(known.status).toBe(404);
      expect(unknown.status).toBe(404);
      // Byte-identical in the parts that matter — never a signal that
      // distinguishes "a real job belonging to someone else" from "no such
      // job at all". `requestId`/`timestamp`/`path` vary per request by
      // design and are excluded from the comparison.
      expect(known.body.code).toEqual(unknown.body.code);
      expect(known.body.message).toEqual(unknown.body.message);
      expect(known.body.statusCode).toEqual(unknown.body.statusCode);
    });
  });
});
