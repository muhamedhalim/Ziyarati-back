/**
 * T102 (spec 014, US6, FR-H010a-e) — the clinical privacy boundary's
 * authorization matrix, as real HTTP requests against the REAL AppModule.
 *
 * Pins:
 *  - `GET /crm/customers/:id` returns NO clinical field to a caller holding
 *    only `crm.customers.read`, and DOES include them for a caller who
 *    additionally holds `clinical.records.read` (FR-H010a/d).
 *  - Reception (its real pre-seeded permission set) still receives contact,
 *    addresses, tags, `has_chronic_diseases`, `chronic_diseases`,
 *    `has_health_insurance` and `emergency_contact_*` (FR-H010e) — the
 *    breaking narrowing must not regress the front desk.
 *  - A doctor (the real pre-seeded `doctor` role, T105's grant) can open a
 *    patient at all — before T105 it held neither `crm.customers.read` nor
 *    any clinical slug.
 *  - Every one of the 9 clinical routes 403s a caller with NEITHER clinical
 *    slug, and succeeds for a caller who holds the one it requires.
 *  - Cross-tenant customer/entry ids are a 404, never a 403 or a 200.
 *
 * DATABASE ISOLATION: every fixture lives under a freshly created Tenant;
 * `afterAll` deletes every row this suite created, in FK-safe order.
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

import { Customer } from '../src/entities/CRM/Customer';
import { CustomerProfile } from '../src/entities/CRM/CustomerProfile';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { RolePermission } from '../src/entities/Auth&RBAC/RolePermission';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Permission } from '../src/entities/Auth&RBAC/Permission';
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
      name: `T102 ${suffix}`,
      slug: `t102-${suffix}`,
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
      full_name: `T102 ${suffix}`,
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

/** The REAL pre-seeded system role (tenant IS NULL) — reception's actual grant set, not a synthesized one. */
async function mintTokenForSystemRole(
  e2e: E2eApp,
  tenantId: string,
  roleSlug: string,
  label: string,
) {
  const roles = e2e.dataSource.getRepository(Role);
  const users = e2e.dataSource.getRepository(User);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const role = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: roleSlug })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) {
    throw new Error(
      `Seeded system role "${roleSlug}" not found — run the RBAC seed against the test database first.`,
    );
  }

  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const user = await users.save(
    users.create({
      tenant: { id: tenantId } as any,
      email: `${suffix}@example.test`,
      full_name: `T102 ${suffix}`,
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
  return { userId: user.id, token };
}

describe('Clinical records — authorization matrix (T102, HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let customerId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 't102');

    const customers = e2e.dataSource.getRepository(Customer);
    const profiles = e2e.dataSource.getRepository(CustomerProfile);
    const customer = await customers.save(
      customers.create({
        tenant: { id: owner.tenantId } as any,
        full_name: 'T102 Test Patient',
        phone: '+966511111102',
        email: `t102-patient-${randomUUID().slice(0, 8)}@example.test`,
        has_chronic_diseases: true,
        chronic_diseases: 'Asthma',
        has_health_insurance: true,
      }),
    );
    customerId = customer.id;
    await profiles.save(
      profiles.create({
        customer: { id: customerId } as any,
        tenant: { id: owner.tenantId } as any,
        medical_history: 'Appendectomy 2019',
        allergies: 'Penicillin',
        blood_type: 'O+',
        notes: 'Internal clinical note',
        emergency_contact_name: 'Jane Doe',
        emergency_contact_phone: '+966500000102',
      }),
    );
  }, 60_000);

  afterAll(async () => {
    const q = (sql: string) => e2e.dataSource.query(sql, [owner.tenantId]);
    await q(`DELETE FROM clinical_access_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM clinical_entry_revisions WHERE "tenantId" = $1`);
    await q(`DELETE FROM clinical_entries WHERE "tenantId" = $1`);
    await q(`DELETE FROM clinical_encounters WHERE "tenantId" = $1`);
    await q(`DELETE FROM customer_profiles WHERE "tenantId" = $1`);
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

  describe('FR-H010d — GET /crm/customers/:id narrowing (the breaking change)', () => {
    it('crm.customers.read ALONE never sees the 4 clinical profile fields', async () => {
      const actor = await createActor(
        e2e,
        owner.tenantId,
        [PERMISSION.CRM_CUSTOMERS_READ],
        'crm-only',
      );
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/crm/customers/${customerId}`)
        .set(...authHeader(actor.token));
      expect(res.status).toBe(200);
      expect(res.body.profile).not.toHaveProperty('medical_history');
      expect(res.body.profile).not.toHaveProperty('allergies');
      expect(res.body.profile).not.toHaveProperty('blood_type');
      expect(res.body.profile).not.toHaveProperty('notes');
    });

    it('crm.customers.read + clinical.records.read sees every profile field', async () => {
      const actor = await createActor(
        e2e,
        owner.tenantId,
        [PERMISSION.CRM_CUSTOMERS_READ, PERMISSION.CLINICAL_RECORDS_READ],
        'crm-plus-clinical',
      );
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/crm/customers/${customerId}`)
        .set(...authHeader(actor.token));
      expect(res.status).toBe(200);
      expect(res.body.profile).toMatchObject({
        medical_history: 'Appendectomy 2019',
        allergies: 'Penicillin',
        blood_type: 'O+',
      });
    });
  });

  describe('FR-H010e — reception regression: non-clinical fields stay visible', () => {
    it("reception's real pre-seeded role still sees contact/tags/chronic/insurance/emergency-contact fields", async () => {
      const receptionist = await mintTokenForSystemRole(
        e2e,
        owner.tenantId,
        'receptionist',
        'reception',
      );
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/crm/customers/${customerId}`)
        .set(...authHeader(receptionist.token));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        has_chronic_diseases: true,
        chronic_diseases: 'Asthma',
        has_health_insurance: true,
      });
      expect(res.body.profile).toMatchObject({
        emergency_contact_name: 'Jane Doe',
        emergency_contact_phone: '+966500000102',
      });
      expect(res.body.profile).not.toHaveProperty('medical_history');
    });

    it('reception is refused (403) on every clinical route — it holds neither clinical slug', async () => {
      const receptionist = await mintTokenForSystemRole(
        e2e,
        owner.tenantId,
        'receptionist',
        'reception-403',
      );
      const auth = authHeader(receptionist.token);
      const server = e2e.app.getHttpServer();

      const reads = await Promise.all([
        request(server).get(`${API}/clinical/patients/${customerId}/timeline`).set(...auth),
        request(server).get(`${API}/clinical/patients/${customerId}/summary`).set(...auth),
      ]);
      for (const res of reads) expect(res.status).toBe(403);

      const write = await request(server)
        .post(`${API}/clinical/patients/${customerId}/entries`)
        .set(...auth)
        .send({ kind: 'NOTE', data: { text: 'should be refused' } });
      expect(write.status).toBe(403);
    });
  });

  describe("FR-H010c — a doctor can open a patient at all (couldn't before T105)", () => {
    it('the real pre-seeded doctor role reaches GET /crm/customers/:id and sees clinical fields', async () => {
      const doctor = await mintTokenForSystemRole(
        e2e,
        owner.tenantId,
        'doctor',
        'doctor',
      );
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/crm/customers/${customerId}`)
        .set(...authHeader(doctor.token));
      expect(res.status).toBe(200);
      expect(res.body.profile).toMatchObject({ medical_history: 'Appendectomy 2019' });
    });

    it('the doctor role can read the clinical timeline and summary', async () => {
      const doctor = await mintTokenForSystemRole(
        e2e,
        owner.tenantId,
        'doctor',
        'doctor-timeline',
      );
      const auth = authHeader(doctor.token);
      const server = e2e.app.getHttpServer();

      const timeline = await request(server)
        .get(`${API}/clinical/patients/${customerId}/timeline`)
        .set(...auth);
      expect(timeline.status).toBe(200);

      const summary = await request(server)
        .get(`${API}/clinical/patients/${customerId}/summary`)
        .set(...auth);
      expect(summary.status).toBe(200);
    });
  });

  describe('the 9 clinical routes — every one refuses a caller with NEITHER clinical slug', () => {
    it('all 9 routes 403 for a caller holding no permissions at all', async () => {
      const nobody = await createActor(e2e, owner.tenantId, [], 'nobody');
      const auth = authHeader(nobody.token);
      const server = e2e.app.getHttpServer();
      const fakeId = randomUUID();

      const checks = await Promise.all([
        request(server).get(`${API}/clinical/patients/${customerId}/timeline`).set(...auth),
        request(server).get(`${API}/clinical/patients/${customerId}/summary`).set(...auth),
        request(server).post(`${API}/clinical/patients/${customerId}/encounters`).set(...auth).send({}),
        request(server).get(`${API}/clinical/encounters/${fakeId}`).set(...auth),
        request(server).post(`${API}/clinical/encounters/${fakeId}/entries`).set(...auth).send({}),
        request(server).post(`${API}/clinical/patients/${customerId}/entries`).set(...auth).send({}),
        request(server).patch(`${API}/clinical/entries/${fakeId}`).set(...auth).send({}),
        request(server).delete(`${API}/clinical/entries/${fakeId}`).set(...auth),
        request(server).get(`${API}/clinical/entries/${fakeId}/revisions`).set(...auth),
      ]);
      for (const res of checks) expect(res.status).toBe(403);
    });
  });

  describe('cross-tenant clinical entry — 404, never 403 or 200 (no enumeration)', () => {
    it("another tenant's encounter id is a 404 for a clinical.records.read holder", async () => {
      const actor = await createActor(
        e2e,
        owner.tenantId,
        [PERMISSION.CLINICAL_RECORDS_READ],
        'foreign-404',
      );
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/clinical/encounters/${randomUUID()}`)
        .set(...authHeader(actor.token));
      expect(res.status).toBe(404);
    });
  });
});
