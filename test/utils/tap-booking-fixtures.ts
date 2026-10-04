/**
 * Shared fixtures for the Tap e2e suites that need a PAID booking payment
 * (Phase 5: refunds, reconciliation). Same shape as the helpers inside
 * `booking-payment.tap.e2e-spec.ts` (Phase 4), kept here so the Phase 5 specs do
 * not each carry a second copy. Import `./tap-e2e-env.setup` and
 * `./tap-e2e-booking.setup` FIRST in the spec — before anything that pulls AppModule.
 */
import { randomUUID } from 'node:crypto';

import {
  createOwnerFixture,
  type E2eApp,
  type OwnerFixture,
} from './whatsapp-e2e-app';
import { TapSandbox, settle } from './tap-e2e';

import { PaymentLinkService } from '../../src/modules/payments/payment-link.service';
import { AppointmentsService } from '../../src/modules/appointment/appointment.service';
import { BillingUpgradeEntitlementListener } from '../../src/modules/billing-upgrades/billing-upgrade-entitlement.listener';
import { ResourceEntitlementListener } from '../../src/modules/resource-pricing/resource-entitlement.listener';
import { FreeAccessOverrideService } from '../../src/modules/subscription-billing/free-access-override.service';
import { PaymentOutcomeService } from '../../src/worker/payment-outcome.service';
import { PaymentOutcomeKind } from '../../src/modules/payments/payment-outcome.outbox';
import { ReconciliationExceptionService } from '../../src/modules/payments/reconciliation/reconciliation-exception.service';

import { Payment } from '../../src/entities/Payments/Payment';
import { MerchantAccount } from '../../src/entities/Payments/MerchantAccount';
import { Branch } from '../../src/entities/SaaS-Core/Branch';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../src/entities/SaaS-Core/TenantSetting';
import { Customer } from '../../src/entities/CRM/Customer';
import { Service } from '../../src/entities/Services/Service';
import { StaffProfile } from '../../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../../src/entities/Staff/StaffSchedule';
import { User } from '../../src/entities/Auth&RBAC/User';
import { Appointment } from '../../src/entities/Calendar&Appointments/Appointment';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { ROLE } from '../../src/rbac/rbac.constants';

const DAY = 86_400_000;

export interface Clinic {
  owner: OwnerFixture;
  tenantId: string;
  branchId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
  /** The Tap merchant id the clinic was approved with (set by `approve`). */
  merchantId?: string;
}

export class TapBookingFixtures {
  private slot = 0;

  constructor(
    private readonly e2e: E2eApp,
    private readonly tap: TapSandbox,
    private readonly suite: string,
  ) {}

  private get db() {
    return this.e2e.dataSource;
  }
  private get<T>(cls: new (...a: never[]) => T): T {
    return this.e2e.moduleRef.get(cls, { strict: false });
  }

