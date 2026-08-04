/**
 * FND-040 / M-01 — real-PostgreSQL proof that `customers.email` is currently
 * GLOBALLY unique (`UQ_8536b8b85c06969f84f0c098b03 UNIQUE (email)`, confirmed
 * live in data-model.md §D-1), not tenant-scoped like its sibling
 * `IDX_4c0d50bb04cf7976e922b5781d UNIQUE ("tenantId", phone)`. Two clinics
 * that happen to share a walk-in patient's email cannot both record that
 * customer today — the second tenant's insert is rejected outright.
 *
 * Goes straight at the repository/database layer (real Postgres via
 * `createE2eApp()`'s DataSource), not the HTTP create endpoint — this finding
 * is a database-constraint defect, and routing through
 * `RequireActiveSubscription`/`crm.customers.manage` would entangle the test
 * with unrelated billing/permission fixture setup that has nothing to do with
 * M-01. The constraint fires identically regardless of caller.
 */
import { randomUUID } from 'node:crypto';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { TenantApprovalStatus } from '../src/entities/enums';

const SUITE_MARKER = `t032-${randomUUID().slice(0, 8)}`;

async function makeTenant(e2e: E2eApp, label: string): Promise<string> {
  const tenants = e2e.dataSource.getRepository(Tenant);
  const tenant = await tenants.save(
    tenants.create({
      name: `E2E ${label} ${SUITE_MARKER}`,
      slug: `e2e-${label}-${SUITE_MARKER}`,
      contact_email: `${label}-${SUITE_MARKER}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );
  return tenant.id;
}

describe('Customer email uniqueness — real Postgres (FND-040 / M-01)', () => {
  let e2e: E2eApp;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    tenantAId = await makeTenant(e2e, 'tenant-a');
    tenantBId = await makeTenant(e2e, 'tenant-b');
  }, 60_000);

  afterAll(async () => {
    await cleanupTenant(e2e, tenantAId);
    await cleanupTenant(e2e, tenantBId);
    await e2e.app.close();
  }, 30_000);

  it('[FND-040] refuses tenant B a customer email that tenant A already uses — the exact defect: this MUST become allowed under tenant-scoped uniqueness', async () => {
    const customers = e2e.dataSource.getRepository(Customer);
    const sharedEmail = `shared-${SUITE_MARKER}@example.test`;

    await customers.save(
      customers.create({
        tenant: { id: tenantAId } as Tenant,
        full_name: 'Tenant A Patient',
        phone: `+9665${SUITE_MARKER.slice(-8)}0`,
        email: sharedEmail,
      }),
    );

    // TODAY: rejected by the GLOBAL unique index — proving the defect. Once
    // M-01 replaces it with UNIQUE ("tenantId", email), this insert must
    // SUCCEED, since tenant B has never used this email before.
    await expect(
      customers.save(
        customers.create({
          tenant: { id: tenantBId } as Tenant,
          full_name: 'Tenant B Patient',
          phone: `+9665${SUITE_MARKER.slice(-8)}1`,
          email: sharedEmail,
        }),
      ),
    ).resolves.toMatchObject({ email: sharedEmail });
  });

  it('a duplicate email within the SAME tenant is still refused (regression guard — must hold both before and after M-01)', async () => {
    const customers = e2e.dataSource.getRepository(Customer);
    const sameTenantEmail = `same-tenant-${SUITE_MARKER}@example.test`;

    await customers.save(
      customers.create({
        tenant: { id: tenantAId } as Tenant,
        full_name: 'First',
        phone: `+9665${SUITE_MARKER.slice(-8)}2`,
        email: sameTenantEmail,
      }),
    );

    await expect(
      customers.save(
        customers.create({
          tenant: { id: tenantAId } as Tenant,
          full_name: 'Second (duplicate email, same tenant)',
          phone: `+9665${SUITE_MARKER.slice(-8)}3`,
          email: sameTenantEmail,
        }),
      ),
    ).rejects.toThrow();
  });
});
