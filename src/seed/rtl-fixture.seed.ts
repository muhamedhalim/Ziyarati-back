import { EntityManager, IsNull } from 'typeorm';
import * as bcrypt from 'bcryptjs';

import { Tenant } from '../entities/SaaS-Core/Tenant';
import { Branch } from '../entities/SaaS-Core/Branch';
import { User } from '../entities/Auth&RBAC/User';
import { Role } from '../entities/Auth&RBAC/Role';
import { UserRole } from '../entities/Auth&RBAC/UserRole';
import { BranchUser } from '../entities/Multi Branch/BranchUser';
import { StaffProfile } from '../entities/Staff/StaffProfile';
import { Customer } from '../entities/CRM/Customer';
import { Appointment } from '../entities/Calendar&Appointments/Appointment';
import { Payment } from '../entities/Payments/Payment';
import { Invoice } from '../entities/Payments/Invoice';
import { Campaign } from '../entities/Campaigns/Campaign';
import {
  AppointmentStatus,
  AppointmentPaymentStatus,
  AppointmentSource,
  PaymentStatus,
  SettlementStatus,
  InvoiceStatus,
  CampaignLifecycle,
  CampaignType,
  TenantApprovalStatus,
} from '../entities/enums';
import { ROLE } from '../rbac/rbac.constants';
import { logger } from './seed.logger';
import { SeedDataSource } from './data-source';

const BCRYPT_ROUNDS = 12;

const TENANT_SLUG = 'rtl-fixture-clinic';

/**
 * DEV-ONLY fallback credentials — used only when the RTL_* env vars are
 * unset. Guarded by the same production refusal as `admin.seed.ts:34`, so
 * these can never become live production credentials.
 */
const DEV_ONLY_FALLBACK = {
  clinicAdmin: { email: 'rtl.admin@local.test', password: 'RtlAdmin123!' },
  receptionist: {
    email: 'rtl.reception@local.test',
    password: 'RtlReception123!',
  },
} as const;

const ARABIC_CUSTOMER_NAMES = [
  'محمد العتيبي',
  'فاطمة الزهراني',
  'عبدالله القحطاني',
  'نورة الحربي',
  'خالد الدوسري',
  'سارة المطيري',
  'أحمد الشمري',
  'ريم الغامدي',
  'عمر السبيعي',
  'هند العنزي',
  'يوسف الرشيدي',
  'لينا البقمي',
];

/** Deterministic `+966 5X XXXXXXX`-shaped number, distinct per row. */
function phoneFor(index: number): string {
  return `+9665${(10000000 + index).toString().slice(-8)}`;
}

function emailFor(index: number): string {
  return `rtl.customer.${index + 1}@example.test`;
}

/**
 * Test-only RTL verification fixture (FR-043, data-model.md § 6). The
 * standalone `npm run seed` creates a platform super-admin only — an Arabic
 * table with zero rows proves nothing about column alignment, row-action
 * menus, or pagination direction (R-10). This seed adds one tenant, one
 * branch, a clinic admin + receptionist (each with a real login through the
 * normal auth endpoint), and a small deterministic set of business rows:
 * Arabic-named customers with `+966` phones, appointments, SAR
 * invoices/payments, campaigns.
 *
 * Idempotent at the tenant level — re-running against a database that
 * already has the fixture tenant is a safe no-op, so a developer can run it
 * repeatedly against a persistent local dev database.
 *
 * Constraint (tsconfig.seed.json): only `src/seed/**`, `src/entities/**`,
 * and `src/rbac/**` are on the seed program's include list, so this file
 * builds fixtures through entities and repositories directly — never an
 * application service from `src/modules/**`.
 */