  /** A complete, bookable clinic: owner, branch, service (250 SAR), doctor with hours, patient. */
  async makeClinic(label: string): Promise<Clinic> {
    const owner = await createOwnerFixture(this.e2e, `${label}-${this.suite}`);
    const tenantRef = { id: owner.tenantId } as Tenant;
    const ds = this.db;

    // Unmetered, so a booking is never blocked by plan quotas in the test.
    await this.e2e.app.get(FreeAccessOverrideService).grant(owner.tenantId, {
      reason: `e2e ${this.suite}`,
      durationDays: null,
    });
    await ds.getRepository(TenantSetting).save(
      ds.getRepository(TenantSetting).create({
        tenant: tenantRef,
        payment_required: true,
      }),
    );
    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: tenantRef,
        name: `${label} Main`,
        timezone: 'Asia/Riyadh',
        is_active: true,
      }),
    );
    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: tenantRef,
        name: `${label} Consultation`,
        public_slug: `consultation-${randomUUID().slice(0, 8)}`,
        duration_minutes: 30,
        base_price: 250,
        is_active: true,
      }),
    );
    const doctorUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: tenantRef,
        email: `doctor-${label}-${this.suite}@example.test`,
        full_name: `Dr ${label}`,
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: tenantRef,
        user: { id: doctorUser.id } as User,
        public_slug: `dr-${randomUUID().slice(0, 12)}`,
        title: 'Consultant',
        is_available_for_booking: true,
      }),
    );
    for (let day = 0; day < 7; day += 1) {
      await ds.getRepository(StaffSchedule).save(
        ds.getRepository(StaffSchedule).create({
          tenant: tenantRef,
          staff: { id: staff.id } as StaffProfile,
          branch: { id: branch.id } as Branch,
          day_of_week: day,
          start_time: '08:00:00',
          end_time: '20:00:00',
          is_active: true,
        }),
      );
    }
    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: tenantRef,
        full_name: `Patient ${label}`,
        phone: '+966501112233',
        email: `patient-${label}-${this.suite}@example.test`,
      }),
    );
    return {
      owner,
      tenantId: owner.tenantId,
      branchId: branch.id,
      customerId: customer.id,
      staffId: staff.id,
      serviceId: service.id,
    };
  }

  /** Make the clinic chargeable the way production does: an APPROVED Tap merchant with an id. */
  async approve(
    c: Clinic,
    merchantId = `merchant_${randomUUID().slice(0, 10)}`,
  ): Promise<string> {
    const repo = this.db.getRepository(MerchantAccount);
    const existing = await repo.findOne({
      where: { tenant: { id: c.tenantId } },
    });
    const row =
      existing ?? repo.create({ tenant: { id: c.tenantId } as Tenant });
    Object.assign(row, {
      provider: 'tap',
      status: 'APPROVED',
      provider_recipient_id: merchantId,
      approved_at: new Date(),
    });
    await repo.save(row);
    c.merchantId = merchantId;
    return merchantId;
  }

  async book(c: Clinic, over: Record<string, unknown> = {}) {
    const startAt = new Date(
      Date.parse('2027-06-15T12:00:00.000Z') + this.slot++ * DAY,
    ).toISOString();
    return this.get(AppointmentsService).create(c.tenantId, c.owner.userId, {
      branchId: c.branchId,
      customerId: c.customerId,
      staffId: c.staffId,
      startAt,
      serviceIds: [c.serviceId],
      ...over,
    } as never);
  }

  /** A booked, link-bearing appointment for a CHARGEABLE clinic. */
  async bookWithLink(c: Clinic) {
    const appt = await this.book(c);
    const link = await this.get(PaymentLinkService).createIfDue(
      c.tenantId,
      appt,
    );
    if (!link) throw new Error('expected a pay link');
    return { appt, link, token: link.token };
  }

  /**
   * A booking whose payment is CAPTURED at Tap and PAID here: checkout through the
   * public pay API, then Tap's signed webhook. Resolves with the payment row.
   */
  async paidBooking(c: Clinic, request: (path: string) => any) {
    const { appt, token } = await this.bookWithLink(c);
    await request(`/public/payments/links/${token}/checkout`)
      .send({})
      .expect(200);
    const charge = this.tap.lastCharge();
    this.tap.capture(charge.id);
    await this.tap.deliver(this.e2e.app, charge).expect(200);
    await settle();
    const payment = await this.db
      .getRepository(Payment)
      .findOneOrFail({ where: { gateway_payment_id: charge.id } });
    return { appt, payment, charge, token };
  }

  /** A platform-scope user holding the seeded global super_admin role; resolves with an access JWT. */
  async createSuperAdmin(): Promise<string> {
    const role = await this.db
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.SUPER_ADMIN })
      .andWhere('r."tenantId" IS NULL')
      .getOneOrFail();
    const users = this.db.getRepository(User);
    const user = await users.save(
      users.create({
        tenant: undefined,
        email: `p5-sa-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'E2E Super Admin',
        is_active: true,
      }),
    );
    await this.db.getRepository(UserRole).save(
      this.db.getRepository(UserRole).create({
        user: { id: user.id } as User,
        role: { id: role.id } as Role,
      }),
    );
    return this.e2e.jwt.signAsync(
      { sub: user.id, tenantId: null, type: 'access' },
      {
        secret: this.e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );
  }

  paymentRow(id: string) {
    return this.db.getRepository(Payment).findOneOrFail({ where: { id } });
  }
  apptRow(id: string) {
    return this.db.getRepository(Appointment).findOneOrFail({ where: { id } });
  }

  /** Run the worker's durable consumer the way the real worker would. */
  async runOutcome(
    tenantId: string,
    paymentId: string,
    outcome: PaymentOutcomeKind,
    refundId?: string,
  ) {
    const consumer = new PaymentOutcomeService(
      this.db,
      this.get(AppointmentsService),
      this.get(BillingUpgradeEntitlementListener),
      this.get(ResourceEntitlementListener),
      this.get(PaymentLinkService),
      this.get(ReconciliationExceptionService),
    );
    return consumer.process({ tenantId, paymentId, outcome, refundId });
  }
}
