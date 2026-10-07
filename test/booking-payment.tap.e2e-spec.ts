/**
 * Tap migration, Phase 4 gate — patient booking payments over Tap Platform,
 * against real Postgres (migrations-built `ziyarati_e2e`) and real Redis. Only
 * Tap's network is stubbed (`TapSandbox` at the `TapApiClient` boundary).
 *
 *  A. clinic onboarding: Lead → Connect, the callback as an UNTRUSTED hint (it
 *     records a claim, never approves, never sets where money goes), the platform
 *     admin's review as the only way to become chargeable, RBAC, concurrency;
 *  B. booking time: a clinic that wants online payment but cannot take one gets a
 *     CONFIRMED (pay-at-clinic) booking and no link — never an unpayable
 *     PENDING_PAYMENT; a chargeable clinic gets PENDING_PAYMENT + a `/pay/{token}` URL;
 *  C. the public pay page API (test 5): resolve → checkout → signed webhook → the
 *     booking is PAID and CONFIRMED and the link is spent; resuming, replacing a
 *     failed / abandoned / never-created attempt (test 6); the return page when the
 *     webhook never arrives; Tap outages;
 *  D. money safety: nothing the client sends decides money (test 16), the charge
 *     is routed to the CLINIC's merchant with our platform id, a captured amount
 *     that differs is never booked PAID, and tenant isolation (test 15).
 */
import './utils/tap-e2e-env.setup';
import './utils/tap-e2e-booking.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import { createLimitedActor } from './utils/limited-actor';
import { TapSandbox, settle } from './utils/tap-e2e';
import {
  TAP_E2E_APP_URL,
  TAP_E2E_PLATFORM_ID,
} from './utils/tap-e2e-booking.setup';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { PaymentLinkService } from '../src/modules/payments/payment-link.service';
import { AppointmentsService } from '../src/modules/appointment/appointment.service';
import { BillingUpgradeEntitlementListener } from '../src/modules/billing-upgrades/billing-upgrade-entitlement.listener';
import { ResourceEntitlementListener } from '../src/modules/resource-pricing/resource-entitlement.listener';
import { FreeAccessOverrideService } from '../src/modules/subscription-billing/free-access-override.service';
import { PaymentOutcomeService } from '../src/worker/payment-outcome.service';

import { Payment } from '../src/entities/Payments/Payment';
import { MerchantAccount } from '../src/entities/Payments/MerchantAccount';
import { PaymentLink } from '../src/entities/Payments/PaymentLink';
import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { TenantSetting } from '../src/entities/SaaS-Core/TenantSetting';
import { Customer } from '../src/entities/CRM/Customer';
import { Service } from '../src/entities/Services/Service';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { OutboxJob } from '../src/entities/Campaigns/OutboxJob';
import { ROLE } from '../src/rbac/rbac.constants';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  PaymentStatus,
} from '../src/entities/enums';

const API = '/api/v1';
const DAY = 86_400_000;
const SUITE = `bp-${randomUUID().slice(0, 8)}`;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

interface Clinic {
  owner: OwnerFixture;
  tenantId: string;
  branchId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
}

