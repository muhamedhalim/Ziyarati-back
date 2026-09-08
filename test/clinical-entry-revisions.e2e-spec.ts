/**
 * `GET /clinical/entries/:id/revisions` — real HTTP against the REAL
 * AppModule and a migration-built database (see `jest-e2e.env.js`: the e2e
 * suite forces `TYPEORM_SYNCHRONIZE=false` against `ziyarati_e2e`, exactly
 * the shape production is built in — unlike the shared dev DB, which runs
 * with `TYPEORM_SYNCHRONIZE=true` and silently masks entity/column drift).
 *
 * This pins the fix for a production 500 (`DATABASE_ERROR`) on this route:
 * migration `1730076000000-ClinicalRecords` created
 * `clinical_entry_revisions.changed_byId` (wrong — TypeORM's naming
 * strategy actually expects `changedById` for the `changed_by` relation),
 * so every query touching that column failed with Postgres 42703 on a
 * database built purely from migrations. Fixed by
 * `1730098000000-ClinicalEntryRevisionChangedByJoinColumnDrift`.
 *
 * Covers: entry with revisions, entry with none, non-existent entry,
 * unauthenticated, unauthorized (missing permission), cross-tenant entry,
 * invalid UUID, and (via a repository-mocked app instance) that a genuine
 * database failure still surfaces as 500 DATABASE_ERROR — never a silently
 * swallowed empty array.
 */
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { requestContext } from '../src/common/middleware/request-context.middleware';
import { TenantContextService } from '../src/core/tenant-context/tenant-context.service';
import { registerSecurityHeaders } from '../src/config/security-headers';
import { MetaGraphClient } from '../src/modules/whatsapp/meta/meta-graph.client';
import { MetaWhatsappProvider } from '../src/modules/whatsapp/providers/meta-whatsapp.provider';

import { Customer } from '../src/entities/CRM/Customer';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { RolePermission } from '../src/entities/Auth&RBAC/RolePermission';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Permission } from '../src/entities/Auth&RBAC/Permission';
import { ClinicalEntryRevision } from '../src/entities/Clinical/ClinicalEntryRevision';
import { PERMISSION } from '../src/rbac/rbac.constants';

const API = '/api/v1';

async function mintTokenFor(
  e2e: E2eApp,
  userId: string,
  tenantId: string,
): Promise<string> {
  return e2e.jwt.signAsync(
    { sub: userId, tenantId, type: 'access' },
    {
      secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      expiresIn: '15m',
    },
  );
}

/** A tenant-scoped user whose custom role carries EXACTLY the given permission slugs. */
async function createActor(
  e2e: E2eApp,
  tenantId: string,
  slugs: string[],
  label: string,
) {
  const permissions = e2e.dataSource.getRepository(Permission);
  const roles = e2e.dataSource.getRepository(Role);
  const rolePermissions = e2e.dataSource.getRepository(RolePermission);
  const users = e2e.dataSource.getRepository(User);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const perms = slugs.length
    ? await permissions
        .createQueryBuilder('p')
        .where('p.slug IN (:...slugs)', { slugs })
        .getMany()
    : [];
  if (perms.length !== slugs.length) {
    throw new Error(
      `Seeded permissions missing for: ${slugs.join(', ')} — run the RBAC seed first.`,
    );
  }

  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const role = await roles.save(
    roles.create({
      tenant: { id: tenantId } as any,
      name: `T-revisions ${suffix}`,
      slug: `t-revisions-${suffix}`,
      is_system: false,
    }),
  );
  if (perms.length) {
    await rolePermissions.save(
      perms.map((p) => rolePermissions.create({ role, permission: p })),
    );
  }

  const user = await users.save(
    users.create({
      tenant: { id: tenantId } as any,
      email: `${suffix}@example.test`,
      full_name: `T-revisions ${suffix}`,
      is_active: true,
    }),
  );
  await userRoles.save(
    userRoles.create({
      user: { id: user.id } as User,
      role: { id: role.id } as Role,
    }),
  );

  const token = await mintTokenFor(e2e, user.id, tenantId);
  return { userId: user.id, roleId: role.id, token };
}

