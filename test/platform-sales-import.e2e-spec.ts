/**
 * HTTP e2e — Sales Staff Management, Phase 7: Excel import / export of clinic
 * assignments.
 *
 * Boots the REAL AppModule against the migrations-built `ziyarati_e2e`
 * database, so the ownership rules an import must respect
 * (`UQ_sales_assignment_active_tenant`, `UQ_sales_assignment_acquired_tenant`)
 * are the production indexes. Files are real `.xlsx` workbooks uploaded as
 * multipart, exactly as the browser sends them. Every fixture is created here
 * and removed in `afterAll`, FK-safe. Employees are created with
 * `sendInvitation: false`, so no mail is ever attempted.
 */
import ExcelJS from 'exceljs';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';

import {
  authHeader,
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Role } from '../src/entities/Auth&RBAC/Role';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { ROLE } from '../src/rbac/rbac.constants';
import { SalesAssignmentImportService } from '../src/modules/platform-sales/sales-assignment-import.service';

const API = '/api/v1';
const RUN = randomUUID().slice(0, 8);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEADER = ['clinic_slug', 'clinic_id', 'kind', 'note'];

interface Actor {
  userId: string;
  token: string;
}
type Cell = string | undefined;
interface Clinic {
  id: string;
  slug: string;
}