describe('Booking payments over Tap Platform (Phase 4) — real Postgres + Redis', () => {
  let e2e: E2eApp;
  const tap = new TapSandbox();
  let slot = 0;

  const db = () => e2e.dataSource;
  const http = () => request(e2e.app.getHttpServer());
  const links = () => e2e.moduleRef.get(PaymentLinkService, { strict: false });
  const appointments = () =>
    e2e.moduleRef.get(AppointmentsService, { strict: false });

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
  }, 90_000);

  afterAll(async () => {
    await settle();
    await e2e.app.close();
  }, 30_000);

  // ───────────────────────────── fixtures ───────────────────────────── //

  /** A complete, bookable clinic: owner, branch, service (250), doctor with hours, patient. */
  async function makeClinic(label: string): Promise<Clinic> {
    const owner = await createOwnerFixture(e2e, `${label}-${SUITE}`);
    const tenantRef = { id: owner.tenantId } as Tenant;
    const ds = db();

    // Unmetered, so a booking is never blocked by plan quotas in the test.
    await e2e.app.get(FreeAccessOverrideService).grant(owner.tenantId, {
      reason: `e2e ${SUITE}`,
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
        email: `doctor-${label}-${SUITE}@example.test`,
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
        email: `patient-${label}-${SUITE}@example.test`,
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
  async function approveClinic(
    c: Clinic,
    merchantId = `merchant_${randomUUID().slice(0, 10)}`,
  ): Promise<string> {
    const repo = db().getRepository(MerchantAccount);
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
    return merchantId;
  }

  /** A platform admin suspends the clinic's merchant. */
  const suspend = (c: Clinic) =>
    db().query(
      `UPDATE merchant_accounts SET status = 'SUSPENDED' WHERE "tenantId" = $1`,
      [c.tenantId],
    );

  async function book(c: Clinic, over: Record<string, unknown> = {}) {
    const startAt = new Date(
      Date.parse('2027-03-15T12:00:00.000Z') + slot++ * DAY,
    ).toISOString();
    return appointments().create(c.tenantId, c.owner.userId, {
      branchId: c.branchId,
      customerId: c.customerId,
      staffId: c.staffId,
      startAt,
      serviceIds: [c.serviceId],
      ...over,
    } as never);
  }

  /** A booked, link-bearing appointment for a CHARGEABLE clinic. */
  async function bookWithLink(c: Clinic) {
    const appt = await book(c);
    const link = await links().createIfDue(c.tenantId, appt);
    if (!link) throw new Error('expected a pay link');
    return { appt, link, token: link.token };
  }

  const paymentFor = (appointmentId: string) =>
    db()
      .getRepository(Payment)
      .find({
        where: { appointment: { id: appointmentId } },
        order: { created_at: 'ASC' },
      });
  const apptRow = (id: string) =>
    db().getRepository(Appointment).findOneOrFail({ where: { id } });
  const accountRaw = async (tenantId: string) =>
    (
      await db().query(
        `SELECT * FROM merchant_accounts WHERE "tenantId" = $1`,
        [tenantId],
      )
    )[0];

  /** Run the worker's durable consumer the way the real worker would. */
  async function runOutcome(tenantId: string, paymentId: string) {
    const get = <T>(cls: new (...a: never[]) => T) =>
      e2e.moduleRef.get(cls, { strict: false });
    const outcome = new PaymentOutcomeService(
      db(),
      get(AppointmentsService),
      get(BillingUpgradeEntitlementListener),
      get(ResourceEntitlementListener),
      get(PaymentLinkService),
    );
    return outcome.process({ tenantId, paymentId, outcome: 'paid' });
  }

  /** A platform-scope user holding the seeded global super_admin role. */
  async function createSuperAdmin(): Promise<string> {
    const role = await db()
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.SUPER_ADMIN })
      .andWhere('r."tenantId" IS NULL')
      .getOneOrFail();
    const users = db().getRepository(User);
    const user = await users.save(
      users.create({
        tenant: undefined,
        email: `p4-sa-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'E2E Super Admin',
        is_active: true,
      }),
    );
    await db()
      .getRepository(UserRole)
      .save(
        db()
          .getRepository(UserRole)
          .create({
            user: { id: user.id } as User,
            role: { id: role.id } as Role,
          }),
      );
    return e2e.jwt.signAsync(
      { sub: user.id, tenantId: null, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );
  }

  const tokenOf = (connectBody: Record<string, any>): string =>
    String(connectBody.post.url).split('/onboarding/')[1];

  // ═════════════════════════ A. clinic onboarding ═════════════════════════ //

  describe('A. clinic onboarding (Lead → Connect)', () => {
    let clinic: Clinic;
    /** The callback token of THIS clinic's latest Connect session (other clinics connect in between). */
    let clinicToken = '';
    beforeAll(async () => {
      clinic = await makeClinic('onb');
    });

    it('A1. a fresh clinic is NOT_STARTED, can start onboarding, and cannot take online payments yet — and the view never carries the callback token hash', async () => {
      const res = await http()
        .get(`${API}/payments/merchant-account`)
        .set(...authHeader(clinic.owner.token))
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'NOT_STARTED',
        online_payments: {
          provider: 'tap',
          onboarding_available: true,
          payments_available: false,
          reason: 'CLINIC_NOT_ONBOARDED',
        },
      });
      expect(res.body).not.toHaveProperty('provider_callback_token_hash');
    });

    it('A2. "connect" creates ONE lead tied to our platform and returns Tap\'s hosted page; only the token HASH is stored', async () => {
      const leads = tap.leadRequests.length;
      const res = await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(clinic.owner.token))
        .send({ locale: 'ar' })
        .expect(200);

      expect(res.body.connectUrl).toMatch(/^https:\/\/connect\.tap\.test\//);
      expect(res.body.status).toBe('PENDING_DOCUMENTS');
      expect(tap.leadRequests).toHaveLength(leads + 1);

      const lead = tap.leadRequests.at(-1)!;
      expect(lead).toMatchObject({
        country: 'SA',
        merchant: { platforms: [{ id: TAP_E2E_PLATFORM_ID }] },
        wallet: { currency: 'SAR', country: 'SA' },
      });
      expect(lead.brand.name[0].text).toContain('E2E Clinic');
      // KYC / IBAN / national id are Tap's page's business, never ours.
      expect(JSON.stringify(lead)).not.toMatch(
        /identification|national_id|iban|license|documents|birth/,
      );

      const connect = tap.connectRequests.at(-1)!;
      expect(connect).toMatchObject({
        scope: 'merchant',
        redirect: { url: `${TAP_E2E_APP_URL}/app/payments?onboarding=return` },
        board: { editable: true },
        interface: { locale: 'ar', direction: 'rtl' },
      });
      const token = tokenOf(connect);
      clinicToken = token;
      expect(connect.post.url).toBe(
        `https://e2e.example.test/api/v1/payments/webhooks/tap/onboarding/${token}`,
      );

      const row = await accountRaw(clinic.tenantId);
      expect(row).toMatchObject({
        provider: 'tap',
        status: 'PENDING_DOCUMENTS',
        provider_callback_token_hash: sha256(token),
      });
      expect(row.provider_lead_id).toMatch(/^led_/);
      expect(row.provider_onboarding_claimed_at).toBeNull();
      expect(JSON.stringify(row)).not.toContain(token); // the token itself is NOT at rest
      expect(row.provider_recipient_id).toBeNull();
    });

    it('A3. a second "connect" REUSES the lead (no duplicate legal entity), issues a fresh token, and the old token stops working', async () => {
      const leads = tap.leadRequests.length;
      const oldToken = clinicToken;
      await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(clinic.owner.token))
        .send({})
        .expect(200);
      expect(tap.leadRequests).toHaveLength(leads); // no second lead
      const newToken = tokenOf(tap.connectRequests.at(-1)!);
      clinicToken = newToken;
      expect(newToken).not.toBe(oldToken);
      expect(
        (await accountRaw(clinic.tenantId)).provider_callback_token_hash,
      ).toBe(sha256(newToken));

      // the superseded session's callback is quietly ignored
      const before = await accountRaw(clinic.tenantId);
      await http()
        .post(`${API}/payments/webhooks/tap/onboarding/${oldToken}`)
        .send({ object: 'merchant', id: 'merchant_fromOldToken1' })
        .expect(200);
      const after = await accountRaw(clinic.tenantId);
      expect(after.status).toBe(before.status);
      expect(after.provider_capabilities).toBeNull();
    });

    it('A4. two concurrent "connect" clicks create exactly ONE lead', async () => {
      const other = await makeClinic('onb-race');
      const leads = tap.leadRequests.length;
      const [a, b] = await Promise.all(
        [1, 2].map(() =>
          http()
            .post(`${API}/payments/merchant-account/tap/connect`)
            .set(...authHeader(other.owner.token))
            .send({}),
        ),
      );
      const statuses = [a.status, b.status];
      expect(statuses).toContain(200); // one of them won…
      for (const st of statuses) expect([200, 409]).toContain(st); // …the other lost cleanly
      expect(tap.leadRequests).toHaveLength(leads + 1);
    });

    it('A5. the callback is an UNTRUSTED hint: it records an allow-listed claim and moves the clinic to UNDER_REVIEW — it never approves and never sets the merchant id', async () => {
      const token = clinicToken;
      const res = await http()
        .post(`${API}/payments/webhooks/tap/onboarding/${token}`)
        .send({
          object: 'merchant',
          id: 'merchant_claimedByTap1',
          is_acceptance_allowed: true,
          is_payout_allowed: false,
          // a Tap merchant object carries the merchant's API credentials
          operator: {
            api_credentials: {
              live: { secret: 'sk_live_E2eMustNeverBeStored' },
            },
          },
        })
        .expect(200);
      expect(res.body).toEqual({ received: true });

      const row = await accountRaw(clinic.tenantId);
      expect(row.status).toBe('UNDER_REVIEW');
      expect(row.provider_recipient_id).toBeNull(); // routing is NOT decided by the callback
      expect(row.approved_at).toBeNull();
      expect(row.provider_capabilities.claim).toMatchObject({
        merchantId: 'merchant_claimedByTap1',
        isAcceptanceAllowed: true,
        isPayoutAllowed: false,
        recognised: true,
      });
      // credentials that ride along are dropped, not stored — anywhere
      expect(JSON.stringify(row)).not.toContain('sk_live_E2eMustNeverBeStored');
      const logs = await db().query(
        `SELECT 1 FROM webhook_logs WHERE payload::text LIKE '%sk_live_E2eMustNeverBeStored%'`,
      );
      expect(logs).toHaveLength(0);

      // …so the clinic is still NOT chargeable
      const view = await http()
        .get(`${API}/payments/merchant-account`)
        .set(...authHeader(clinic.owner.token))
        .expect(200);
      expect(view.body.online_payments.payments_available).toBe(false);
    });

    it('A6. an unknown or malformed token gets the SAME 200 and changes nothing', async () => {
      for (const t of [
        randomUUID().replace(/-/g, '') + 'x'.repeat(10),
        'short',
        '..%2F..',
      ]) {
        const res = await http()
          .post(`${API}/payments/webhooks/tap/onboarding/${t}`)
          .send({ object: 'merchant', id: 'merchant_nope0001' })
          .expect(200);
        expect(res.body).toEqual({ received: true });
      }
      expect(
        (await accountRaw(clinic.tenantId)).provider_recipient_id,
      ).toBeNull();
    });

    it('A7. a callback on an ALREADY-APPROVED clinic cannot change its routing', async () => {
      const c = await makeClinic('onb-late');
      await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(c.owner.token))
        .send({})
        .expect(200);
      const token = tokenOf(tap.connectRequests.at(-1)!);
      await approveClinic(c, 'merchant_realOne001');
      await http()
        .post(`${API}/payments/webhooks/tap/onboarding/${token}`)
        .send({
          object: 'merchant',
          id: 'merchant_attacker01',
          is_acceptance_allowed: true,
        })
        .expect(200);
      const row = await accountRaw(c.tenantId);
      expect(row.status).toBe('APPROVED');
      expect(row.provider_recipient_id).toBe('merchant_realOne001');
    });

    it('A8. Tap rejecting the lead is a clean 422 in OUR words; nothing is persisted and the clinic can simply retry', async () => {
      const c = await makeClinic('onb-reject');
      tap.leadResult = 'rejected';
      const bad = await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(c.owner.token))
        .send({});
      tap.leadResult = 'ok';
      expect(bad.status).toBe(422);
      expect(JSON.stringify(bad.body)).not.toMatch(/tap\.company|led_|1117/);
      const row = await accountRaw(c.tenantId);
      expect(row.provider_lead_id ?? null).toBeNull();
      expect(row.provider_onboarding_claimed_at ?? null).toBeNull(); // claim released

      await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(c.owner.token))
        .send({})
        .expect(200);
    });

    it('A9. a Tap outage on Connect is a retryable 503; the lead already created is KEPT and reused', async () => {
      const c = await makeClinic('onb-outage');
      tap.connectResult = 'outage';
      const bad = await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(c.owner.token))
        .send({});
      tap.connectResult = 'ok';
      expect(bad.status).toBe(503);
      const kept = (await accountRaw(c.tenantId)).provider_lead_id;
      expect(kept).toMatch(/^led_/);

      const leads = tap.leadRequests.length;
      await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(c.owner.token))
        .send({})
        .expect(200);
      expect(tap.leadRequests).toHaveLength(leads); // reused, not recreated
      expect((await accountRaw(c.tenantId)).provider_lead_id).toBe(kept);
    });

    it('A10. a Connect URL that is not https is refused, never handed to the clinic', async () => {
      const c = await makeClinic('onb-http');
      tap.connectResult = 'http';
      const bad = await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(c.owner.token))
        .send({});
      tap.connectResult = 'ok';
      expect(bad.status).toBe(422);
      expect(JSON.stringify(bad.body)).not.toContain('http://connect.tap.test');
    });

    it('A11. RBAC: a user without payments.manage cannot start onboarding (the backend enforces it, not the UI) — but may read the status', async () => {
      const reader = await createLimitedActor(
        e2e,
        clinic.tenantId,
        ['payments.read'],
        'onb-reader',
      );
      await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(reader.token))
        .send({})
        .expect(403);
      await http()
        .get(`${API}/payments/merchant-account`)
        .set(...authHeader(reader.token))
        .expect(200);
      await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .send({})
        .expect(401);
    });

    it('A12. only a platform admin can approve — a clinic owner cannot approve itself, and "approved" requires a merchant id', async () => {
      const admin = await createSuperAdmin();
      const review = (token: string, body: object) =>
        http()
          .patch(`${API}/payment-merchants/${clinic.tenantId}/review`)
          .set(...authHeader(token))
          .send(body);

      // the clinic itself: refused
      await review(clinic.owner.token, { status: 'APPROVED' }).expect(403);
      // no merchant id yet → refused even for the admin
      await review(admin, { status: 'APPROVED' }).expect(422);
      // a malformed id → refused
      await review(admin, { providerRecipientId: 'bad id; DROP TABLE' }).expect(
        422,
      );
      expect((await accountRaw(clinic.tenantId)).status).toBe('UNDER_REVIEW');

      // the admin, with the claim in front of them, approves with an id
      const ok = await review(admin, {
        status: 'APPROVED',
        providerRecipientId: 'merchant_claimedByTap1',
        note: 'verified in the Tap dashboard',
      }).expect(200);
      expect(ok.body).toMatchObject({
        status: 'APPROVED',
        provider_recipient_id: 'merchant_claimedByTap1',
      });
      expect(
        ok.body.status_history.some((h: any) =>
          String(h.note ?? '').includes('Merchant id changed'),
        ),
      ).toBe(true);

      const view = await http()
        .get(`${API}/payments/merchant-account`)
        .set(...authHeader(clinic.owner.token))
        .expect(200);
      expect(view.body.online_payments).toMatchObject({
        payments_available: true,
      });
      expect(view.body.online_payments).not.toHaveProperty('reason');
    });

    it('A13. a clinic that was APPROVED under another provider must onboard to Tap afresh — its old approval is retired, not carried over', async () => {
      const c = await makeClinic('onb-legacy');
      await db()
        .getRepository(MerchantAccount)
        .save(
          db()
            .getRepository(MerchantAccount)
            .create({
              tenant: { id: c.tenantId } as Tenant,
              provider: 'legacy-provider',
              status: 'APPROVED',
              provider_recipient_id: 'rcp_legacy',
            }),
        );
      // approved + a recipient id, yet NOT chargeable on Tap
      const before = await http()
        .get(`${API}/payments/merchant-account`)
        .set(...authHeader(c.owner.token))
        .expect(200);
      expect(before.body.online_payments.payments_available).toBe(false);

      await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(c.owner.token))
        .send({})
        .expect(200);
      const row = await accountRaw(c.tenantId);
      expect(row).toMatchObject({
        provider: 'tap',
        status: 'PENDING_DOCUMENTS',
      });
      expect(row.provider_recipient_id).toBeNull();
      expect(JSON.stringify(row.status_history)).toContain('rcp_legacy'); // kept in the trail
    });
  });

  // ═══════════════════════ B. booking-time gate ═══════════════════════ //

  describe('B. booking time — never an unpayable PENDING_PAYMENT', () => {
    it('B1. a clinic that wants online payment but is NOT onboarded gets a CONFIRMED booking (pay at the clinic) and NO link', async () => {
      const c = await makeClinic('gate-off');
      const appt = await book(c);
      expect(appt.status).toBe(AppointmentStatus.CONFIRMED);
      expect(appt.payment_status).toBe(AppointmentPaymentStatus.UNPAID);
      expect(await links().createIfDue(c.tenantId, appt)).toBeUndefined();
      expect(
        await db()
          .getRepository(PaymentLink)
          .count({
            where: { tenant: { id: c.tenantId } },
          }),
      ).toBe(0);
    });

    it('B2. an APPROVED Tap clinic gets PENDING_PAYMENT and a durable /pay/{token} URL built by the server', async () => {
      const c = await makeClinic('gate-on');
      await approveClinic(c);
      const appt = await book(c);
      expect(appt.status).toBe(AppointmentStatus.PENDING_PAYMENT);

      const link = await links().createIfDue(c.tenantId, appt);
      expect(link).toMatchObject({ amount: 250, currency: 'SAR' });
      expect(link!.payUrl).toBe(`${TAP_E2E_APP_URL}/pay/${link!.token}`);
      expect(link!.token).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 random bytes, base64url
    });

    it('B3. an insured booking is never charged online: CONFIRMED, no link — even for a chargeable clinic', async () => {
      const c = await makeClinic('gate-ins');
      await approveClinic(c);
      const appt = await book(c, { hasInsurance: true });
      expect(appt.status).toBe(AppointmentStatus.CONFIRMED);
      expect(appt.payment_status).toBe(AppointmentPaymentStatus.INSURANCE);
    });

    it('B4. suspending the merchant flips the very next booking back to pay-at-the-clinic', async () => {
      const c = await makeClinic('gate-susp');
      await approveClinic(c);
      expect((await book(c)).status).toBe(AppointmentStatus.PENDING_PAYMENT);
      await suspend(c);
      expect((await book(c)).status).toBe(AppointmentStatus.CONFIRMED);
    });

    it('B5. the staff API shows pay_url only for a link tied to a booking — an amount-only link has none', async () => {
      const c = await makeClinic('gate-staff');
      await approveClinic(c);
      const { link } = await bookWithLink(c);
      const amountOnly = await http()
        .post(`${API}/payment-links`)
        .set(...authHeader(c.owner.token))
        .send({ amount: 90 })
        .expect(201);
      expect(amountOnly.body).not.toHaveProperty('pay_url');

      const list = await http()
        .get(`${API}/payment-links`)
        .set(...authHeader(c.owner.token))
        .expect(200);
      const bookingLink = list.body.data.find(
        (l: any) => l.link_token === link.token,
      );
      expect(bookingLink.pay_url).toBe(link.payUrl);
      const other = list.body.data.find(
        (l: any) => l.link_token === amountOnly.body.link_token,
      );
      expect(other).not.toHaveProperty('pay_url');

      const one = await http()
        .get(`${API}/payment-links/token/${link.token}`)
        .set(...authHeader(c.owner.token))
        .expect(200);
      expect(one.body.pay_url).toBe(link.payUrl);
    });
  });

  // ═════════════════ C. the patient pay flow (tests 5, 6) ═════════════════ //

  describe('C. patient pay flow — public, token-authorised, server-priced', () => {
    let clinic: Clinic;
    let merchantId: string;
    beforeAll(async () => {
      clinic = await makeClinic('pay');
      merchantId = await approveClinic(clinic);
    });

    const resolve = (token: string) =>
      http().get(`${API}/public/payments/links/${token}`);
    const checkout = (token: string) =>
      http().post(`${API}/public/payments/links/${token}/checkout`).send({});
    const ret = (chargeId: unknown) =>
      http().post(`${API}/public/payments/return`).send({ chargeId });

    it('C1. resolve shows the booking to the payer — no login, no patient identity', async () => {
      const { appt, token } = await bookWithLink(clinic);
      const res = await resolve(token).expect(200);
      expect(res.body).toMatchObject({
        state: 'payable',
        clinicName: expect.stringContaining('E2E Clinic'),
        serviceNames: [`pay Consultation`],
        amount: 250,
        currency: 'SAR',
        timezone: 'Asia/Riyadh',
      });
      expect(new Date(res.body.startAt).toISOString()).toBe(
        (await apptRow(appt.id)).start_at.toISOString(),
      );
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/Patient pay|patient-pay|\+966|@example\.test/i);
      expect(text).not.toContain(clinic.tenantId);
      expect(text).not.toContain(appt.id);
    });

    it("C2. TEST 5 — checkout charges the CLINIC's merchant through our platform; the signed webhook PAYS and CONFIRMS the booking and spends the link", async () => {
      const { appt, link, token } = await bookWithLink(clinic);

      const co = await checkout(token).expect(200);
      expect(co.body).toMatchObject({ state: 'redirect' });
      expect(co.body.redirectUrl).toMatch(
        /^https:\/\/checkout\.tap\.test\/chg_/,
      );

      // what we SENT to Tap
      const charge = tap.lastCharge();
      const sent = tap.chargeRequests.at(-1)!;
      expect(sent).toMatchObject({
        amount: 250,
        currency: 'SAR',
        customer_initiated: true,
        merchant: { id: merchantId }, // the CLINIC is the merchant of record…
        platform: { id: TAP_E2E_PLATFORM_ID }, // …charged on its behalf by us
        reference: { order: appt.id },
        redirect: { url: `${TAP_E2E_APP_URL}/pay/return` },
        post: { url: 'https://e2e.example.test/api/v1/payments/webhooks/tap' },
        source: { id: 'src_all' },
      });
      expect(sent.customer).toMatchObject({
        first_name: 'Patient',
        email: expect.stringContaining('patient-pay-'),
      });
      expect(sent.merchant.id).not.toBe('e2e-merchant'); // never the platform's own account

      const [payment] = await paymentFor(appt.id);
      expect(payment).toMatchObject({
        gateway: 'tap',
        status: PaymentStatus.PENDING,
        purpose: 'BOOKING',
        settlement_mode: 'PROVIDER', // Tap settles to the clinic; ZiyaraTech batches nothing
        gateway_payment_id: charge.id,
      });
      expect(sent.reference.transaction).toBe(payment.id);
      expect(sent.reference.idempotent).toBe(`pay:${payment.id}`);

      // Tap captures and posts the signed webhook
      tap.capture(charge.id);
      const hook = await tap.deliver(e2e.app, charge).expect(200);
      expect(hook.body).toMatchObject({ accepted: true, matched: true });
      await settle();

      const paid = (await paymentFor(appt.id))[0];
      expect(paid.status).toBe(PaymentStatus.PAID);
      const confirmed = await apptRow(appt.id);
      expect(confirmed.payment_status).toBe(AppointmentPaymentStatus.PAID);
      expect(confirmed.status).toBe(AppointmentStatus.CONFIRMED);

      // durable intent was written in the same commit as PAID…
      const outcomeRows = await db()
        .getRepository(OutboxJob)
        .find({
          where: { dedupe_key: `payment-outcome-paid-${paid.id}` },
        });
      expect(outcomeRows).toHaveLength(1);
      // …and the worker's consumer spends the pay link (idempotently)
      const res = await runOutcome(clinic.tenantId, paid.id);
      expect(res).toMatchObject({
        applied: true,
        consumers: ['appointment', 'payment-link'],
      });
      const spent = await db()
        .getRepository(PaymentLink)
        .findOneOrFail({ where: { link_token: link.token } });
      expect(spent.status).toBe('USED');
      await runOutcome(clinic.tenantId, paid.id); // redelivery is harmless
      expect(
        (
          await db()
            .getRepository(PaymentLink)
            .findOneOrFail({ where: { link_token: link.token } })
        ).status,
      ).toBe('USED');

      // re-opening the link now says "paid" and never offers a second charge
      const charges = tap.chargeRequests.length;
      expect((await resolve(token).expect(200)).body.state).toBe('paid');
      expect((await checkout(token).expect(200)).body).toEqual({
        state: 'paid',
      });
      expect(tap.chargeRequests).toHaveLength(charges);

      // the return page reports the same
      const r = await ret(charge.id).expect(200);
      expect(r.body).toMatchObject({
        state: 'paid',
        amount: 250,
        currency: 'SAR',
        clinicName: expect.stringContaining('E2E Clinic'),
      });
    });

    it('C3. opening the link twice resumes the SAME live attempt — one charge at Tap, one payment row', async () => {
      const { appt, token } = await bookWithLink(clinic);
      const charges = tap.chargeRequests.length;
      const a = await checkout(token).expect(200);
      const b = await checkout(token).expect(200);
      expect(b.body.redirectUrl).toBe(a.body.redirectUrl);
      expect(tap.chargeRequests).toHaveLength(charges + 1);
      expect(await paymentFor(appt.id)).toHaveLength(1);
    });

    it('C4. concurrent opens create ONE charge (the one-PENDING-per-booking guard) and every caller gets a sane answer', async () => {
      const { appt, token } = await bookWithLink(clinic);
      const charges = tap.chargeRequests.length;
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => checkout(token)),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(['redirect', 'processing']).toContain(r.body.state);
      }
      expect(tap.chargeRequests.length - charges).toBe(1);
      expect(await paymentFor(appt.id)).toHaveLength(1);
    });

    it('C5. TEST 6 — a DECLINED payment leaves the booking unpaid and the link usable; opening it again creates a NEW charge', async () => {
      const { appt, token } = await bookWithLink(clinic);
      await checkout(token).expect(200);
      const first = tap.lastCharge();
      tap.decline(first.id, 'DECLINED');
      await tap.deliver(e2e.app, first).expect(200);
      await settle();

      let rows = await paymentFor(appt.id);
      expect(rows[0].status).toBe(PaymentStatus.FAILED);
      const stillOpen = await apptRow(appt.id);
      expect(stillOpen.payment_status).toBe(AppointmentPaymentStatus.UNPAID);
      expect(stillOpen.status).toBe(AppointmentStatus.PENDING_PAYMENT);
      expect((await resolve(token).expect(200)).body.state).toBe('payable');

      const charges = tap.chargeRequests.length;
      const again = await checkout(token).expect(200);
      expect(again.body.state).toBe('redirect');
      expect(tap.chargeRequests).toHaveLength(charges + 1);
      const second = tap.lastCharge();
      expect(second.id).not.toBe(first.id);

      rows = await paymentFor(appt.id);
      expect(rows.map((r) => r.status)).toEqual([
        PaymentStatus.FAILED,
        PaymentStatus.PENDING,
      ]);

      tap.capture(second.id);
      await tap.deliver(e2e.app, second).expect(200);
      await settle();
      expect((await paymentFor(appt.id))[1].status).toBe(PaymentStatus.PAID);
      expect((await apptRow(appt.id)).status).toBe(AppointmentStatus.CONFIRMED);
    });

    it('C6. an ABANDONED hosted page (Tap posts nothing for it) is detected on the next open and replaced', async () => {
      const { appt, token } = await bookWithLink(clinic);
      await checkout(token).expect(200);
      const first = tap.lastCharge();
      tap.decline(first.id, 'ABANDONED'); // no webhook is sent for an abandoned charge

      const charges = tap.chargeRequests.length;
      const again = await checkout(token).expect(200);
      expect(again.body.state).toBe('redirect');
      expect(tap.chargeRequests).toHaveLength(charges + 1);
      const rows = await paymentFor(appt.id);
      expect(rows.map((r) => r.status)).toEqual([
        PaymentStatus.FAILED,
        PaymentStatus.PENDING,
      ]);
    });

    it('C7. a payer who PAID but whose webhook has not arrived is recognised on re-open — no second charge', async () => {
      const { appt, token } = await bookWithLink(clinic);
      await checkout(token).expect(200);
      const charge = tap.lastCharge();
      tap.capture(charge.id); // captured at Tap; the webhook is lost / late

      const charges = tap.chargeRequests.length;
      expect((await checkout(token).expect(200)).body).toEqual({
        state: 'paid',
      });
      expect(tap.chargeRequests).toHaveLength(charges);
      expect((await paymentFor(appt.id))[0].status).toBe(PaymentStatus.PAID);
      await settle();
      expect((await apptRow(appt.id)).status).toBe(AppointmentStatus.CONFIRMED);
    });

    it('C8. the return page settles a captured payment when the webhook never arrives — through the same verified path', async () => {
      const { appt, token } = await bookWithLink(clinic);
      await checkout(token).expect(200);
      const charge = tap.lastCharge();

      // not captured yet → "pending", nothing changes
      expect((await ret(charge.id).expect(200)).body).toMatchObject({
        state: 'pending',
        amount: 250,
      });
      expect((await paymentFor(appt.id))[0].status).toBe(PaymentStatus.PENDING);

      tap.capture(charge.id);
      const r = await ret(charge.id).expect(200);
      expect(r.body).toMatchObject({
        state: 'paid',
        amount: 250,
        currency: 'SAR',
      });
      await settle();
      expect((await paymentFor(appt.id))[0].status).toBe(PaymentStatus.PAID);
      expect((await apptRow(appt.id)).status).toBe(AppointmentStatus.CONFIRMED);
    });

    it('C9. the return page for a declined charge says "failed" and reveals nothing about the booking', async () => {
      const { token } = await bookWithLink(clinic);
      await checkout(token).expect(200);
      const charge = tap.lastCharge();
      tap.decline(charge.id);
      const r = await ret(charge.id).expect(200);
      expect(r.body).toEqual({ state: 'failed', amount: 250, currency: 'SAR' });
    });

    it('C10. an attempt that never reached Tap (create outage) is "processing", then REPLACED on the next open — nobody could have paid it', async () => {
      const { appt, token } = await bookWithLink(clinic);
      tap.failNextCreateWith = { status: 503 };
      const first = await checkout(token).expect(200);
      expect(first.body).toEqual({ state: 'processing' });
      let rows = await paymentFor(appt.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: PaymentStatus.PENDING,
        gateway_payment_id: null,
      });

      const second = await checkout(token).expect(200);
      expect(second.body.state).toBe('redirect');
      rows = await paymentFor(appt.id);
      expect(rows.map((r) => r.status)).toEqual([
        PaymentStatus.FAILED,
        PaymentStatus.PENDING,
      ]);
      expect(rows[0].failure_reason).toBe(
        'Superseded by a new payment attempt',
      );
    });

    it('C11. Tap unreachable while RESUMING keeps the live attempt open — the payer is re-offered the same page, never double-charged', async () => {
      const { appt, token } = await bookWithLink(clinic);
      const a = await checkout(token).expect(200);
      const charges = tap.chargeRequests.length;
      const original = tap.getCharge.getMockImplementation()!;
      tap.getCharge.mockImplementationOnce(async () => ({
        ok: false,
        status: 503,
        json: {},
        transient: true,
      }));
      const b = await checkout(token).expect(200);
      tap.getCharge.mockImplementation(original);
      expect(b.body).toEqual(a.body);
      expect(tap.chargeRequests).toHaveLength(charges);
      expect((await paymentFor(appt.id))[0].status).toBe(PaymentStatus.PENDING);
    });

    it('C12. a clinic that stops being chargeable makes its links "unavailable" — no charge is attempted', async () => {
      const c = await makeClinic('pay-susp');
      await approveClinic(c);
      const { token } = await bookWithLink(c);
      await suspend(c);
      const charges = tap.chargeRequests.length;
      expect((await resolve(token).expect(200)).body.state).toBe('unavailable');
      expect((await checkout(token).expect(200)).body).toEqual({
        state: 'unavailable',
      });
      expect(tap.chargeRequests).toHaveLength(charges);
    });

    it('C13. a cancelled booking, a disabled link and an expired link are all "expired" — no charge is attempted', async () => {
      const charges = tap.chargeRequests.length;

      const a = await bookWithLink(clinic);
      await db()
        .getRepository(Appointment)
        .update({ id: a.appt.id }, { status: AppointmentStatus.CANCELLED });
      expect((await resolve(a.token).expect(200)).body.state).toBe('expired');
      expect((await checkout(a.token).expect(200)).body).toEqual({
        state: 'expired',
      });

      const b = await bookWithLink(clinic);
      const bRow = await db()
        .getRepository(PaymentLink)
        .findOneOrFail({ where: { link_token: b.token } });
      await http()
        .post(`${API}/payment-links/${bRow.id}/disable`)
        .set(...authHeader(clinic.owner.token))
        .expect(200);
      expect((await checkout(b.token).expect(200)).body).toEqual({
        state: 'expired',
      });

      const c = await bookWithLink(clinic);
      await db()
        .getRepository(PaymentLink)
        .update(
          { link_token: c.token },
          { expires_at: new Date(Date.now() - 1000) },
        );
      expect((await resolve(c.token).expect(200)).body.state).toBe('expired');
      expect(
        (
          await db()
            .getRepository(PaymentLink)
            .findOneOrFail({ where: { link_token: c.token } })
        ).status,
      ).toBe('EXPIRED'); // lazily flipped

      expect(tap.chargeRequests).toHaveLength(charges);
    });

    it('C14. an unknown or malformed token — and an unknown charge id — is the SAME uniform 404 (no oracle on what exists)', async () => {
      const refusals: string[] = [];
      for (const t of ['F'.repeat(32), 'short', 'x'.repeat(100)]) {
        const r = await resolve(t).expect(404);
        const c = await checkout(t).expect(404);
        refusals.push(r.body.message, c.body.message);
      }
      refusals.push(
        (await ret('chg_unknownunknown1').expect(404)).body.message,
      );
      expect(new Set(refusals)).toEqual(new Set(['Not found'])); // one wording for every refusal
      // a malformed charge id is rejected by validation before any lookup happens
      for (const id of ['nope', 'chg_', '../etc/passwd', 'chg_a b', '']) {
        await ret(id).expect(400);
      }
      await http().post(`${API}/public/payments/return`).send({}).expect(400);
      await http()
        .post(`${API}/public/payments/return`)
        .send({ chargeId: 'chg_abcdef1', amount: 1 }) // no extra field is accepted
        .expect(400);
    });

    it('C15. the return page only knows BOOKING payments — a charge that is not one is a 404', async () => {
      // a clinic's add-on payment to the platform (ADDON) has a Tap charge id too
      const c = await makeClinic('pay-addon');
      // payments are append-only (never torn down), so the charge id must be unique per run
      const addonCharge = `chg_addon${randomUUID().replace(/-/g, '')}`;
      await db()
        .getRepository(Payment)
        .save(
          db()
            .getRepository(Payment)
            .create({
              tenant: { id: c.tenantId } as Tenant,
              amount: 50,
              currency: 'SAR',
              status: PaymentStatus.PENDING,
              gateway: 'tap',
              gateway_payment_id: addonCharge,
              purpose: 'ADDON',
              settlement_mode: 'NONE',
            }),
        );
      await ret(addonCharge).expect(404);
    });

    it('C16. the pay endpoints work WITHOUT any credential, and the staff token route does not', async () => {
      const { token } = await bookWithLink(clinic);
      await resolve(token).expect(200); // no Authorization header
      await http().get(`${API}/payment-links/token/${token}`).expect(401);
    });
  });

  // ═══════════════════════ D. money safety (tests 15, 16) ═══════════════════════ //

  describe('D. money safety', () => {
    let a: Clinic;
    let b: Clinic;
    beforeAll(async () => {
      a = await makeClinic('sec-a');
      b = await makeClinic('sec-b');
      await approveClinic(a, 'merchant_clinicAAAA01');
      await approveClinic(b, 'merchant_clinicBBBB01');
    });

    it('D1. TEST 16 — nothing the client sends decides money: a body on checkout is ignored, the charge is always the booking price', async () => {
      const { token } = await bookWithLink(a);
      const charges = tap.chargeRequests.length;
      await http()
        .post(`${API}/public/payments/links/${token}/checkout`)
        .send({
          amount: 1,
          currency: 'USD',
          tenantId: b.tenantId,
          merchantId: 'merchant_evil',
          gateway: 'legacy-provider',
        })
        .expect(200);
      expect(tap.chargeRequests).toHaveLength(charges + 1);
      const sent = tap.chargeRequests.at(-1)!;
      expect(sent.amount).toBe(250);
      expect(sent.currency).toBe('SAR');
      expect(sent.merchant.id).toBe('merchant_clinicAAAA01');
    });

    it('D2. TEST 16 — staff cannot under-charge a booking either: a differing amount or currency is a 422 and nothing reaches Tap', async () => {
      const appt = await book(a);
      const charges = tap.chargeRequests.length;
      await http()
        .post(`${API}/payments`)
        .set(...authHeader(a.owner.token))
        .send({ appointmentId: appt.id, amount: 1 })
        .expect(422);
      await http()
        .post(`${API}/payments`)
        .set(...authHeader(a.owner.token))
        .send({ appointmentId: appt.id, currency: 'USD' })
        .expect(422);
      expect(tap.chargeRequests).toHaveLength(charges);
    });

    it('D3. TEST 16 — a captured amount that is NOT the booking price is never booked PAID (webhook AND return page)', async () => {
      const { appt, token } = await bookWithLink(a);
      await http()
        .post(`${API}/public/payments/links/${token}/checkout`)
        .send({})
        .expect(200);
      const charge = tap.lastCharge();
      tap.capture(charge.id, { amount: 1 }); // Tap says the payer paid 1 SAR, not 250

      await tap.deliver(e2e.app, charge).expect(200);
      await settle();
      const ret = await http()
        .post(`${API}/public/payments/return`)
        .send({ chargeId: charge.id })
        .expect(200);

      expect(ret.body.state).toBe('pending'); // under review, never "paid"
      expect((await paymentFor(appt.id))[0].status).toBe(PaymentStatus.PENDING);
      const stuck = await apptRow(appt.id);
      expect(stuck.payment_status).toBe(AppointmentPaymentStatus.UNPAID);
      expect(stuck.status).toBe(AppointmentStatus.PENDING_PAYMENT);
    });

    it("D4. a clinic's booking is charged on ITS merchant only — two clinics never share one", async () => {
      const x = await bookWithLink(a);
      const y = await bookWithLink(b);
      await http()
        .post(`${API}/public/payments/links/${x.token}/checkout`)
        .send({})
        .expect(200);
      const forA = tap.chargeRequests.at(-1)!;
      await http()
        .post(`${API}/public/payments/links/${y.token}/checkout`)
        .send({})
        .expect(200);
      const forB = tap.chargeRequests.at(-1)!;
      expect(forA.merchant.id).toBe('merchant_clinicAAAA01');
      expect(forB.merchant.id).toBe('merchant_clinicBBBB01');
      expect(forA.platform.id).toBe(forB.platform.id);
    });

    it("D5. TEST 15 — tenant isolation: clinic A cannot read, confirm, disable, refund or pay-link clinic B's records", async () => {
      const { appt, link, token } = await bookWithLink(b);
      await http()
        .post(`${API}/public/payments/links/${token}/checkout`)
        .send({})
        .expect(200);
      const [payment] = await paymentFor(appt.id);
      const linkRow = await db()
        .getRepository(PaymentLink)
        .findOneOrFail({ where: { link_token: token } });
      const A = authHeader(a.owner.token);

      await http()
        .get(`${API}/payments/${payment.id}`)
        .set(...A)
        .expect(404);
      await http()
        .post(`${API}/payments/${payment.id}/confirm`)
        .set(...A)
        .send({})
        .expect(404);
      await http()
        .get(`${API}/payment-links/token/${link.token}`)
        .set(...A)
        .expect(404);
      await http()
        .get(`${API}/payment-links/${linkRow.id}`)
        .set(...A)
        .expect(404);
      await http()
        .post(`${API}/payment-links/${linkRow.id}/disable`)
        .set(...A)
        .expect(404);
      await http()
        .post(`${API}/refunds`)
        .set(...A)
        .send({ paymentId: payment.id, amount: 10 })
        .expect((r) => expect([404, 422]).toContain(r.status));
      // the cross-tenant attempts changed nothing
      expect((await paymentFor(appt.id))[0].status).toBe(PaymentStatus.PENDING);
      expect(
        (
          await db()
            .getRepository(PaymentLink)
            .findOneOrFail({ where: { id: linkRow.id } })
        ).status,
      ).toBe('ACTIVE');

      // clinic A's own list never shows B's payment
      const list = await http()
        .get(`${API}/payments`)
        .set(...A)
        .expect(200);
      expect(list.body.data.map((p: any) => p.id)).not.toContain(payment.id);
    });

    it('D6. TEST 15 — a clinic cannot start onboarding or approve for ANOTHER clinic (the tenant always comes from the token)', async () => {
      const before = await accountRaw(b.tenantId);
      await http()
        .post(`${API}/payments/merchant-account/tap/connect`)
        .set(...authHeader(a.owner.token))
        .send({ tenantId: b.tenantId }) // a stray field is rejected outright
        .expect(400);
      const after = await accountRaw(b.tenantId);
      expect(after.provider_lead_id).toBe(before.provider_lead_id);
      await http()
        .patch(`${API}/payment-merchants/${b.tenantId}/review`)
        .set(...authHeader(a.owner.token))
        .send({ providerRecipientId: 'merchant_hijack001' })
        .expect(403);
      expect((await accountRaw(b.tenantId)).provider_recipient_id).toBe(
        'merchant_clinicBBBB01',
      );
    });

    it('D7. staff creating a payment for an unapproved clinic is refused with a reason code and reaches nobody', async () => {
      const c = await makeClinic('sec-unapproved');
      const appt = await book(c); // CONFIRMED (pay at the clinic) — but staff still tries a manual charge
      const charges = tap.chargeRequests.length;
      const res = await http()
        .post(`${API}/payments`)
        .set(...authHeader(c.owner.token))
        .send({ appointmentId: appt.id })
        .expect(422);
      expect(res.body.context ?? res.body.publicContext ?? {}).toMatchObject({
        reason: 'CLINIC_NOT_ONBOARDED',
      });
      expect(tap.chargeRequests).toHaveLength(charges);
    });

    it('D8. the staff payment of an APPROVED clinic is routed to that clinic too (one rule for every charge)', async () => {
      const appt = await book(a);
      await http()
        .post(`${API}/payments`)
        .set(...authHeader(a.owner.token))
        .send({ appointmentId: appt.id })
        .expect(201);
      const sent = tap.chargeRequests.at(-1)!;
      expect(sent.merchant.id).toBe('merchant_clinicAAAA01');
      expect(sent.platform.id).toBe(TAP_E2E_PLATFORM_ID);
    });
  });
});