export async function seedRtlFixture(manager: EntityManager): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'rtl-fixture.seed.ts refuses to run when NODE_ENV=production — this is a test-only fixture.',
    );
  }

  logger.step('Seeding RTL verification fixture');

  const tenantRepo = manager.getRepository(Tenant);
  const existing = await tenantRepo.findOne({ where: { slug: TENANT_SLUG } });
  if (existing) {
    logger.info(
      `RTL fixture tenant already exists ("${TENANT_SLUG}") — skipping`,
    );
    return;
  }

  const tenant = await tenantRepo.save(
    tenantRepo.create({
      name: 'RTL Fixture Clinic',
      slug: TENANT_SLUG,
      contact_email: 'rtl-fixture-contact@example.test',
      default_currency: 'SAR',
      default_timezone: 'Asia/Riyadh',
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );
  logger.success(`created tenant "${tenant.name}"`);

  const branchRepo = manager.getRepository(Branch);
  const branch = await branchRepo.save(
    branchRepo.create({
      tenant,
      name: 'Main Branch',
      timezone: 'Asia/Riyadh',
      is_active: true,
    }),
  );

  const roleRepo = manager.getRepository(Role);
  const ownerRole = await roleRepo.findOne({
    where: { slug: ROLE.OWNER, tenant: IsNull() },
  });
  const receptionistRole = await roleRepo.findOne({
    where: { slug: ROLE.RECEPTIONIST, tenant: IsNull() },
  });
  if (!ownerRole || !receptionistRole) {
    throw new Error(
      'owner/receptionist system roles not found — run "npm run seed" before "npm run seed:rtl".',
    );
  }

  const clinicAdminEmail =
    process.env.RTL_CLINIC_ADMIN_EMAIL?.trim() ||
    DEV_ONLY_FALLBACK.clinicAdmin.email;
  const clinicAdminPassword =
    process.env.RTL_CLINIC_ADMIN_PASSWORD ||
    DEV_ONLY_FALLBACK.clinicAdmin.password;
  const receptionistEmail =
    process.env.RTL_RECEPTIONIST_EMAIL?.trim() ||
    DEV_ONLY_FALLBACK.receptionist.email;
  const receptionistPassword =
    process.env.RTL_RECEPTIONIST_PASSWORD ||
    DEV_ONLY_FALLBACK.receptionist.password;

  const userRepo = manager.getRepository(User);
  const clinicAdmin = await userRepo.save(
    userRepo.create({
      tenant,
      email: clinicAdminEmail,
      full_name: 'RTL Clinic Admin',
      password_hash: await bcrypt.hash(clinicAdminPassword, BCRYPT_ROUNDS),
      is_active: true,
    }),
  );
  const receptionist = await userRepo.save(
    userRepo.create({
      tenant,
      email: receptionistEmail,
      full_name: 'RTL Receptionist',
      password_hash: await bcrypt.hash(receptionistPassword, BCRYPT_ROUNDS),
      is_active: true,
    }),
  );

  const userRoleRepo = manager.getRepository(UserRole);
  await userRoleRepo.save([
    userRoleRepo.create({ user: clinicAdmin, role: ownerRole }),
    userRoleRepo.create({ user: receptionist, role: receptionistRole }),
  ]);

  const branchUserRepo = manager.getRepository(BranchUser);
  await branchUserRepo.save([
    branchUserRepo.create({
      tenant,
      branch,
      user: clinicAdmin,
      is_primary: true,
    }),
    branchUserRepo.create({
      tenant,
      branch,
      user: receptionist,
      is_primary: false,
    }),
  ]);

  // Appointment.staff is a required FK to StaffProfile (not User) — the
  // clinic admin doubles as the seeded staff member so appointments have
  // someone to attach to.
  const staffProfile = await manager.getRepository(StaffProfile).save(
    manager.getRepository(StaffProfile).create({
      tenant,
      user: clinicAdmin,
      title: 'Clinic Admin',
      is_available_for_booking: true,
    }),
  );
  logger.success('created clinic admin, receptionist, and staff profile');

  // ~12 customers — Arabic names, +966 phones, Latin emails. Exceeds a
  // typical 10-row page size so pagination-direction assertions have real
  // rows to click through (data-model.md § 6).
  const customerRepo = manager.getRepository(Customer);
  const customers = await customerRepo.save(
    ARABIC_CUSTOMER_NAMES.map((name, i) =>
      customerRepo.create({
        tenant,
        full_name: name,
        phone: phoneFor(i),
        email: emailFor(i),
        is_active: true,
      }),
    ),
  );
  logger.success(`created ${customers.length} customers`);

  // ~15 appointments cycling through every status, one per day starting
  // 2026-01-01 so dates are stable across runs.
  const appointmentStatuses = Object.values(AppointmentStatus);
  const appointmentRepo = manager.getRepository(Appointment);
  const appointments = await appointmentRepo.save(
    Array.from({ length: 15 }, (_, i) => {
      const start = new Date(Date.UTC(2026, 0, 1, 9, 0, 0));
      start.setUTCDate(start.getUTCDate() + i);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      return appointmentRepo.create({
        tenant,
        branch,
        customer: customers[i % customers.length],
        staff: staffProfile,
        start_at: start,
        end_at: end,
        status: appointmentStatuses[i % appointmentStatuses.length],
        payment_status: AppointmentPaymentStatus.UNPAID,
        source: AppointmentSource.MANUAL,
        total_amount: 150 + i * 10,
      });
    }),
  );
  logger.success(`created ${appointments.length} appointments`);

  // ~12 SAR invoices + matching payments — currency isolation and numeric
  // column alignment need real amounts to assert against.
  const invoiceStatuses = Object.values(InvoiceStatus);
  const invoiceRepo = manager.getRepository(Invoice);
  const invoices = await invoiceRepo.save(
    Array.from({ length: 12 }, (_, i) =>
      invoiceRepo.create({
        tenant,
        customer: customers[i % customers.length],
        invoice_number: `RTL-INV-${String(i + 1).padStart(4, '0')}`,
        total_amount: 200 + i * 15,
        status: invoiceStatuses[i % invoiceStatuses.length],
        issued_at: new Date(Date.UTC(2026, 0, 1 + i)),
      }),
    ),
  );

  const paymentStatuses = Object.values(PaymentStatus);
  const paymentRepo = manager.getRepository(Payment);
  await paymentRepo.save(
    invoices.map((invoice, i) =>
      paymentRepo.create({
        tenant,
        branch,
        customer: invoice.customer,
        amount: invoice.total_amount,
        currency: 'SAR',
        status: paymentStatuses[i % paymentStatuses.length],
        settlement_status: SettlementStatus.UNSETTLED,
      }),
    ),
  );
  logger.success(`created ${invoices.length} invoices and payments`);

  // ~8 campaigns cycling through every type and lifecycle.
  const campaignTypes = Object.values(CampaignType);
  const campaignLifecycles = Object.values(CampaignLifecycle);
  const campaignRepo = manager.getRepository(Campaign);
  const campaigns = await campaignRepo.save(
    Array.from({ length: 8 }, (_, i) =>
      campaignRepo.create({
        tenant,
        type: campaignTypes[i % campaignTypes.length],
        name: `RTL Fixture Campaign ${i + 1}`,
        lifecycle: campaignLifecycles[i % campaignLifecycles.length],
        created_by: clinicAdmin,
      }),
    ),
  );
  logger.success(`created ${campaigns.length} campaigns`);

  logger.step('RTL fixture seed completed');
}

/** Entry point for `npm run seed:rtl` — mirrors `seed.ts`'s own bootstrap. */
async function main(): Promise<void> {
  const startedAt = Date.now();

  logger.step('Connecting to database');
  await SeedDataSource.initialize();
  logger.success(`connected to "${SeedDataSource.options.database}"`);

  try {
    await SeedDataSource.transaction((manager) => seedRtlFixture(manager));
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    logger.step(`RTL fixture seed completed in ${seconds}s ✅`);
  } finally {
    await SeedDataSource.destroy();
  }
}

// Only auto-run when executed directly (`npm run seed:rtl`) — importable
// elsewhere (e.g. a future Playwright global-setup hook) without side effects.
if (require.main === module) {
  main().catch((err) => {
    logger.error('RTL fixture seed failed — database left unchanged', err);
    if (SeedDataSource.isInitialized) {
      void SeedDataSource.destroy();
    }
    process.exit(1);
  });
}