describe('Sales Staff Management — assignment Excel import / export (HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let admin: Actor;
  let support: Actor;
  let salesSelf: Actor;
  let repA: string;
  let repB: string;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  const http = () => e2e.app.getHttpServer();
  const get = (path: string, token = admin.token) =>
    request(http()).get(`${API}${path}`).set(...authHeader(token));
  const post = (path: string, body: object = {}, token = admin.token) =>
    request(http()).post(`${API}${path}`).set(...authHeader(token)).send(body);
  const patch = (path: string, body: object = {}, token = admin.token) =>
    request(http()).patch(`${API}${path}`).set(...authHeader(token)).send(body);

  const mint = (userId: string, tenantId: string | null) =>
    e2e.jwt.signAsync(
      { sub: userId, tenantId, type: 'access' },
      { secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'), expiresIn: '15m' },
    );

  async function createPlatformActor(roleSlug: string, label: string): Promise<Actor> {
    const role = await e2e.dataSource
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: roleSlug })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!role) throw new Error(`Role "${roleSlug}" is not seeded — run migrations first.`);
    const users = e2e.dataSource.getRepository(User);
    const user = await users.save(
      users.create({
        tenant: undefined,
        email: `${label}-${RUN}-${randomUUID().slice(0, 6)}@example.test`,
        full_name: `E2E ${label}`,
        is_active: true,
      }),
    );
    await e2e.dataSource
      .getRepository(UserRole)
      .save({ user: { id: user.id } as User, role: { id: role.id } as Role });
    createdUserIds.push(user.id);
    return { userId: user.id, token: await mint(user.id, null) };
  }

  async function seedClinics(n: number, label: string, status = 'APPROVED'): Promise<Clinic[]> {
    const rows = (await e2e.dataSource.query(
      `INSERT INTO tenants (name, slug, contact_email, approval_status)
       SELECT $1 || ' ' || g, $2 || '-' || g, $2 || '-' || g || '@example.test', '${status}'
         FROM generate_series(1, $3::int) g
       RETURNING id, slug`,
      [`ImpE2E ${label}`, `ie2e-${RUN}-${label}`, n],
    )) as Clinic[];
    rows.forEach((r) => createdTenantIds.push(r.id));
    return rows;
  }

  async function createRep(label: string): Promise<string> {
    const res = await post('/platform/staff', {
      email: `imp-${label}-${RUN}@example.test`,
      fullName: `Imp ${label}`,
      roleSlug: ROLE.PLATFORM_SALES,
      sendInvitation: false,
    }).expect(201);
    createdUserIds.push(res.body.id);
    return res.body.id as string;
  }

  async function xlsx(rows: Cell[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Assignments');
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  const upload = (
    step: 'preview' | 'commit',
    employeeId: string,
    file: Buffer | undefined,
    fields: Record<string, string> = {},
    opts: { filename?: string; contentType?: string; token?: string } = {},
  ) => {
    const req = request(http())
      .post(`${API}/platform/sales/employees/${employeeId}/assignments/import/${step}`)
      .set(...authHeader(opts.token ?? admin.token));
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    if (file) req.attach('file', file, { filename: opts.filename ?? 'assignments.xlsx', contentType: opts.contentType ?? XLSX });
    return req;
  };

  const sheetOf = async (buffer: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.worksheets[0];
    const header = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    const rows: Array<Record<string, unknown>> = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const values = (ws.getRow(r).values as unknown[]).slice(1);
      rows.push(Object.fromEntries(header.map((h, i) => [h, values[i]])));
    }
    return { header, rows };
  };

  const download = (path: string, token = admin.token) =>
    request(http())
      .get(`${API}${path}`)
      .set(...authHeader(token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  const activeOwner = async (tenantId: string) =>
    ((await e2e.dataSource.query(
      `SELECT sales_user_id, kind, note, assigned_by FROM sales_clinic_assignments WHERE tenant_id = $1 AND ended_at IS NULL`,
      [tenantId],
    )) as Array<{ sales_user_id: string; kind: string; note: string | null; assigned_by: string }>)[0];
  const assignmentCount = async (userId: string) =>
    ((await e2e.dataSource.query(`SELECT COUNT(*)::int AS c FROM sales_clinic_assignments WHERE sales_user_id = $1`, [userId])) as Array<{ c: number }>)[0].c;
  const give = (userId: string, tenantId: string, kind = 'managed') =>
    e2e.dataSource.query(
      `INSERT INTO sales_clinic_assignments (sales_user_id, tenant_id, kind, assigned_by) VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, kind, admin.userId],
    );

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'imp-owner');
    admin = await createPlatformActor(ROLE.SUPER_ADMIN, 'sa');
    support = await createPlatformActor(ROLE.PLATFORM_SUPPORT, 'cs');
    salesSelf = await createPlatformActor(ROLE.PLATFORM_SALES, 'self');
    repA = await createRep('A');
    repB = await createRep('B');
  }, 90_000);

  afterAll(async () => {
    const ds = e2e.dataSource;
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM sales_clinic_assignments WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
    }
    if (createdTenantIds.length) {
      await ds.query(`DELETE FROM sales_clinic_assignments WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM api_logs WHERE "tenantId" = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM audit_logs WHERE "tenantId" = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [createdTenantIds]);
    }
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM password_resets WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM refresh_tokens WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM user_roles WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM audit_logs WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    }
    await cleanupTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 60_000);

  // ───────────────────────── template ─────────────────────────

  describe('template', () => {
    it('downloads a real workbook: import headers on sheet 1, instructions on sheet 2', async () => {
      const res = await download('/platform/sales/assignments/import/template').expect(200);
      expect(res.headers['content-type']).toContain(XLSX);
      expect(res.headers['content-disposition']).toContain('sales-assignment-import-template.xlsx');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as never);
      expect(wb.worksheets.map((w) => w.name)).toEqual(['Assignments', 'Instructions']);
      expect((wb.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual(HEADER);
    });
  });

  // ───────────────────────── preview ─────────────────────────

  describe('preview', () => {
    it('reports every row status against the real database and writes NOTHING', async () => {
      const [c1, c2, c3, c4] = await seedClinics(4, 'pv');
      const [rej] = await seedClinics(1, 'pvrej', 'REJECTED');
      const [gone] = await seedClinics(1, 'pvgone');
      await e2e.dataSource.query(`UPDATE tenants SET deleted_at = now() WHERE id = $1`, [gone.id]);
      await give(repA, c2.id); // mine already
      await give(repB, c3.id); // someone else's
      await give(repB, c4.id, 'acquired'); // credited to someone else

      const before = { a: await assignmentCount(repA), b: await assignmentCount(repB) };
      const file = await xlsx([
        HEADER,
        [c1.slug], //                                 will_assign
        [c2.slug], //                                 already_yours
        [c3.slug], //                                 assigned_to_other
        [c4.slug, '', 'acquired'], //                 (owned by repB → assigned_to_other first)
        [rej.slug], //                                clinic_rejected
        [gone.slug], //                               not_found (soft-deleted)
        ['no-such-clinic'], //                        not_found
        [c1.slug], //                                 duplicate_in_file
        ['Bad Slug!'], //                             invalid_identifier
        [c1.slug.toUpperCase(), '', 'boss'], //       invalid_kind
        [c1.slug, c2.id], //                          slug_id_mismatch
        [undefined, c1.id], //                        duplicate_in_file (by id)
      ]);

      const res = await upload('preview', repA, file).expect(200);

      expect(res.body.totalRows).toBe(12);
      expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual([
        'will_assign',
        'already_yours',
        'assigned_to_other',
        'assigned_to_other',
        'clinic_rejected',
        'not_found',
        'not_found',
        'duplicate_in_file',
        'invalid_identifier',
        'invalid_kind',
        'slug_id_mismatch',
        'duplicate_in_file',
      ]);
      expect(res.body.rows[2].owner).toMatchObject({ employeeId: repB });
      expect(res.body.rows[0]).toMatchObject({ row: 2, clinic: { id: c1.id, slug: c1.slug } });
      expect(res.body.counts).toMatchObject({ will_assign: 1, already_yours: 1, assigned_to_other: 2, not_found: 2 });
      expect(res.body.willApply).toBe(1);
      expect({ a: await assignmentCount(repA), b: await assignmentCount(repB) }).toEqual(before);
    });

    it('onConflict=reassign previews a takeover; an acquired row for a credited clinic still cannot', async () => {
      const [c1, c2] = await seedClinics(2, 'pvre');
      await give(repB, c1.id);
      await give(repB, c2.id, 'acquired');
      const res = await upload('preview', repA, await xlsx([HEADER, [c1.slug], [c2.slug, '', 'acquired'], [c2.slug]]), {
        onConflict: 'reassign',
      }).expect(200);
      expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual([
        'will_reassign',
        'acquisition_already_credited',
        'duplicate_in_file',
      ]);
    });

    it('defaultKind fills blank kind cells only', async () => {
      const [c1, c2] = await seedClinics(2, 'pvkind');
      const res = await upload('preview', repA, await xlsx([HEADER, [c1.slug], [c2.slug, '', 'managed']]), {
        defaultKind: 'acquired',
      }).expect(200);
      expect(res.body.rows.map((r: { kind: string }) => r.kind)).toEqual(['acquired', 'managed']);
    });
  });

  // ───────────────────────── commit ─────────────────────────

  describe('commit', () => {
    it('applies the valid rows with their kind and note, attributes them to the admin, and reports the rest', async () => {
      const [c1, c2, c3] = await seedClinics(3, 'cm');
      const rep = await createRep('cm');
      await give(repB, c3.id);
      const file = await xlsx([
        HEADER,
        [c1.slug, '', 'acquired', 'brought in by the rep'],
        [undefined, c2.id, '', 'by id'],
        [c3.slug],
        ['ghost'],
      ]);

      const res = await upload('commit', rep, file).expect(201);

      expect(res.body).toMatchObject({ totalRows: 4, assigned: 2, reassigned: 0, alreadyYours: 0, skipped: 2 });
      expect(res.body.errors.map((e: { row: number; status: string }) => [e.row, e.status])).toEqual([
        [4, 'assigned_to_other'],
        [5, 'not_found'],
      ]);
      expect(await activeOwner(c1.id)).toMatchObject({
        sales_user_id: rep,
        kind: 'acquired',
        note: 'brought in by the rep',
        assigned_by: admin.userId,
      });
      expect(await activeOwner(c2.id)).toMatchObject({ sales_user_id: rep, kind: 'managed', note: 'by id' });
      expect((await activeOwner(c3.id)).sales_user_id).toBe(repB); // untouched
    });

    it('is idempotent: committing the same file again changes nothing', async () => {
      const clinics = await seedClinics(4, 'idem');
      const rep = await createRep('idem');
      const file = await xlsx([HEADER, ...clinics.map((c) => [c.slug])]);

      const first = await upload('commit', rep, file).expect(201);
      expect(first.body).toMatchObject({ assigned: 4, alreadyYours: 0 });
      const rowsBefore = await assignmentCount(rep);

      const second = await upload('commit', rep, file).expect(201);
      expect(second.body).toMatchObject({ assigned: 0, alreadyYours: 4, skipped: 0, errors: [] });
      expect(await assignmentCount(rep)).toBe(rowsBefore);
    });

    it('onConflict=reassign closes the previous owner as "reassigned" and keeps the history', async () => {
      const [c1] = await seedClinics(1, 'rea');
      const rep = await createRep('rea');
      await give(repB, c1.id);

      const res = await upload('commit', rep, await xlsx([HEADER, [c1.slug]]), { onConflict: 'reassign' }).expect(201);
      expect(res.body).toMatchObject({ assigned: 1, reassigned: 1, skipped: 0 });

      const history = (await e2e.dataSource.query(
        `SELECT sales_user_id, ended_at IS NULL AS active, end_reason FROM sales_clinic_assignments WHERE tenant_id = $1 ORDER BY assigned_at`,
        [c1.id],
      )) as Array<{ sales_user_id: string; active: boolean; end_reason: string | null }>;
      expect(history).toEqual([
        { sales_user_id: repB, active: false, end_reason: 'reassigned' },
        { sales_user_id: rep, active: true, end_reason: null },
      ]);
    });

    it('acquisition credit is once per clinic, ever — a second acquired import is refused, a managed one is not', async () => {
      const [c1] = await seedClinics(1, 'acq');
      const first = await createRep('acq1');
      const second = await createRep('acq2');

      await upload('commit', first, await xlsx([HEADER, [c1.slug, '', 'acquired']])).expect(201);
      // ended, so the clinic is free again — but the credit stays with the first rep
      await e2e.dataSource.query(`UPDATE sales_clinic_assignments SET ended_at = now(), end_reason = 'unassigned' WHERE tenant_id = $1`, [c1.id]);

      const denied = await upload('commit', second, await xlsx([HEADER, [c1.slug, '', 'acquired']])).expect(201);
      expect(denied.body).toMatchObject({ assigned: 0, skipped: 1 });
      expect(denied.body.errors[0].status).toBe('acquisition_already_credited');

      const managed = await upload('commit', second, await xlsx([HEADER, [c1.slug, '', 'managed']])).expect(201);
      expect(managed.body.assigned).toBe(1);
      const credits = (await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM sales_clinic_assignments WHERE tenant_id = $1 AND kind = 'acquired'`,
        [c1.id],
      )) as Array<{ c: number }>;
      expect(credits[0].c).toBe(1);
    });

    it('re-validates at commit: a clinic taken after the preview is reported, never double-owned', async () => {
      const [c1, c2] = await seedClinics(2, 'race');
      const rep = await createRep('race');
      const file = await xlsx([HEADER, [c1.slug], [c2.slug]]);

      const preview = await upload('preview', rep, file).expect(200);
      expect(preview.body.willApply).toBe(2);

      await give(repB, c2.id); // someone else gets there first

      const res = await upload('commit', rep, file).expect(201);
      expect(res.body).toMatchObject({ assigned: 1, skipped: 1 });
      expect(res.body.errors[0]).toMatchObject({ row: 3, status: 'assigned_to_other' });
      expect((await activeOwner(c2.id)).sales_user_id).toBe(repB);
    });

    it('two employees importing the SAME clinics at once: every clinic ends with exactly one owner', async () => {
      const clinics = await seedClinics(25, 'dual');
      const a = await createRep('dualA');
      const b = await createRep('dualB');
      const file = await xlsx([HEADER, ...clinics.map((c) => [c.slug])]);

      const [ra, rb] = await Promise.all([upload('commit', a, file), upload('commit', b, file)]);
      expect([ra.status, rb.status]).toEqual([201, 201]);
      expect(ra.body.assigned + rb.body.assigned).toBe(25);
      expect(ra.body.assigned + ra.body.skipped + ra.body.alreadyYours).toBe(25);

      const owners = (await e2e.dataSource.query(
        `SELECT tenant_id, COUNT(*)::int AS c FROM sales_clinic_assignments
          WHERE tenant_id = ANY($1::uuid[]) AND ended_at IS NULL GROUP BY tenant_id`,
        [clinics.map((c) => c.id)],
      )) as Array<{ tenant_id: string; c: number }>;
      expect(owners).toHaveLength(25);
      expect(owners.every((o) => o.c === 1)).toBe(true);
      const statuses = new Set([...ra.body.errors, ...rb.body.errors].map((e: { status: string }) => e.status));
      for (const s of statuses) expect(['assigned_to_other', 'concurrent_assignment']).toContain(s);
    });

    it('writes ONE import_committed audit entry with the counts and the clinic ids', async () => {
      const clinics = await seedClinics(3, 'aud');
      const rep = await createRep('aud');
      await upload('commit', rep, await xlsx([HEADER, ...clinics.map((c) => [c.slug]), ['ghost']])).expect(201);

      const rows = (await e2e.dataSource.query(
        `SELECT new_values AS after FROM audit_logs
          WHERE "userId" = $1 AND action = 'platform_admin.sales.import_committed' AND entity_id = $2`,
        [admin.userId, rep],
      )) as Array<{ after: { assigned: number; skipped: number; totalRows: number; tenantIds: string[] } }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({ totalRows: 4, assigned: 3, skipped: 1 });
      expect([...rows[0].after.tenantIds].sort()).toEqual(clinics.map((c) => c.id).sort());
    });

    it('audits nothing when no row was applied', async () => {
      const rep = await createRep('noaud');
      await upload('commit', rep, await xlsx([HEADER, ['ghost-1'], ['ghost-2']])).expect(201);
      const rows = await e2e.dataSource.query(
        `SELECT 1 FROM audit_logs WHERE action = 'platform_admin.sales.import_committed' AND entity_id = $1`,
        [rep],
      );
      expect(rows).toHaveLength(0);
    });

    it('a file cannot redirect rows to another employee: an employee column is ignored', async () => {
      const [c1] = await seedClinics(1, 'redir');
      const rep = await createRep('redir');
      await upload('commit', rep, await xlsx([[...HEADER, 'employee_id'], [c1.slug, '', '', '', repB]])).expect(201);
      expect((await activeOwner(c1.id)).sales_user_id).toBe(rep);
    });
  });

  // ───────────────────────── employee checks ─────────────────────────

  describe('the employee in the path', () => {
    it('a deactivated employee gets 409 on preview and commit, and nothing is written', async () => {
      const rep = await createRep('inactive');
      await patch(`/platform/staff/${rep}/status`, { isActive: false }).expect(200);
      const [c1] = await seedClinics(1, 'inact');
      const file = await xlsx([HEADER, [c1.slug]]);
      for (const step of ['preview', 'commit'] as const) {
        const res = await upload(step, rep, file).expect(409);
        expect(res.body.code).toBe('SALES_EMPLOYEE_INACTIVE');
      }
      expect(await activeOwner(c1.id)).toBeUndefined();
    });

    it('a tenant user, a super admin, platform_support and a random id are ONE identical 404 — even with no file', async () => {
      const bodies: string[] = [];
      for (const id of [owner.userId, admin.userId, support.userId, randomUUID()]) {
        for (const step of ['preview', 'commit'] as const) {
          const res = await upload(step, id, undefined).expect(404);
          expect(res.body.code).toBe('SALES_EMPLOYEE_NOT_FOUND');
          bodies.push(JSON.stringify({ code: res.body.code, message: res.body.message }));
        }
      }
      expect(new Set(bodies).size).toBe(1);
    });
  });

  // ───────────────────────── upload validation ─────────────────────────

  describe('the upload is validated server-side', () => {
    it('400 with no file', async () => {
      await upload('preview', repA, undefined).expect(400);
    });

    it('rejects a wrong extension and content that is not a workbook', async () => {
      const good = await xlsx([HEADER, ['x']]);
      const csvName = await upload('preview', repA, good, {}, { filename: 'assignments.csv' }).expect(400);
      expect(csvName.body.code).toBe('UNSUPPORTED_FILE_TYPE');
      const spoofed = await upload('preview', repA, Buffer.from('slug\nclinic-1\n'), {}, { filename: 'a.xlsx' }).expect(400);
      expect(['UNSUPPORTED_FILE_TYPE', 'FILE_CONTENT_MISMATCH', 'BAD_REQUEST']).toContain(spoofed.body.code);
      const csvType = await upload('preview', repA, good, {}, { contentType: 'text/csv' }).expect(400);
      expect(csvType.body.code).toBe('UNSUPPORTED_FILE_TYPE');
    });

    it('413 for a file over 5 MB (cut off by the upload limit, before any parsing)', async () => {
      await upload('preview', repA, Buffer.alloc(5 * 1024 * 1024 + 1024, 1)).expect(413);
    }, 30_000);

    it('400 for a file with no clinic_slug/clinic_id column, and for no data rows', async () => {
      await upload('preview', repA, await xlsx([['kind', 'note'], ['managed', 'x']])).expect(400);
      await upload('preview', repA, await xlsx([HEADER])).expect(400);
    });

    it('400 above 2,000 data rows', async () => {
      const rows = [HEADER, ...Array.from({ length: 2001 }, (_, i) => [`over-${i}`])];
      const res = await upload('preview', repA, await xlsx(rows)).expect(400);
      expect(res.body.message).toMatch(/2000/);
    }, 60_000);

    it('400 for an unknown body field or an invalid option (forbidNonWhitelisted)', async () => {
      const file = await xlsx([HEADER, ['x']]);
      await upload('preview', repA, file, { onConflict: 'overwrite' }).expect(400);
      await upload('preview', repA, file, { defaultKind: 'owner' }).expect(400);
      await upload('preview', repA, file, { employeeId: repB }).expect(400);
    });
  });

  // ───────────────────────── export ─────────────────────────

  describe('export', () => {
    it('exports one employee\'s active assignments with the import headers first', async () => {
      const rep = await createRep('ex1');
      const clinics = await seedClinics(3, 'ex1');
      for (const c of clinics) await give(rep, c.id);

      const res = await download(`/platform/sales/assignments/export?employeeId=${rep}`).expect(200);
      expect(res.headers['content-type']).toContain(XLSX);
      expect(res.headers['content-disposition']).toMatch(/sales-assignments-\d{4}-\d{2}-\d{2}\.xlsx/);
      const { header, rows } = await sheetOf(res.body);
      expect(header.slice(0, 4)).toEqual(HEADER);
      expect(rows.map((r) => r.clinic_slug)).toEqual(clinics.map((c) => c.slug).sort());
      expect(rows[0]).toMatchObject({ clinic_id: expect.any(String), kind: 'managed', assignment_status: 'active', employee_email: `imp-ex1-${RUN}@example.test` });
    });

    it('status filter: active (default), ended, all — and a deleted clinic never appears', async () => {
      const rep = await createRep('ex2');
      const [live, ended, gone] = await seedClinics(3, 'ex2');
      await give(rep, live.id);
      await give(rep, ended.id);
      await give(rep, gone.id);
      await e2e.dataSource.query(
        `UPDATE sales_clinic_assignments SET ended_at = now(), end_reason = 'unassigned' WHERE tenant_id = $1`,
        [ended.id],
      );
      await e2e.dataSource.query(`UPDATE tenants SET deleted_at = now() WHERE id = $1`, [gone.id]);

      const slugs = async (q: string) =>
        (await sheetOf((await download(`/platform/sales/assignments/export?employeeId=${rep}${q}`).expect(200)).body)).rows.map((r) => r.clinic_slug);
      expect(await slugs('')).toEqual([live.slug]);
      expect(await slugs('&status=active')).toEqual([live.slug]);
      expect(await slugs('&status=ended')).toEqual([ended.slug]);
      expect(await slugs('&status=all')).toEqual([live.slug, ended.slug].sort());
      const all = (await sheetOf((await download(`/platform/sales/assignments/export?employeeId=${rep}&status=ended`).expect(200)).body)).rows;
      expect(all[0]).toMatchObject({ assignment_status: 'ended', end_reason: 'unassigned' });
    });

    it('formula-escapes text a clinic or note could smuggle into a spreadsheet (SEC-05)', async () => {
      const rep = await createRep('ex3');
      const [c1] = await seedClinics(1, 'ex3');
      await e2e.dataSource.query(`UPDATE tenants SET name = '=HYPERLINK("http://evil.test","open me")' WHERE id = $1`, [c1.id]);
      await e2e.dataSource.query(
        `INSERT INTO sales_clinic_assignments (sales_user_id, tenant_id, kind, assigned_by, note) VALUES ($1, $2, 'managed', $3, '@SUM(1+1)')`,
        [rep, c1.id, admin.userId],
      );
      const { rows } = await sheetOf((await download(`/platform/sales/assignments/export?employeeId=${rep}`).expect(200)).body);
      expect(rows[0].clinic_name).toBe(`'=HYPERLINK("http://evil.test","open me")`);
      expect(rows[0].note).toBe(`'@SUM(1+1)`);
      // stored data is unchanged
      const [{ name }] = (await e2e.dataSource.query(`SELECT name FROM tenants WHERE id = $1`, [c1.id])) as Array<{ name: string }>;
      expect(name.startsWith('=HYPERLINK')).toBe(true);
    });

    it('round trip: export one employee\'s clinics, upload the file to another employee with reassign', async () => {
      const src = await createRep('rt-src');
      const dst = await createRep('rt-dst');
      const clinics = await seedClinics(5, 'rt');
      for (const c of clinics) await give(src, c.id);

      const exported = (await download(`/platform/sales/assignments/export?employeeId=${src}`).expect(200)).body as Buffer;
      const preview = await upload('preview', dst, exported, { onConflict: 'reassign' }).expect(200);
      expect(preview.body.counts.will_reassign).toBe(5);

      const res = await upload('commit', dst, exported, { onConflict: 'reassign' }).expect(201);
      expect(res.body).toMatchObject({ assigned: 5, reassigned: 5, skipped: 0 });
      for (const c of clinics) expect((await activeOwner(c.id)).sales_user_id).toBe(dst);
    });

    it('pages by keyset without losing or repeating a row (page size 3 over 10 assignments, incl. history)', async () => {
      const rep = await createRep('ex4');
      const clinics = await seedClinics(8, 'ex4');
      for (const c of clinics) await give(rep, c.id);
      // history rows for the same clinics: same slug, later assigned_at — the tuple keyset must keep both
      await e2e.dataSource.query(
        `UPDATE sales_clinic_assignments SET ended_at = now(), end_reason = 'reassigned' WHERE sales_user_id = $1 AND tenant_id = ANY($2::uuid[])`,
        [rep, [clinics[0].id, clinics[1].id]],
      );
      await give(rep, clinics[0].id);
      await give(rep, clinics[1].id);

      const service = e2e.app.get(SalesAssignmentImportService);
      const { buffer, rowCount } = await service.exportAssignments({ employeeId: rep, status: 'all' }, 3);
      expect(rowCount).toBe(10);
      const { rows } = await sheetOf(buffer);
      expect(rows).toHaveLength(10);
      const keys = rows.map((r) => `${r.clinic_slug}|${r.assigned_at}|${r.assignment_status}`);
      expect(new Set(keys).size).toBe(10);
      const slugs = rows.map((r) => r.clinic_slug as string);
      expect(slugs).toEqual([...slugs].sort());

      const whole = await service.exportAssignments({ employeeId: rep, status: 'all' }, 1000);
      expect((await sheetOf(whole.buffer)).rows.map((r) => r.clinic_id)).toEqual(rows.map((r) => r.clinic_id));
    });

    it('an empty export still opens: header row, no data', async () => {
      const rep = await createRep('ex5');
      const { header, rows } = await sheetOf((await download(`/platform/sales/assignments/export?employeeId=${rep}`).expect(200)).body);
      expect(header).toHaveLength(12);
      expect(rows).toEqual([]);
    });

    it('400 for a bad status or employeeId; 404 for an id that is not a sales employee', async () => {
      await download('/platform/sales/assignments/export?status=everything').expect(400);
      await download('/platform/sales/assignments/export?employeeId=nope').expect(400);
      await download(`/platform/sales/assignments/export?employeeId=${support.userId}`).expect(404);
      await download(`/platform/sales/assignments/export?employeeId=${randomUUID()}`).expect(404);
    });
  });

  // ───────────────────────── authorization ─────────────────────────

  describe('Super Admin only', () => {
    const someId = randomUUID();
    const routes: Array<[string, string]> = [
      ['GET', '/platform/sales/assignments/import/template'],
      ['GET', '/platform/sales/assignments/export'],
      ['POST', `/platform/sales/employees/${someId}/assignments/import/preview`],
      ['POST', `/platform/sales/employees/${someId}/assignments/import/commit`],
    ];
    const send = async (method: string, path: string, token?: string) => {
      const r = request(http())[method === 'GET' ? 'get' : 'post'](`${API}${path}`);
      if (token) r.set(...authHeader(token));
      if (method === 'POST') r.attach('file', await xlsx([HEADER, ['x']]), { filename: 'a.xlsx', contentType: XLSX });
      return r;
    };

    it.each(routes)('%s %s → 401 without a token', async (method, path) => {
      expect((await send(method, path)).status).toBe(401);
    });
    it.each(routes)('%s %s → 403 for a clinic Owner', async (method, path) => {
      expect((await send(method, path, owner.token)).status).toBe(403);
    });
    it.each(routes)('%s %s → 403 for platform_support', async (method, path) => {
      expect((await send(method, path, support.token)).status).toBe(403);
    });
    it.each(routes)('%s %s → 403 for a sales employee themselves', async (method, path) => {
      expect((await send(method, path, salesSelf.token)).status).toBe(403);
    });

    it('a forbidden caller cannot assign anything by uploading', async () => {
      const [c1] = await seedClinics(1, 'forbid');
      const rep = await createRep('forbid');
      await upload('commit', rep, await xlsx([HEADER, [c1.slug]]), {}, { token: support.token }).expect(403);
      await upload('commit', rep, await xlsx([HEADER, [c1.slug]]), {}, { token: salesSelf.token }).expect(403);
      expect(await activeOwner(c1.id)).toBeUndefined();
    });
  });

  // ───────────────────────── scale + query counts ─────────────────────────

  describe('scale', () => {
    const proto = PgClient.prototype as unknown as { query: (...a: unknown[]) => unknown };
    const original = proto.query;
    let counting = false;
    let count = 0;

    beforeAll(() => {
      proto.query = function patched(this: unknown, ...args: unknown[]) {
        if (counting) count++;
        return original.apply(this, args);
      };
    });
    afterAll(() => {
      proto.query = original;
    });

    it('preview: the same number of SQL statements for 5 rows and for 500', async () => {
      const rep = await createRep('qc');
      const clinics = await seedClinics(500, 'qc');
      const statements = async (n: number): Promise<number> => {
        const file = await xlsx([HEADER, ...clinics.slice(0, n).map((c) => [c.slug])]);
        count = 0;
        counting = true;
        try {
          await upload('preview', rep, file).expect(200);
        } finally {
          counting = false;
        }
        return count;
      };
      await statements(5); // warm
      const few = await statements(5);
      const many = await statements(500);
      console.log(`[query-count] import preview: 5 rows → ${few}, 500 rows → ${many}`);
      expect(many).toBe(few);
    }, 60_000);

    it('commit: the same number of SQL statements for 5 rows and for 500', async () => {
      const clinics = await seedClinics(505, 'qcc');
      const statements = async (n: number, from: number): Promise<number> => {
        const rep = await createRep(`qcc${n}`);
        const file = await xlsx([HEADER, ...clinics.slice(from, from + n).map((c) => [c.slug])]);
        count = 0;
        counting = true;
        try {
          await upload('commit', rep, file).expect(201);
        } finally {
          counting = false;
        }
        return count;
      };
      const few = await statements(5, 0);
      const many = await statements(500, 5);
      console.log(`[query-count] import commit: 5 rows → ${few}, 500 rows → ${many}`);
      expect(many).toBe(few);
    }, 60_000);

    it('a full 2,000-row file previews and commits correctly (timings logged)', async () => {
      const clinics = await seedClinics(2000, 'big');
      const rep = await createRep('big');
      const rows: Cell[][] = [
        HEADER,
        ...clinics.map((c, i) => [c.slug, '', i % 4 === 0 ? 'acquired' : 'managed', i % 10 === 0 ? `note ${i}` : undefined]),
      ];
      const file = await xlsx(rows);

      const t0 = Date.now();
      const preview = await upload('preview', rep, file).expect(200);
      const tPreview = Date.now() - t0;
      expect(preview.body.totalRows).toBe(2000);
      expect(preview.body.counts.will_assign).toBe(2000);

      const t1 = Date.now();
      const commit = await upload('commit', rep, file).expect(201);
      const tCommit = Date.now() - t1;
      expect(commit.body).toMatchObject({ totalRows: 2000, assigned: 2000, skipped: 0 });
      console.log(
        `[import-scale] 2,000 rows: preview ${tPreview} ms (${(preview.text.length / 1024).toFixed(0)} KB), commit ${tCommit} ms (${(commit.text.length / 1024).toFixed(1)} KB), file ${(file.length / 1024).toFixed(0)} KB`,
      );
      expect(await assignmentCount(rep)).toBe(2000);
    }, 120_000);
  });
});