describe('GET /clinical/entries/:id/revisions (real HTTP, migration-built DB)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let customerId: string;
  let reader: { userId: string; roleId: string; token: string };
  let manager: { userId: string; roleId: string; token: string };

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 't-revisions');

    const customers = e2e.dataSource.getRepository(Customer);
    const customer = await customers.save(
      customers.create({
        tenant: { id: owner.tenantId } as any,
        full_name: 'Revisions Test Patient',
        phone: '+966511111201',
        email: `revisions-patient-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    customerId = customer.id;

    reader = await createActor(
      e2e,
      owner.tenantId,
      [PERMISSION.CLINICAL_RECORDS_READ],
      'reader',
    );
    manager = await createActor(
      e2e,
      owner.tenantId,
      [PERMISSION.CLINICAL_RECORDS_READ, PERMISSION.CLINICAL_RECORDS_MANAGE],
      'manager',
    );
  }, 60_000);

  afterAll(async () => {
    const q = (sql: string) => e2e.dataSource.query(sql, [owner.tenantId]);
    await q(`DELETE FROM clinical_access_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM clinical_entry_revisions WHERE "tenantId" = $1`);
    await q(`DELETE FROM clinical_entries WHERE "tenantId" = $1`);
    await q(`DELETE FROM customers WHERE "tenantId" = $1`);
    await q(
      `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
    );
    await q(
      `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
    );
    await q(`DELETE FROM roles WHERE "tenantId" = $1`);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM users WHERE "tenantId" = $1`);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM tenants WHERE id = $1`);
    await e2e.app.close();
  }, 60_000);

  it('invalid UUID — 400, never reaches the database', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/clinical/entries/not-a-uuid/revisions`)
      .set(...authHeader(reader.token));
    expect(res.status).toBe(400);
  });

  it('unauthenticated — 401', async () => {
    const res = await request(e2e.app.getHttpServer()).get(
      `${API}/clinical/entries/${randomUUID()}/revisions`,
    );
    expect(res.status).toBe(401);
  });

  it('unauthorized — a caller with neither clinical permission is refused with 403', async () => {
    const nobody = await createActor(e2e, owner.tenantId, [], 'nobody');
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/clinical/entries/${randomUUID()}/revisions`)
      .set(...authHeader(nobody.token));
    expect(res.status).toBe(403);
  });

  it('entry does not exist — 404, not 500', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/clinical/entries/${randomUUID()}/revisions`)
      .set(...authHeader(reader.token));
    expect(res.status).toBe(404);
  });

  it("another tenant's entry id — 404, never 403 or 200 (no enumeration)", async () => {
    const otherOwner = await createOwnerFixture(e2e, 't-revisions-foreign');
    const customers = e2e.dataSource.getRepository(Customer);
    const otherCustomer = await customers.save(
      customers.create({
        tenant: { id: otherOwner.tenantId } as any,
        full_name: 'Foreign Tenant Patient',
        phone: '+966511111202',
        email: `foreign-patient-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    const createRes = await request(e2e.app.getHttpServer())
      .post(`${API}/clinical/patients/${otherCustomer.id}/entries`)
      .set(...authHeader(otherOwner.token))
      .send({ kind: 'NOTE', data: { text: 'foreign tenant entry' } });
    expect(createRes.status).toBe(201);
    const foreignEntryId = createRes.body.id;

    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/clinical/entries/${foreignEntryId}/revisions`)
      .set(...authHeader(reader.token));
    expect(res.status).toBe(404);

    const q = (sql: string) => e2e.dataSource.query(sql, [otherOwner.tenantId]);
    await q(`DELETE FROM clinical_access_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM clinical_entries WHERE "tenantId" = $1`);
    await q(`DELETE FROM customers WHERE "tenantId" = $1`);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM tenants WHERE id = $1`);
  });

  it('entry exists but has never been corrected — 200 with an empty array', async () => {
    const createRes = await request(e2e.app.getHttpServer())
      .post(`${API}/clinical/patients/${customerId}/entries`)
      .set(...authHeader(manager.token))
      .send({ kind: 'NOTE', data: { text: 'never corrected' } });
    expect(createRes.status).toBe(201);

    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/clinical/entries/${createRes.body.id}/revisions`)
      .set(...authHeader(reader.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('entry exists and has revisions — 200, newest first, exercising the changed_by join TypeORM actually issues', async () => {
    const createRes = await request(e2e.app.getHttpServer())
      .post(`${API}/clinical/patients/${customerId}/entries`)
      .set(...authHeader(manager.token))
      .send({ kind: 'NOTE', data: { text: 'v1' } });
    expect(createRes.status).toBe(201);
    const entryId = createRes.body.id;

    const correction1 = await request(e2e.app.getHttpServer())
      .patch(`${API}/clinical/entries/${entryId}`)
      .set(...authHeader(manager.token))
      .send({ version: 1, data: { text: 'v2' } });
    expect(correction1.status).toBe(200);

    const correction2 = await request(e2e.app.getHttpServer())
      .patch(`${API}/clinical/entries/${entryId}`)
      .set(...authHeader(manager.token))
      .send({ version: 2, data: { text: 'v3' } });
    expect(correction2.status).toBe(200);

    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/clinical/entries/${entryId}/revisions`)
      .set(...authHeader(reader.token));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    // Newest first (FR-H008): the last correction's "before" snapshot (v2) comes first.
    expect(res.body[0].previous_data).toEqual({ text: 'v2' });
    expect(res.body[1].previous_data).toEqual({ text: 'v1' });
    for (const rev of res.body) {
      expect(rev.changed_by).toMatchObject({ id: manager.userId });
      expect(rev).toHaveProperty('created_at');
    }
  });

  describe('a genuine database failure is never swallowed into a 200 []', () => {
    let failingApp: INestApplication;
    let failingDataSource: DataSource;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(MetaGraphClient)
        .useValue({})
        .overrideProvider(MetaWhatsappProvider)
        .useValue({})
        .overrideProvider(getRepositoryToken(ClinicalEntryRevision))
        .useValue({
          find: jest.fn().mockRejectedValue(
            new QueryFailedError(
              'SELECT * FROM clinical_entry_revisions',
              [],
              new Error(
                'column ClinicalEntryRevision.changedById does not exist',
              ),
            ),
          ),
        } as unknown as Repository<ClinicalEntryRevision>)
        .compile();

      failingApp = moduleRef.createNestApplication({ rawBody: true });
      registerSecurityHeaders(failingApp);
      const tenantContext = failingApp.get(TenantContextService);
      failingApp.use(requestContext);
      failingApp.use(
        (req: { requestId?: string }, _res: unknown, next: () => void) =>
          tenantContext.run(() => {
            tenantContext.setCorrelationId(req.requestId ?? null);
            next();
          }),
      );
      failingApp.useGlobalFilters(new AllExceptionsFilter());
      failingApp.use(cookieParser());
      failingApp.setGlobalPrefix('api/v1');
      failingApp.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          transformOptions: { enableImplicitConversion: true },
        }),
      );
      await failingApp.init();
      failingDataSource = failingApp.get(DataSource);
    }, 60_000);

    afterAll(async () => {
      await failingApp?.close();
    }, 30_000);

    it('propagates as 500 DATABASE_ERROR, with no SQL/schema detail in the response body', async () => {
      const jwt = failingApp.get(JwtService);
      const config = failingApp.get(ConfigService);
      const customers = failingDataSource.getRepository(Customer);
      const entries = failingDataSource.getRepository('ClinicalEntry');

      // Reuses this suite's already-created tenant/customer/permissioned
      // reader — this app instance only swaps the revisions repository.
      const entry = await entries.save(
        entries.create({
          tenant: { id: owner.tenantId },
          customer: { id: customerId },
          kind: 'NOTE',
          data: { text: 'db-failure-path' },
          recorded_at: new Date(),
          author: { id: reader.userId },
        } as any),
      );

      const token = await jwt.signAsync(
        { sub: reader.userId, tenantId: owner.tenantId, type: 'access' },
        {
          secret: config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
          expiresIn: '15m',
        },
      );

      const res = await request(failingApp.getHttpServer())
        .get(`${API}/clinical/entries/${(entry as any).id}/revisions`)
        .set(...authHeader(token));

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('DATABASE_ERROR');
      expect(res.body.message).toBe('A database error occurred');
      expect(Array.isArray(res.body)).toBe(false);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/changedById|clinical_entry_revisions|SELECT/i);

      await failingDataSource
        .getRepository('ClinicalEntry')
        .delete({ id: (entry as any).id } as any);
    });
  });
});
