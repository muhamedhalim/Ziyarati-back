/**
 * HTTP e2e — platform clinic import (`/platform/sales/clinic-import/*`).
 *
 * Boots the REAL AppModule against the migrations-built `ziyarati_e2e`
 * database, so uniqueness is enforced by the production indexes
 * (`tenants.slug`, `tenants.contact_email`, `uq_user_email_global`,
 * `UQ_sales_assignment_active_tenant`) and every transaction is a real one.
 * Files are real `.xlsx` workbooks uploaded as multipart. Mail is forced off
 * (see sales-self-env.setup.ts). Every fixture carries this run's RUN id and is
 * removed in `afterAll`.
 */
import './utils/sales-self-env.setup';

import ExcelJS from 'exceljs';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

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
import { AuthService } from '../src/modules/auth/auth.service';
import { SalesAssignmentService } from '../src/modules/platform-sales/sales-assignment.service';
import { CLINIC_IMPORT_MAX_ROWS } from '../src/modules/platform-sales/clinic-import.constants';

const API = '/api/v1';
const RUN = randomUUID().slice(0, 8);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BASE = '/platform/sales/clinic-import';
const HEADER = [
  'clinic_name',
  'owner_name',
  'owner_email',
  'commercial_registration_number',
  'clinic_slug',
  'owner_phone',
  'sales_rep_email',
];

type Cell = string | { formula: string; result: string } | undefined;
interface Actor {
  userId: string;
  token: string;
}

let seq = 0;
/** A fully valid row with run-unique identifiers. */
const row = (label: string, over: Partial<Record<(typeof HEADER)[number], Cell>> = {}): Cell[] => {
  const n = `${RUN}-${label}-${++seq}`;
  const r: Record<string, Cell> = {
    clinic_name: `ClinicImp ${n}`,
    owner_name: `Owner ${n}`,
    owner_email: `imp-${n}@example.test`,
    commercial_registration_number: `CR-${n}`,
    clinic_slug: `imp-${n}`.toLowerCase(),
    owner_phone: '+966501234567',
    sales_rep_email: undefined,
    ...over,
  };
  return HEADER.map((h) => r[h]);
};

