/**
 * Real-PostgreSQL proof for the CRM customer identity fix
 * (CrmCustomerSoftDeleteAwareUniqueness1730059000000):
 *
 *  1. `phone` is NOT a uniqueness key — two live customers in the same
 *     tenant may share one.
 *  2. Soft-deleting a customer (`CustomerService.remove`, which sets
 *     `deleted_at` rather than hard-deleting) frees up their `email` and
 *     `national_id` for reuse — a brand-new customer can be created with
 *     the exact same phone/email/national_id right after, without a false
 *     "already exists" conflict. The original (soft-deleted) row is left
 *     untouched in the database — this is NOT a hard delete.
 *
 * Goes through `CustomerService` (the same service the controller calls),
 * not the bare repository — this proves the fix at the Service → Repository
 * → Postgres layers the way the real Create/Delete/Create-again flow does,
 * while skipping HTTP/auth/permission wiring that has nothing to do with
 * this defect (same rationale as customer-email-uniqueness.e2e-spec.ts).
 */
import { randomUUID } from 'node:crypto';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { TenantApprovalStatus } from '../src/entities/enums';
import { CustomerService } from '../src/modules/crm/customer.service';
import { ErrorCode } from '../src/common/errors';

const SUITE_MARKER = `crmrecreate-${randomUUID().slice(0, 8)}`;

describe('CRM customer: phone sharing + soft-delete-aware recreation — real Postgres', () => {
  let e2e: E2eApp;
  let tenantId: string;
  let customerService: CustomerService;

  beforeAll(async () => {
    e2e = await createE2eApp();
    customerService = e2e.app.get(CustomerService);

    const tenants = e2e.dataSource.getRepository(Tenant);
    const tenant = await tenants.save(
      tenants.create({
        name: `E2E CRM Recreate ${SUITE_MARKER}`,
        slug: `e2e-${SUITE_MARKER}`,
        contact_email: `${SUITE_MARKER}@example.test`,
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      }),
    );
    tenantId = tenant.id;
  }, 60_000);

  afterAll(async () => {
    await cleanupTenant(e2e, tenantId);
    await e2e.app.close();
  }, 30_000);

  it('[requirement 3] allows two live customers in the same tenant to share a phone number', async () => {
    const phone = `+9665${SUITE_MARKER.slice(-8)}0`;

    const first = await customerService.create(tenantId, {
      full_name: 'First Sibling',
      phone,
      email: `first-${SUITE_MARKER}@example.test`,
    } as any);
    const second = await customerService.create(tenantId, {
      full_name: 'Second Sibling',
      phone, // same phone, deliberately
      email: `second-${SUITE_MARKER}@example.test`,
    } as any);

    expect(second.id).not.toBe(first.id);
    expect(second.phone).toBe(phone);
    expect(first.phone).toBe(phone);
  });

  it('[requirements 4 & 6] soft-deletes a customer, then allows a NEW customer with the exact same phone/email/national_id', async () => {
    const phone = `+9665${SUITE_MARKER.slice(-8)}1`;
    const email = `recreate-${SUITE_MARKER}@example.test`;
    const nationalId = `NID-${SUITE_MARKER}`;

    const original = await customerService.create(tenantId, {
      full_name: 'Original Patient',
      phone,
      email,
      national_id: nationalId,
    } as any);

    // Same guard `CustomerController.remove` calls — a real soft delete.
    await customerService.remove(tenantId, original.id);

    // A duplicate email OR national_id, on its own, is still refused for a
    // LIVE row (regression guard for requirement 6 — deleting one customer
    // must not blanket-disable the uniqueness rule for everyone else).
    const stillActive = await customerService.create(tenantId, {
      full_name: 'Unrelated Patient',
      phone: `+9665${SUITE_MARKER.slice(-8)}2`,
      email: `unrelated-${SUITE_MARKER}@example.test`,
    } as any);
    await expect(
      customerService.create(tenantId, {
        full_name: 'Should collide',
        phone: `+9665${SUITE_MARKER.slice(-8)}3`,
        email: `unrelated-${SUITE_MARKER}@example.test`, // stillActive's email
      } as any),
    ).rejects.toThrow();

    // The actual regression this migration fixes: re-create with the
    // SAME phone/email/national_id as the now-deleted original.
    const recreated = await customerService.create(tenantId, {
      full_name: 'Recreated Patient',
      phone,
      email,
      national_id: nationalId,
    } as any);

    expect(recreated.id).not.toBe(original.id);
    expect(recreated.phone).toBe(phone);
    expect(recreated.email).toBe(email);
    expect(recreated.national_id).toBe(nationalId);

    // The original row was SOFT-deleted, not erased — still present with
    // deleted_at set, proving this is delete-then-recreate, not a wipe.
    const customers = e2e.dataSource.getRepository(Customer);
    const originalRow = await customers.findOne({
      where: { id: original.id },
      withDeleted: true,
    });
    expect(originalRow).not.toBeNull();
    expect(originalRow?.deleted_at).not.toBeNull();

    await customers.softDelete(stillActive.id);
  });

  it('national_id uniqueness among LIVE rows is still enforced (not weakened by the phone/soft-delete changes)', async () => {
    const nationalId = `NID-LIVE-${SUITE_MARKER}`;
    await customerService.create(tenantId, {
      full_name: 'Holder',
      phone: `+9665${SUITE_MARKER.slice(-8)}4`,
      email: `holder-${SUITE_MARKER}@example.test`,
      national_id: nationalId,
    } as any);

    await expect(
      customerService.create(tenantId, {
        full_name: 'Collider',
        phone: `+9665${SUITE_MARKER.slice(-8)}5`,
        email: `collider-${SUITE_MARKER}@example.test`,
        national_id: nationalId,
      } as any),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });
});