describe('Platform clinic import (HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let admin: Actor;
  let support: Actor;
  let salesSelf: Actor;
  let repEmail: string;
  let repId: string;
  const createdUserIds: string[] = [];

  const http = () => e2e.app.getHttpServer();
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

  async function xlsx(rows: Cell[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Clinics');
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  const upload = (
    step: 'preview' | 'commit',
    file: Buffer | undefined,
    fields: Record<string, string> = {},
    opts: { filename?: string; contentType?: string; token?: string | null } = {},
  ) => {
    const req = request(http()).post(`${API}${BASE}/${step}`);
    if (opts.token !== null) req.set(...authHeader(opts.token ?? admin.token));
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    if (file) {
      req.attach('file', file, {
        filename: opts.filename ?? 'clinics.xlsx',
        contentType: opts.contentType ?? XLSX,
      });
    }
    return req;
  };

  const slugsOf = (rows: Cell[][]) => rows.map((r) => r[4] as string);
  const tenantBySlug = async (slug: string) =>
    ((await e2e.dataSource.query(
      `SELECT id, name, contact_email, contact_phone, commercial_registration_number,
              approval_status, is_active, default_currency, default_timezone
         FROM tenants WHERE slug = $1`,
      [slug],
    )) as Array<Record<string, unknown>>)[0];
  const countBySlugs = async (slugs: string[]) =>
    ((await e2e.dataSource.query(`SELECT COUNT(*)::int AS c FROM tenants WHERE slug = ANY($1::text[])`, [slugs])) as Array<{ c: number }>)[0].c;
  const runTenants = () =>
    e2e.dataSource.query(`SELECT id FROM tenants WHERE slug LIKE $1`, [`imp-${RUN.toLowerCase()}-%`]) as Promise<Array<{ id: string }>>;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'cimp-owner');
    admin = await createPlatformActor(ROLE.SUPER_ADMIN, 'sa');
    support = await createPlatformActor(ROLE.PLATFORM_SUPPORT, 'cs');
    salesSelf = await createPlatformActor(ROLE.PLATFORM_SALES, 'self');
    const rep = await createPlatformActor(ROLE.PLATFORM_SALES, 'rep');
    repId = rep.userId;
    repEmail = (await e2e.dataSource.query(`SELECT email FROM users WHERE id = $1`, [repId]))[0].email;
  }, 90_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    const ds = e2e.dataSource;
    const ids = (await runTenants()).map((t) => t.id);
    const userIds = (
      (await ds.query(`SELECT id FROM users WHERE "tenantId" = ANY($1::uuid[])`, [ids])) as Array<{ id: string }>
    ).map((u) => u.id);
    const allUsers = [...userIds, ...createdUserIds];
    await ds.query(`DELETE FROM sales_clinic_assignments WHERE tenant_id = ANY($1::uuid[]) OR sales_user_id = ANY($2::uuid[])`, [ids, allUsers]);
    await ds.query(`DELETE FROM api_logs WHERE "tenantId" = ANY($1::uuid[])`, [ids]);
    await ds.query(`DELETE FROM audit_logs WHERE "tenantId" = ANY($1::uuid[]) OR "userId" = ANY($2::uuid[])`, [ids, allUsers]);
    await ds.query(`DELETE FROM password_resets WHERE "userId" = ANY($1::uuid[])`, [allUsers]);
    await ds.query(`DELETE FROM refresh_tokens WHERE "userId" = ANY($1::uuid[])`, [allUsers]);
    await ds.query(`DELETE FROM user_roles WHERE "userId" = ANY($1::uuid[])`, [allUsers]);
    await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [allUsers]);
    await ds.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [ids]);
    await cleanupTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 60_000);

  // ───────────────────────── authorization ─────────────────────────

  describe('authorization (enforced on the backend for every step)', () => {
    it.each([
      ['no token', null],
      ['a clinic owner', 'owner'],
      ['platform support', 'support'],
      ['a sales rep', 'sales'],
    ])('refuses %s on template, preview and commit', async (_label, who) => {
      const token = who === 'owner' ? owner.token : who === 'support' ? support.token : who === 'sales' ? salesSelf.token : null;
      const file = await xlsx([HEADER, row('auth')]);
      const expected = who === null ? 401 : 403;

      const tpl = request(http()).get(`${API}${BASE}/template`);
      if (token) tpl.set(...authHeader(token));
      await tpl.expect(expected);
      await upload('preview', file, {}, { token }).expect(expected);
      await upload('commit', file, {}, { token }).expect(expected);
      expect(await countBySlugs(slugsOf([row('x')]))).toBe(0);
    });

    it('refused commits create nothing', async () => {
      const r = row('authnone');
      await upload('commit', await xlsx([HEADER, r]), {}, { token: support.token }).expect(403);
      expect(await countBySlugs(slugsOf([r]))).toBe(0);
    });
  });

  // ───────────────────────── template ─────────────────────────

  describe('template', () => {
    it('is a real workbook whose headers match what the importer reads', async () => {
      const res = await request(http())
        .get(`${API}${BASE}/template`)
        .set(...authHeader(admin.token))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain(XLSX);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as never);
      expect(wb.worksheets.map((w) => w.name)).toEqual(['Clinics', 'Instructions']);

      // Round trip: the template, as downloaded, is accepted (its example row is
      // deliberately invalid, so it is reported, never created).
      const preview = await upload('preview', res.body as Buffer).expect(200);
      expect(preview.body.totalRows).toBe(1);
      expect(preview.body.rows[0].status).toBe('invalid');
      expect(preview.body.willCreate).toBe(0);
    });
  });

  // ───────────────────────── file-level rejection ─────────────────────────

  describe('file validation', () => {
    it('an empty file (header only) is refused with a clear message', async () => {
      const res = await upload('preview', await xlsx([HEADER])).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/no data rows/i);
    });

    it('a corrupted workbook is refused', async () => {
      const bogus = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('not a real zip')]);
      await upload('preview', bogus).expect(400);
    });

    it('text pretending to be .xlsx is refused by its magic bytes', async () => {
      await upload('preview', Buffer.from('a,b,c\n1,2,3\n')).expect(400);
    });

    it('a .csv upload and a wrong MIME are refused', async () => {
      const csv = Buffer.from('clinic_name,owner_email\nX,x@x.test\n');
      await upload('preview', csv, {}, { filename: 'clinics.csv', contentType: 'text/csv' }).expect(400);
      await upload('preview', await xlsx([HEADER, row('mime')]), {}, { contentType: 'application/pdf' }).expect(400);
    });

    it('no file at all is a 400', async () => {
      await upload('preview', undefined).expect(400);
    });

    it('a file over the size limit is refused with 413 and creates nothing', async () => {
      const r = row('big');
      const big = Buffer.concat([await xlsx([HEADER, r]), Buffer.alloc(2.5 * 1024 * 1024)]);
      await upload('commit', big).expect(413);
      expect(await countBySlugs(slugsOf([r]))).toBe(0);
    });

    it('a missing required column names it', async () => {
      const header = HEADER.filter((h) => h !== 'owner_email');
      const res = await upload('preview', await xlsx([header, ['A', 'B', 'CR-1']])).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/Owner_Email/i);
    });

    it('more than the row limit is refused', async () => {
      const rows = Array.from({ length: CLINIC_IMPORT_MAX_ROWS + 1 }, (_, i) => row(`cap${i}`));
      const res = await upload('preview', await xlsx([HEADER, ...rows])).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/more than/i);
    });

    it('accepts header variants (case, spaces, Arabic) but not look-alikes', async () => {
      const r = row('alias');
      const variants = ['Clinic Name', 'OWNER NAME', 'البريد الإلكتروني', 'CR Number', 'Clinic Slug'];
      const file = await xlsx([variants, [r[0], r[1], r[2], r[3], r[4]]]);
      const ok = await upload('preview', file).expect(200);
      expect(ok.body.rows[0].status).toBe('will_create');

      const bad = await xlsx([['Clinic Nme', 'Owner Name', 'Owner Email', 'CR Number'], ['a', 'b', 'c@d.test', 'CR1']]);
      await upload('preview', bad).expect(400);
    });
  });

  // ───────────────────────── preview ─────────────────────────

  describe('preview', () => {
    it('classifies every row and writes NOTHING', async () => {
      const dupFirst = row('pvdup');
      const rows = [
        row('pvok'), //                                              will_create
        dupFirst, //                                                will_create
        row('pvdup2', { clinic_slug: dupFirst[4] as string }), //   duplicate_in_file (slug)
        row('pvbad', { owner_email: 'nope' }), //                   invalid
        row('pvrep', { sales_rep_email: 'ghost@example.test' }), //  sales_rep_not_found
      ];
      const before = (await runTenants()).length;
      const res = await upload('preview', await xlsx([HEADER, ...rows])).expect(200);
      expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual([
        'will_create',
        'will_create',
        'duplicate_in_file',
        'invalid',
        'sales_rep_not_found',
      ]);
      expect(res.body).toMatchObject({ totalRows: 5, willCreate: 2 });
      expect(res.body.counts).toMatchObject({ will_create: 2, invalid: 1, duplicate_in_file: 1, sales_rep_not_found: 1 });
      expect(res.body.rows[3].errors).toEqual([{ field: 'owner_email', code: 'invalid_email' }]);
      expect(res.body.rows[2].duplicateOfRow).toBe(3);
      expect((await runTenants()).length).toBe(before);
    });

    it('never echoes the normalised values object or any password field', async () => {
      const res = await upload('preview', await xlsx([HEADER, row('pvleak')])).expect(200);
      expect(Object.keys(res.body.rows[0]).sort()).toEqual(
        ['clinicName', 'conflicts', 'duplicateOfRow', 'errors', 'ownerEmail', 'ownerName', 'row', 'salesRepEmail', 'slug', 'status'].sort(),
      );
    });
  });

  // ───────────────────────── commit ─────────────────────────

  describe('commit', () => {
    it('creates one valid clinic through the real clinic-creation path', async () => {
      const r = row('one', { owner_phone: '+966 50 111 2222' });
      const res = await upload('commit', await xlsx([HEADER, r])).expect(201);
      expect(res.body).toMatchObject({ totalRows: 1, created: 1, skipped: 0, failed: 0, invited: 0 });
      expect(res.body.rows[0].status).toBe('created');
      expect(res.body.importId).toMatch(/[0-9a-f-]{36}/);

      const t = await tenantBySlug(r[4] as string);
      expect(t).toMatchObject({
        name: r[0],
        contact_email: r[2],
        commercial_registration_number: r[3],
        approval_status: 'PENDING_VERIFICATION',
        is_active: false,
        default_currency: 'USD',
      });

      const [u] = await e2e.dataSource.query(
        `SELECT u.id, u.email, u.full_name, u.phone, u.is_active, u.password_hash, r.slug AS role
           FROM users u JOIN user_roles ur ON ur."userId" = u.id JOIN roles r ON r.id = ur."roleId"
          WHERE u."tenantId" = $1`,
        [t.id],
      );
      expect(u).toMatchObject({ email: r[2], full_name: r[1], role: ROLE.OWNER, is_active: true });
      expect(u.password_hash).toMatch(/^\$2[aby]\$/); // a bcrypt hash of a random value nobody holds

      const [{ s }] = await e2e.dataSource.query(`SELECT COUNT(*)::int AS s FROM tenant_settings WHERE tenant_id = $1`, [t.id]);
      const [{ ev }] = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS ev FROM tenant_approval_events WHERE "tenantId" = $1 AND action = 'CREATED' AND acted_by = $2`,
        [t.id, admin.userId],
      );
      expect([s, ev]).toEqual([1, 1]);
    });

    it('creates several clinics, applies optional fields and assigns the sales rep', async () => {
      const rows = [
        row('m1'),
        row('m2', { sales_rep_email: repEmail.toUpperCase() }),
        row('m3', { clinic_name: 'عيادة النور', owner_phone: undefined }), // Arabic name: the explicit slug is what makes it valid
      ];
      const res = await upload('commit', await xlsx([HEADER, ...rows]), { assignmentKind: 'acquired' }).expect(201);
      expect(res.body).toMatchObject({ totalRows: 3, created: 3, skipped: 0, failed: 0 });
      const t = await tenantBySlug(rows[1][4] as string);
      const assignments = await e2e.dataSource.query(
        `SELECT sales_user_id, kind, assigned_by FROM sales_clinic_assignments WHERE tenant_id = $1 AND ended_at IS NULL`,
        [t.id],
      );
      expect(assignments).toEqual([{ sales_user_id: repId, kind: 'acquired', assigned_by: admin.userId }]);
      expect(await e2e.dataSource.query(`SELECT 1 FROM sales_clinic_assignments WHERE tenant_id = $1`, [(await tenantBySlug(rows[0][4] as string)).id])).toHaveLength(0);
    });

    it('reports invalid rows with field-level errors and still imports the valid ones', async () => {
      const good = row('mixok');
      const rows = [
        row('mixbad1', { owner_phone: 'not a phone', commercial_registration_number: '' }),
        good,
        row('mixbad2', { clinic_name: '=HYPERLINK("http://evil.test")' }),
        row('mixbad3', { clinic_name: { formula: 'HYPERLINK("http://evil.test")', result: '=cmd|calc' } }),
      ];
      const res = await upload('commit', await xlsx([HEADER, ...rows])).expect(201);
      expect(res.body).toMatchObject({ totalRows: 4, created: 1, skipped: 3, failed: 0 });
      const byRow = Object.fromEntries(res.body.rows.map((r: { row: number }) => [r.row, r]));
      expect(byRow[2].errors.map((e: { field: string }) => e.field).sort()).toEqual(['commercial_registration_number', 'owner_phone']);
      expect(byRow[4].errors[0]).toEqual({ field: 'clinic_name', code: 'invalid_text' });
      expect(byRow[5].errors[0]).toEqual({ field: 'clinic_name', code: 'invalid_text' }); // the cached formula result is validated, never run
      expect(await countBySlugs(slugsOf(rows))).toBe(1);
    });

    it('rejects duplicates inside the file, keeping the first row', async () => {
      const first = row('dupf');
      const second = row('dupf2', { owner_email: first[2] });
      const res = await upload('commit', await xlsx([HEADER, first, second])).expect(201);
      expect(res.body).toMatchObject({ created: 1, skipped: 1 });
      expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual(['created', 'duplicate_in_file']);
      expect(await countBySlugs(slugsOf([first, second]))).toBe(1);
    });

    it('never modifies or duplicates an existing clinic, whichever identifier collides', async () => {
      const existing = row('exist');
      await upload('commit', await xlsx([HEADER, existing])).expect(201);
      const before = await tenantBySlug(existing[4] as string);

      const rows = [
        row('ex1', { clinic_slug: existing[4], clinic_name: 'OVERWRITE ATTEMPT' }), //   same slug
        row('ex2', { owner_email: (existing[2] as string).toUpperCase() }), //            same owner email (case-insensitive)
        row('ex3', { commercial_registration_number: (existing[3] as string).toLowerCase() }), // same CR
        row('ex4', { owner_email: owner.email }), //                                       email of a pre-existing account
      ];
      const res = await upload('commit', await xlsx([HEADER, ...rows])).expect(201);
      expect(res.body).toMatchObject({ created: 0, skipped: 4, failed: 0 });
      expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual(Array(4).fill('already_exists'));
      expect(res.body.rows[0].conflicts).toContain('slug');
      expect(res.body.rows[1].conflicts).toContain('owner_email');
      expect(res.body.rows[2].conflicts).toContain('commercial_registration_number');
      expect(res.body.rows[3].conflicts).toContain('owner_email');
      expect(await tenantBySlug(existing[4] as string)).toEqual(before); // untouched
      expect(await countBySlugs([rows[1][4] as string, rows[2][4] as string, rows[3][4] as string])).toBe(0);
    });

    it('re-importing the same file creates nothing new', async () => {
      const rows = [row('re1'), row('re2'), row('re3')];
      const file = await xlsx([HEADER, ...rows]);
      const first = await upload('commit', file).expect(201);
      expect(first.body.created).toBe(3);
      const countBefore = (await runTenants()).length;
      const usersBefore = (await e2e.dataSource.query(`SELECT COUNT(*)::int AS c FROM users`))[0].c;

      const second = await upload('commit', file).expect(201);
      expect(second.body).toMatchObject({ created: 0, skipped: 3, failed: 0 });
      expect(second.body.rows.every((r: { status: string }) => r.status === 'already_exists')).toBe(true);
      expect((await runTenants()).length).toBe(countBefore);
      expect((await e2e.dataSource.query(`SELECT COUNT(*)::int AS c FROM users`))[0].c).toBe(usersBefore);

      const preview = await upload('preview', file).expect(200);
      expect(preview.body.willCreate).toBe(0);
    });

    it('imports a maximum-size file (the row cap) and reports how long it took', async () => {
      const rows = Array.from({ length: CLINIC_IMPORT_MAX_ROWS }, (_, i) => row(`max${i}`));
      const file = await xlsx([HEADER, ...rows]);
      const t0 = Date.now();
      const preview = await upload('preview', file).expect(200);
      const previewMs = Date.now() - t0;
      expect(preview.body.willCreate).toBe(CLINIC_IMPORT_MAX_ROWS);
      const t1 = Date.now();
      const res = await upload('commit', file).expect(201);
      const commitMs = Date.now() - t1;
      expect(res.body).toMatchObject({ created: CLINIC_IMPORT_MAX_ROWS, failed: 0, skipped: 0 });
      // eslint-disable-next-line no-console
      console.log(`clinic-import ${CLINIC_IMPORT_MAX_ROWS} rows: preview ${previewMs} ms, commit ${commitMs} ms`);
    }, 240_000);

    it('creates no subscription, invoice, payment or credit — and no mail without being asked', async () => {
      const rows = [row('fin1'), row('fin2')];
      await upload('commit', await xlsx([HEADER, ...rows])).expect(201);
      const ids = [(await tenantBySlug(rows[0][4] as string)).id, (await tenantBySlug(rows[1][4] as string)).id];
      const count = async (sql: string) => (await e2e.dataSource.query(sql, [ids]))[0].c as number;
      expect(await count(`SELECT COUNT(*)::int AS c FROM subscriptions WHERE "tenantId" = ANY($1::uuid[])`)).toBe(0);
      expect(await count(`SELECT COUNT(*)::int AS c FROM subscription_invoices WHERE tenant_id::text = ANY(ARRAY(SELECT unnest($1::uuid[])::text))`)).toBe(0);
      expect(await count(`SELECT COUNT(*)::int AS c FROM password_resets WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = ANY($1::uuid[]))`)).toBe(0);
    });

    it('sendInvitations issues exactly one set-password token per created owner', async () => {
      const rows = [row('inv1'), row('inv2')];
      const res = await upload('commit', await xlsx([HEADER, ...rows]), { sendInvitations: 'true' }).expect(201);
      expect(res.body).toMatchObject({ created: 2, invited: 2 });
      const emails = rows.map((r) => r[2]);
      const tokens = await e2e.dataSource.query(
        `SELECT u.email, COUNT(*)::int AS n FROM password_resets p JOIN users u ON u.id = p."userId" WHERE u.email = ANY($1::text[]) GROUP BY u.email`,
        [emails],
      );
      expect(tokens.map((t: { n: number }) => t.n)).toEqual([1, 1]);
    });

    it('a sales rep that is inactive or not a sales employee blocks only that row', async () => {
      const inactive = await createPlatformActor(ROLE.PLATFORM_SALES, 'off');
      await e2e.dataSource.query(`UPDATE users SET is_active = false WHERE id = $1`, [inactive.userId]);
      const inactiveEmail = (await e2e.dataSource.query(`SELECT email FROM users WHERE id = $1`, [inactive.userId]))[0].email;
      const supportEmail = (await e2e.dataSource.query(`SELECT email FROM users WHERE id = $1`, [support.userId]))[0].email;
      const rows = [
        row('rp1', { sales_rep_email: inactiveEmail }),
        row('rp2', { sales_rep_email: supportEmail }),
        row('rp3', { sales_rep_email: repEmail }),
      ];
      const res = await upload('commit', await xlsx([HEADER, ...rows])).expect(201);
      expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual(['sales_rep_not_found', 'sales_rep_not_found', 'created']);
    });

    it('unknown body fields cannot smuggle a role, tenant, plan or amount', async () => {
      const r = row('mass');
      await upload('commit', await xlsx([HEADER, r]), { role: ROLE.SUPER_ADMIN, planId: randomUUID(), amount: '100' }).expect(400);
      await upload('commit', await xlsx([HEADER, r]), { assignmentKind: 'boss' }).expect(400);
      expect(await countBySlugs(slugsOf([r]))).toBe(0);
    });

    it('writes ONE audit entry with counts and ids but no personal data', async () => {
      const r = row('aud');
      const res = await upload('commit', await xlsx([HEADER, r])).expect(201);
      const [log] = await e2e.dataSource.query(
        `SELECT new_values FROM audit_logs WHERE action = 'platform_admin.sales.clinic_import_committed' AND entity_id = $1`,
        [res.body.importId],
      );
      expect(log.new_values).toMatchObject({ totalRows: 1, created: 1 });
      expect(JSON.stringify(log.new_values)).not.toMatch(/@|CR-|ClinicImp/);
    });
  });

  // ───────────────────────── atomicity & concurrency ─────────────────────────

  describe('atomicity and concurrency', () => {
    it('a failure while creating a clinic leaves NO orphan tenant, user or assignment, and other rows still import', async () => {
      const rows = [row('at1'), row('at2', { sales_rep_email: repEmail }), row('at3')];
      const original = AuthService.prototype.createUserWithRole;
      jest.spyOn(AuthService.prototype, 'createUserWithRole').mockImplementation(function (this: AuthService, ...args) {
        if (args[1].email === rows[1][2]) return Promise.reject(new Error('simulated owner-account failure'));
        return original.apply(this, args);
      });

      const res = await upload('commit', await xlsx([HEADER, ...rows])).expect(201);
      expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual(['created', 'failed', 'created']);
      expect(res.body).toMatchObject({ created: 2, failed: 1 });
      // The tenant row of the failed clinic was rolled back with it.
      expect(await tenantBySlug(rows[1][4] as string)).toBeUndefined();
      expect(await e2e.dataSource.query(`SELECT 1 FROM users WHERE email = $1`, [rows[1][2]])).toHaveLength(0);
      expect(await e2e.dataSource.query(`SELECT 1 FROM tenant_settings ts JOIN tenants t ON t.id = ts.tenant_id WHERE t.slug = $1`, [rows[1][4]])).toHaveLength(0);
      // The error body leaks nothing about the failure.
      expect(JSON.stringify(res.body)).not.toMatch(/simulated|stack|password/i);

      // After the cause is fixed, re-running the SAME file creates only the missing clinic.
      jest.restoreAllMocks();
      const again = await upload('commit', await xlsx([HEADER, ...rows])).expect(201);
      expect(again.body.rows.map((r: { status: string }) => r.status)).toEqual(['already_exists', 'created', 'already_exists']);
    });

    it('a failure after the owner is created (the rep assignment) also rolls the whole clinic back', async () => {
      const r = row('atrep', { sales_rep_email: repEmail });
      jest.spyOn(SalesAssignmentService.prototype, 'assignBatch').mockRejectedValue(new Error('assign down'));
      const res = await upload('commit', await xlsx([HEADER, r])).expect(201);
      expect(res.body.rows[0].status).toBe('failed');
      expect(await tenantBySlug(r[4] as string)).toBeUndefined();
      expect(await e2e.dataSource.query(`SELECT 1 FROM users WHERE email = $1`, [r[2]])).toHaveLength(0);
    });

    it('concurrent commits of the SAME data create each clinic exactly once', async () => {
      const rows = [row('cc1'), row('cc2'), row('cc3'), row('cc4')];
      const a = await xlsx([HEADER, ...rows]);
      // Same clinics, different bytes (extra column, reversed order) so the
      // in-process same-file guard cannot be what saves us: the unique indexes must.
      const b = await xlsx([[...HEADER, 'legal_name'], ...[...rows].reverse().map((r) => [...r, 'x'])]);
      const [ra, rb] = await Promise.all([upload('commit', a), upload('commit', b)]);
      expect([ra.status, rb.status]).toEqual([201, 201]);
      expect(ra.body.created + rb.body.created).toBe(4);
      expect(ra.body.failed + rb.body.failed).toBe(0);
      expect(await countBySlugs(slugsOf(rows))).toBe(4);
      const emails = rows.map((r) => r[2]);
      expect((await e2e.dataSource.query(`SELECT COUNT(*)::int AS c FROM users WHERE email = ANY($1::text[])`, [emails]))[0].c).toBe(4);
    });

    it('a double-submit of the identical file is refused while the first is running', async () => {
      const rows = [row('ds1'), row('ds2'), row('ds3')];
      const file = await xlsx([HEADER, ...rows]);
      const results = await Promise.all([upload('commit', file), upload('commit', file)]);
      const statuses = results.map((r) => r.status).sort();
      // Either the guard refused the twin (201 + 409) or they ran back to back (201 + 201 with the second a no-op).
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);
      expect(await countBySlugs(slugsOf(rows))).toBe(3);
    });
  });

  // ───────────────────────── no regression ─────────────────────────

  describe('existing clinic creation is unaffected', () => {
    it('POST /tenants (platform create) still works and still conflicts on a taken slug', async () => {
      const slug = `imp-${RUN.toLowerCase()}-platform-create`;
      const body = {
        name: 'Platform Created',
        slug,
        commercialRegistrationNumber: 'CR-PC',
        contactEmail: `pc-${RUN}@example.test`,
      };
      const ok = await request(http()).post(`${API}/tenants`).set(...authHeader(admin.token)).send(body).expect(201);
      expect(ok.body.slug).toBe(slug);
      await request(http()).post(`${API}/tenants`).set(...authHeader(admin.token)).send({ ...body, contactEmail: `pc2-${RUN}@example.test` }).expect(409);
      const events = await e2e.dataSource.query(`SELECT action FROM tenant_approval_events WHERE "tenantId" = $1`, [ok.body.id]);
      expect(events).toEqual([{ action: 'CREATED' }]);
    });
  });
});
