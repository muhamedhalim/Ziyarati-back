/**
 * Tap migration, Phase 6 gate (backend half) — the finance READ APIs the new screens
 * stand on, on real Postgres + Redis (only Tap's network is stubbed). The raw SQL in
 * these services had no test at all before this phase, and mock-based specs have hidden
 * real-Postgres bugs four times in this migration, so this suite is the authority.
 *
 *  A. the platform's marketplace ledger: purpose / settlement mode / fee status /
 *     payout / open-exception fields and filters, the transaction detail, the CSV;
 *  B. the KPIs and drill-downs are about CLINIC money — a clinic's add-on and
 *     billing-upgrade payments to the platform are reported separately, per currency;
 *  C. the subscription-revenue ledger (new): rows, filters, per-currency totals over
 *     the whole filter, refund state, CSV, audit, authorization;
 *  D. the reconciliation queue names the clinic;
 *  E. the clinic's own payments list: fee-status filter and charge-id search, tenant-scoped;
 *  F. the readers that used to call a clinic's platform purchases "revenue"
 *     (clinic analytics, the platform dashboard).
 *
 * The database is shared and payments are never torn down, so every absolute figure is
 * scoped to this suite's own clinics, and every global figure is asserted as a DELTA.
 */
import './utils/tap-e2e-env.setup';
import './utils/tap-e2e-recurring.setup';
import './utils/tap-e2e-booking.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import {
  setPaidMode,
  resetBillingMode,
} from './utils/subscription-e2e-fixtures';
import { TapSandbox, settle } from './utils/tap-e2e';
import { TapBookingFixtures, type Clinic } from './utils/tap-booking-fixtures';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import { ReconciliationExceptionService } from '../src/modules/payments/reconciliation/reconciliation-exception.service';
import { AnalyticsAggregationService } from '../src/modules/analytics/analytics-aggregation.service';
import { PlatformDashboardService } from '../src/modules/platform-dashboard/platform-dashboard.service';
import { Payment } from '../src/entities/Payments/Payment';
import { SubscriptionInvoice } from '../src/entities/SaaS-Core/SubscriptionInvoice';
import { SubscriptionPlan } from '../src/entities/SaaS-Core/SubscriptionPlan';
import {
  BillingCycle,
  InvoiceStatus,
  PaymentStatus,
} from '../src/entities/enums';

const API = '/api/v1';
const SUITE = `pf-${randomUUID().slice(0, 8)}`;

describe('Platform + clinic finance read APIs (Phase 6) — real Postgres + Redis', () => {
  let e2e: E2eApp;
  const tap = new TapSandbox();
  let fx: TapBookingFixtures;
  let admin: string;
  let plan: SubscriptionPlan; // 99.00 / month

  const db = () => e2e.dataSource;
  const http = () => request(e2e.app.getHttpServer());
  const get = (token: string, url: string) =>
    http()
      .get(`${API}${url}`)
      .set(...authHeader(token));
  const post = (token: string, url: string, body: object = {}) =>
    http()
      .post(`${API}${url}`)
      .set(...authHeader(token))
      .send(body);
  const publicPost = (path: string) => http().post(`${API}${path}`);
  const exceptions = () =>
    e2e.moduleRef.get(ReconciliationExceptionService, { strict: false });

  // ── the world this suite builds ──
  let a: Clinic; // booking + platform purchases
  let b: Clinic; // a bystander: isolation
  let bookingPayment: Payment;
  const seeded: Record<string, Payment> = {};
  let kpiBefore: Record<string, any>;

  const seedPayment = (
    c: Clinic,
    over: Record<string, unknown>,
  ): Promise<Payment> =>
    db()
      .getRepository(Payment)
      .save({
        tenant: { id: c.tenantId },
        amount: 100,
        currency: 'SAR',
        status: PaymentStatus.PAID,
        gateway: 'tap',
        gateway_payment_id: `chg_pf${randomUUID().replace(/-/g, '')}`,
        purpose: 'ADDON',
        settlement_mode: 'NONE',
        paid_at: new Date(),
        ...over,
      } as unknown as Payment);

  const rowsOf = async (query: string) => {
    const res = await get(admin, `/platform/finance/transactions?${query}`);
    expect(res.status).toBe(200);
    return res.body as {
      data: Array<Record<string, any>>;
      total: number;
    };
  };

  beforeAll(async () => {
    e2e = await createE2eApp((builder) =>
      builder.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    await setPaidMode(e2e);
    const plans = db().getRepository(SubscriptionPlan);
    plan = await plans.save(
      plans.create({
        name: `PF Basic ${SUITE}`,
        price: '99.00',
        billing_cycle: BillingCycle.MONTHLY,
        is_active: true,
        is_custom: false,
      }),
    );
    fx = new TapBookingFixtures(e2e, tap, SUITE);
    admin = await fx.createSuperAdmin();

    // The "before" of every global figure, taken before this suite writes anything.
    kpiBefore = (await get(admin, '/platform/finance/kpis')).body;

    a = await fx.makeClinic('pf-a');
    await fx.approve(a);
    b = await fx.makeClinic('pf-b');
    await fx.approve(b);
    await db().query(`UPDATE tenants SET name = $2 WHERE id = $1`, [
      a.tenantId,
      `${SUITE} Clinic A`,
    ]);
    await db().query(`UPDATE tenants SET name = $2 WHERE id = $1`, [
      b.tenantId,
      `${SUITE} Clinic B`,
    ]);

    // 1. clinic money: a booking paid through the real public pay flow (250 SAR)
    bookingPayment = (await fx.paidBooking(a, publicPost)).payment;
    // 2-4. what the clinic paid the PLATFORM (never clinic money)
    seeded.addon = await seedPayment(a, {
      amount: 100,
      purpose: 'ADDON',
      fees_reconciled_at: null,
    });
    seeded.upgrade = await seedPayment(a, {
      amount: 40,
      purpose: 'BILLING_UPGRADE',
    });
    seeded.partial = await seedPayment(a, {
      amount: 60,
      purpose: 'ADDON',
      status: PaymentStatus.PARTIALLY_REFUNDED,
      refunded_amount: 20,
    });
    // 5-6. failures on each side
    seeded.failedBooking = await seedPayment(a, {
      amount: 75,
      purpose: 'BOOKING',
      settlement_mode: 'PROVIDER',
      status: PaymentStatus.FAILED,
      paid_at: null,
    });
    seeded.failedAddon = await seedPayment(a, {
      amount: 30,
      purpose: 'ADDON',
      status: PaymentStatus.FAILED,
      paid_at: null,
    });
  }, 180_000);

  afterAll(async () => {
    await db()
      .getRepository(SubscriptionPlan)
      .update({ id: plan.id }, { is_active: false });
    await settle();
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 30_000);

  // ═══════════════════ A. the marketplace ledger ═══════════════════ //

  describe('A. the platform marketplace ledger', () => {
    it('A1. every row says what the money is for, who settles it, and whether its fee is final', async () => {
      const { data, total } = await rowsOf(`tenantId=${a.tenantId}&limit=100`);

      expect(total).toBe(6);
      const byId = new Map(data.map((r) => [r.id, r]));
      expect(byId.get(bookingPayment.id)).toMatchObject({
        purpose: 'BOOKING',
        settlementMode: 'PROVIDER',
        feeStatus: 'PROVISIONAL', // captured; Tap has not reported its fee yet
        providerPayoutId: null,
        openExceptions: 0,
        gateway: 'tap',
        gatewayPaymentId: bookingPayment.gateway_payment_id,
      });
      expect(byId.get(seeded.addon.id)).toMatchObject({
        purpose: 'ADDON',
        settlementMode: 'NONE',
        feeStatus: 'PROVISIONAL',
      });
      // money that never moved has no fee to reconcile
      expect(byId.get(seeded.failedBooking.id)?.feeStatus).toBe(
        'NOT_APPLICABLE',
      );
      expect(byId.get(seeded.failedAddon.id)?.feeStatus).toBe('NOT_APPLICABLE');
    });

    it('A2. the purpose filter takes a purpose or one of the two groups, and refuses anything else', async () => {
      const q = (purpose: string) =>
        rowsOf(`tenantId=${a.tenantId}&limit=100&purpose=${purpose}`);

      expect((await q('CLINIC_MONEY')).total).toBe(2); // the paid + the failed booking
      expect((await q('PLATFORM_REVENUE')).total).toBe(4);
      expect((await q('ADDON')).total).toBe(3);
      expect((await q('BILLING_UPGRADE')).total).toBe(1);
      expect((await q('MANUAL')).total).toBe(0);
      expect(
        (await get(admin, '/platform/finance/transactions?purpose=NOPE'))
          .status,
      ).toBe(400);
    });

    it('A3. fee status separates captured money by whether Tap has reported its fee', async () => {
      const q = (feeStatus: string) =>
        rowsOf(`tenantId=${a.tenantId}&limit=100&feeStatus=${feeStatus}`);

      // booking + add-on + upgrade + partially refunded; never the two failures
      const provisional = await q('PROVISIONAL');
      expect(provisional.total).toBe(4);
      expect(provisional.data.every((r) => r.feeStatus === 'PROVISIONAL')).toBe(
        true,
      );
      expect((await q('RECONCILED')).total).toBe(0);

      await db().query(
        `UPDATE payments SET fees_reconciled_at = now() WHERE id = $1`,
        [seeded.upgrade.id],
      );
      const reconciled = await q('RECONCILED');
      expect(reconciled.data.map((r) => r.id)).toEqual([seeded.upgrade.id]);
      expect(reconciled.data[0].feeStatus).toBe('RECONCILED');
      expect((await q('PROVISIONAL')).total).toBe(3);
      expect(
        (await get(admin, '/platform/finance/transactions?feeStatus=BOGUS'))
          .status,
      ).toBe(400);
    });

    it('A4. a payment with an OPEN reconciliation exception is flagged and filterable — until it is closed', async () => {
      const raised = await exceptions().raise({
        kind: 'AMOUNT_MISMATCH',
        provider: 'tap',
        objectId: bookingPayment.gateway_payment_id!,
        tenantId: a.tenantId,
        paymentId: bookingPayment.id,
        details: { ours: 250, theirs: 249 },
      });
      expect(raised.created).toBe(true);

      const flagged = await rowsOf(
        `tenantId=${a.tenantId}&limit=100&hasOpenException=true`,
      );
      expect(flagged.data.map((r) => r.id)).toEqual([bookingPayment.id]);
      expect(flagged.data[0].openExceptions).toBe(1);

      const [row] = await db().query(
        `SELECT id FROM payment_reconciliation_exceptions WHERE provider_object_id = $1`,
        [bookingPayment.gateway_payment_id],
      );
      // kept open for the queue test (D); a second one proves "open" is what counts
      const extra = await exceptions().raise({
        kind: 'STATUS_MISMATCH',
        provider: 'tap',
        objectId: seeded.addon.gateway_payment_id!,
        tenantId: a.tenantId,
        paymentId: seeded.addon.id,
        details: { ours: 'PAID', theirs: 'VOID' },
      });
      expect(extra.created).toBe(true);
      const [addonEx] = await db().query(
        `SELECT id FROM payment_reconciliation_exceptions WHERE provider_object_id = $1`,
        [seeded.addon.gateway_payment_id],
      );
      await exceptions().close(addonEx.id, undefined, 'RESOLVED', 'checked');
      expect(
        (
          await rowsOf(`tenantId=${a.tenantId}&limit=100&hasOpenException=true`)
        ).data.map((r) => r.id),
      ).toEqual([bookingPayment.id]);
      expect(row.id).toBeTruthy();
    });

    it('A5. the detail carries purpose, mode, fee status, payout and the payment’s exceptions', async () => {
      const res = await get(
        admin,
        `/platform/finance/transactions/${bookingPayment.id}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.payment).toMatchObject({
        purpose: 'BOOKING',
        settlementMode: 'PROVIDER',
        feeStatus: 'PROVISIONAL',
        feesReconciledAt: null,
        providerPayoutId: null,
        gateway: 'tap',
      });
      expect(res.body.exceptions).toHaveLength(1);
      expect(res.body.exceptions[0]).toMatchObject({
        kind: 'AMOUNT_MISMATCH',
        status: 'OPEN',
        occurrences: 1,
      });
      expect(Array.isArray(res.body.refunds)).toBe(true);

      const reconciled = await get(
        admin,
        `/platform/finance/transactions/${seeded.upgrade.id}`,
      );
      expect(reconciled.body.payment.feeStatus).toBe('RECONCILED');
      expect(reconciled.body.payment.feesReconciledAt).toBeTruthy();
      expect(reconciled.body.exceptions).toEqual([]);
    });

    it('A6. the export has the new columns and neutralises spreadsheet formulas in names', async () => {
      await db().query(`UPDATE tenants SET name = $2 WHERE id = $1`, [
        b.tenantId,
        `=HYPERLINK("http://x")${SUITE}`,
      ]);
      await seedPayment(b, { amount: 15, purpose: 'BOOKING' });

      const res = await get(
        admin,
        `/platform/finance/transactions/export?tenantId=${b.tenantId}`,
      );
      expect(res.status).toBe(200);
      const [header, ...lines] = (res.body.content as string).split('\n');
      expect(header).toContain('Purpose,Settlement Mode,Fee Status');
      expect(header).toContain('Provider Payout');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('BOOKING');
      expect(lines[0]).toContain('PROVISIONAL');
      // the clinic name is user-controlled text: a leading "=" must not survive as a formula
      expect(lines[0]).not.toMatch(/(^|,)"?=HYPERLINK/);
      expect(lines[0]).toContain("'=HYPERLINK");

      await db().query(`UPDATE tenants SET name = $2 WHERE id = $1`, [
        b.tenantId,
        `${SUITE} Clinic B`,
      ]);
    });
  });

  // ═══════════════════ B. clinic money vs platform revenue ═══════════════════ //

  describe('B. KPIs and drill-downs are about CLINIC money', () => {
    it('B1. the KPI cards count only what patients paid clinics (deltas over this suite’s writes)', async () => {
      const after = (await get(admin, '/platform/finance/kpis')).body;

      // Clinic money paid by this suite: clinic A's 250 SAR booking and the bystander's 15 SAR
      // (A6); the failed 75 SAR booking never counts. The 100 + 40 + 60 SAR the clinic paid
      // the PLATFORM must not appear anywhere in these.
      expect(after.todayRevenue - kpiBefore.todayRevenue).toBeCloseTo(265, 2);
      expect(after.monthlyRevenue - kpiBefore.monthlyRevenue).toBeCloseTo(
        265,
        2,
      );
      expect(after.todayTransactions - kpiBefore.todayTransactions).toBe(2);
      // failed: the failed BOOKING counts, the failed ADD-ON does not
      expect(after.failedPayments - kpiBefore.failedPayments).toBe(1);
      expect(after.clinicRevenue - kpiBefore.clinicRevenue).toBeCloseTo(265, 2);
      expect(after.currencies).toContain('SAR');
    });

    it('B2. what the platform itself collected is reported separately, per currency', async () => {
      const sar = (k: Record<string, any>) =>
        (k.collectedRevenue as Array<Record<string, any>>).find(
          (r) => r.currency === 'SAR',
        ) ?? { subscriptions: 0, addOns: 0, total: 0 };
      const after = (await get(admin, '/platform/finance/kpis')).body;

      // 100 (ADDON) + 40 (BILLING_UPGRADE) + (60 − 20 refunded) = 180; the failed 30 never counted
      expect(sar(after).addOns - sar(kpiBefore).addOns).toBeCloseTo(180, 2);
      expect(sar(after).total).toBeCloseTo(
        sar(after).subscriptions + sar(after).addOns,
        2,
      );
    });

    it('B3. a drill-down is clinic money unless asked otherwise', async () => {
      const clinic = await get(
        admin,
        `/platform/finance/metrics/monthlyRevenue?tenantId=${a.tenantId}`,
      );
      expect(clinic.status).toBe(200);
      expect(clinic.body.summary.primary).toBeCloseTo(250, 2);
      expect(clinic.body.totals.gross).toBeCloseTo(250, 2);
      expect(
        clinic.body.transactions.data.every(
          (r: any) => r.purpose === 'BOOKING',
        ),
      ).toBe(true);

      const platform = await get(
        admin,
        `/platform/finance/metrics/monthlyRevenue?tenantId=${a.tenantId}&purpose=PLATFORM_REVENUE`,
      );
      // PAID only: the 100 add-on and the 40 upgrade (the partially refunded one is its own status)
      expect(platform.body.totals.gross).toBeCloseTo(140, 2);
    });

    it('B4. the per-clinic summary is the clinic’s own money', async () => {
      const res = await get(
        admin,
        `/platform/finance/clinics/${a.tenantId}/summary`,
      );
      expect(res.status).toBe(200);
      expect(res.body.totals).toMatchObject({
        successfulPayments: 1,
        failedPayments: 1,
      });
      expect(res.body.totals.totalRevenue).toBeCloseTo(250, 2);
      expect(res.body.totals.highestBooking).toBeCloseTo(250, 2);
    });
  });

  // ═══════════════════ C. the subscription-revenue ledger ═══════════════════ //

  describe('C. the subscription-revenue ledger', () => {
    let s1: { clinic: OwnerFixture; invoiceId: string; chargeId: string };
    let s2: { clinic: OwnerFixture; invoiceId: string };
    let s3: { clinic: OwnerFixture; invoiceId: string };

    const ledger = (query: string, token = admin) =>
      get(token, `/platform/finance/subscription-invoices?${query}`);
    const name = async (clinic: OwnerFixture, label: string) =>
      db().query(`UPDATE tenants SET name = $2 WHERE id = $1`, [
        clinic.tenantId,
        `${SUITE} ${label}`,
      ]);

    /** A clinic subscribed to the plan: OPEN INITIAL invoice, then optionally paid through Tap. */
    async function subscribed(label: string, pay: boolean) {
      const clinic = await createOwnerFixture(
        e2e,
        `${SUITE}-${label.toLowerCase()}`,
      );
      await name(clinic, label);
      const created = await post(clinic.token, '/subscriptions', {
        planId: plan.id,
      });
      expect(created.status).toBe(201);
      const invoiceId = created.body.openInvoice.id as string;
      let chargeId = '';
      if (pay) {
        expect(
          (await post(clinic.token, `/billing/invoices/${invoiceId}/checkout`))
            .status,
        ).toBe(200);
        const charge = tap.capture(tap.lastCharge().id);
        chargeId = charge.id;
        await tap.deliver(e2e.app, charge).expect(200);
        await settle();
      }
      return { clinic, invoiceId, chargeId };
    }

    beforeAll(async () => {
      s1 = await subscribed('S1', true); // PAID by Tap
      s2 = await subscribed('S2', false); // OPEN, the renewal could not be charged
      await db().query(
        `UPDATE subscription_invoices
            SET failure_class = 'TOKENIZATION_UNAVAILABLE', retry_count = 1, kind = NULL
          WHERE id = $1`,
        [s2.invoiceId],
      );
      s3 = await subscribed('S3', true); // paid, then refunded by the platform
      tap.refundStatus = 'REFUNDED';
      expect(
        (
          await post(
            admin,
            `/platform/billing/invoices/${s3.invoiceId}/refund`,
            {
              reason: 'e2e',
            },
          )
        ).status,
      ).toBe(200);
      await settle();
    }, 120_000);

    it('C1. a paid invoice shows its kind, provider, charge, period and that it can be refunded', async () => {
      const res = await ledger(`tenantId=${s1.clinic.tenantId}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({
        id: s1.invoiceId,
        tenantId: s1.clinic.tenantId,
        tenantName: `${SUITE} S1`,
        planName: plan.name,
        kind: 'INITIAL',
        status: 'PAID',
        amount: 99,
        currency: 'SAR',
        provider: 'tap',
        providerReference: s1.chargeId,
        refundState: 'NONE',
        canRefund: true,
        failureClass: null,
      });
      expect(res.body.data[0].paidAt).toBeTruthy();
      expect(new Date(res.body.data[0].periodEnd).getTime()).toBeGreaterThan(
        new Date(res.body.data[0].periodStart).getTime(),
      );
    });

    it('C2. an unpaid renewal says why — a failure class, never provider text — and cannot be refunded', async () => {
      const res = await ledger(`tenantId=${s2.clinic.tenantId}`);
      expect(res.body.data[0]).toMatchObject({
        status: 'OPEN',
        kind: null,
        failureClass: 'TOKENIZATION_UNAVAILABLE',
        retryCount: 1,
        canRefund: false,
        providerReference: null,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/failure_reason/);
    });

    it('C3. a refunded invoice reads REFUNDED and is not refundable again', async () => {
      const res = await ledger(`tenantId=${s3.clinic.tenantId}`);
      expect(res.body.data[0]).toMatchObject({
        status: 'REFUNDED',
        refundState: 'REFUNDED',
        canRefund: false,
      });
      expect(res.body.data[0].refundedAt).toBeTruthy();
    });

    it('C4. the filters narrow by status, kind (LEGACY = no kind), refund state and attention', async () => {
      const q = async (extra: string) =>
        (await ledger(`search=${SUITE}&limit=100&${extra}`)).body;

      expect((await q('')).total).toBe(3);
      expect((await q('status=PAID')).data.map((r: any) => r.id)).toEqual([
        s1.invoiceId,
      ]);
      expect((await q('status=OPEN')).data.map((r: any) => r.id)).toEqual([
        s2.invoiceId,
      ]);
      expect((await q('kind=LEGACY')).data.map((r: any) => r.id)).toEqual([
        s2.invoiceId,
      ]);
      expect((await q('kind=INITIAL')).total).toBe(2);
      expect((await q('refund=REFUNDED')).data.map((r: any) => r.id)).toEqual([
        s3.invoiceId,
      ]);
      expect((await q('refund=IN_FLIGHT')).total).toBe(0);
      expect((await q('attention=true')).data.map((r: any) => r.id)).toEqual([
        s2.invoiceId,
      ]);
      // stamped when the invoice is issued under Tap, so the unpaid one carries it too
      expect((await q('provider=tap')).total).toBe(3);
      expect((await q('provider=noop')).total).toBe(0);
      expect((await q('issuedFrom=2999-01-01T00:00:00Z')).total).toBe(0);
    });

    it('C5. search finds a clinic by name, an invoice by id and a charge by its provider id', async () => {
      const byCharge = await ledger(`search=${s1.chargeId}`);
      expect(byCharge.body.data.map((r: any) => r.id)).toEqual([s1.invoiceId]);

      const byInvoice = await ledger(`search=${s2.invoiceId.slice(0, 13)}`);
      expect(byInvoice.body.data.map((r: any) => r.id)).toEqual([s2.invoiceId]);

      const byName = await ledger(`search=${SUITE} S3`);
      expect(byName.body.data.map((r: any) => r.id)).toEqual([s3.invoiceId]);
    });

    it('C6. the totals cover the whole filter, per currency — not just the page', async () => {
      const res = await ledger(`search=${SUITE}&limit=1&page=2`);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(3);

      expect(res.body.summary).toMatchObject({
        counts: { PAID: 1, OPEN: 1, REFUNDED: 1 },
        failedRenewals: 1,
        tokenizationDeclines: 1,
        refundsInFlight: 0,
      });
      expect(res.body.summary.byCurrency).toEqual([
        { currency: 'SAR', collected: 99, refunded: 99, outstanding: 99 },
      ]);
    });

    it('C7. sorting and validation', async () => {
      const asc = await ledger(`search=${SUITE}&sortBy=status&sortDir=ASC`);
      const statuses = asc.body.data.map((r: any) => r.status);
      expect([...statuses].sort()).toEqual(statuses);

      for (const bad of [
        'status=NOPE',
        'kind=NOPE',
        'limit=101',
        'sortBy=tenant_id',
        'issuedFrom=yesterday',
        'tenantId=not-a-uuid',
      ]) {
        expect((await ledger(bad)).status).toBe(400);
      }
    });

    it('C8. the export is audited and neutralises formulas in clinic names', async () => {
      await name(s1.clinic, 'S1').then(() =>
        db().query(`UPDATE tenants SET name = $2 WHERE id = $1`, [
          s1.clinic.tenantId,
          `=SUM(1+1) ${SUITE} S1`,
        ]),
      );
      const res = await get(
        admin,
        `/platform/finance/subscription-invoices/export?search=${SUITE}`,
      );
      expect(res.status).toBe(200);
      const [header, ...lines] = (res.body.content as string).split('\n');
      expect(header).toContain('Invoice,Clinic,Plan,Kind,Status,Amount');
      expect(lines).toHaveLength(3);
      expect(res.body.content).not.toMatch(/(^|,)"?=SUM/);
      expect(res.body.content).toContain("'=SUM(1+1)");
      expect(res.body.filename).toMatch(
        /^subscription-invoices-\d{4}-\d{2}-\d{2}\.csv$/,
      );

      const audit = await db().query(
        `SELECT new_values FROM audit_logs
          WHERE action = 'FINANCIAL_EXPORT' AND entity_type = 'marketplace_finance'
          ORDER BY created_at DESC LIMIT 5`,
      );
      expect(JSON.stringify(audit)).toContain('subscription-invoices');
      await name(s1.clinic, 'S1');
    });

    it('C9. it is for the platform owner only', async () => {
      for (const url of [
        '/platform/finance/subscription-invoices',
        '/platform/finance/subscription-invoices/export',
      ]) {
        expect((await get(s1.clinic.token, url)).status).toBe(403);
        expect((await http().get(`${API}${url}`)).status).toBe(401);
      }
    });
  });

  // ═══════════════════ D. the reconciliation queue ═══════════════════ //

  describe('D. the reconciliation queue names the clinic', () => {
    it('D1. list and detail carry the clinic name next to the id', async () => {
      const list = await get(
        admin,
        `/platform/finance/reconciliation?tenantId=${a.tenantId}&status=OPEN`,
      );
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        kind: 'AMOUNT_MISMATCH',
        tenant_id: a.tenantId,
        tenant_name: `${SUITE} Clinic A`,
        payment_id: bookingPayment.id,
      });
      expect(list.body.counts.OPEN).toBeGreaterThanOrEqual(1);

      const detail = await get(
        admin,
        `/platform/finance/reconciliation/${list.body.data[0].id}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body.tenant_name).toBe(`${SUITE} Clinic A`);
    });

    it('D2. an exception with no clinic (a platform-merchant discrepancy) reads null, not an error', async () => {
      await exceptions().raise({
        kind: 'UNKNOWN_CHARGE',
        provider: 'tap',
        objectId: `chg_pf_orphan_${randomUUID().slice(0, 8)}`,
        details: { amount: 5 },
      });
      const list = await get(
        admin,
        '/platform/finance/reconciliation?kind=UNKNOWN_CHARGE&limit=100',
      );
      expect(list.status).toBe(200);
      const orphan = list.body.data.find((r: any) =>
        String(r.provider_object_id).startsWith('chg_pf_orphan_'),
      );
      expect(orphan.tenant_name).toBeNull();
    });
  });

  // ═══════════════════ E. the clinic's own payments list ═══════════════════ //

  describe('E. the clinic payments list', () => {
    const list = (clinic: Clinic, query: string) =>
      get(clinic.owner.token, `/payments?${query}`);

    it('E1. fee status filters captured money; the default list is still the clinic’s own money', async () => {
      const all = await list(a, 'limit=100');
      expect(all.status).toBe(200);
      // booking + failed booking only: the three platform purchases are not listed by default
      expect(all.body.total).toBe(2);
      expect(all.body.data.map((p: any) => p.purpose).sort()).toEqual([
        'BOOKING',
        'BOOKING',
      ]);
      // the fields the clinic screen needs are on the row
      const row = all.body.data.find((p: any) => p.id === bookingPayment.id);
      expect(row).toMatchObject({
        gateway: 'tap',
        gateway_payment_id: bookingPayment.gateway_payment_id,
        settlement_mode: 'PROVIDER',
        fees_reconciled_at: null,
      });

      expect((await list(a, 'feeStatus=PROVISIONAL')).body.total).toBe(1);
      expect((await list(a, 'feeStatus=RECONCILED')).body.total).toBe(0);

      await db().query(
        `UPDATE payments SET fees_reconciled_at = now(), gateway_fee = 3.75, net_amount = 246.25 WHERE id = $1`,
        [bookingPayment.id],
      );
      const reconciled = await list(a, 'feeStatus=RECONCILED');
      expect(reconciled.body.data.map((p: any) => p.id)).toEqual([
        bookingPayment.id,
      ]);
      expect(Number(reconciled.body.data[0].gateway_fee)).toBe(3.75);
      expect(Number(reconciled.body.data[0].net_amount)).toBe(246.25);
      expect((await list(a, 'feeStatus=PROVISIONAL')).body.total).toBe(0);
      expect((await list(a, 'feeStatus=BOGUS')).status).toBe(400);
    });

    it('E2. a payment is found by its provider charge id or the start of its id — literally', async () => {
      const charge = bookingPayment.gateway_payment_id!;
      expect(
        (await list(a, `search=${charge}`)).body.data.map((p: any) => p.id),
      ).toEqual([bookingPayment.id]);
      expect(
        (await list(a, `search=${charge.slice(4, 14)}`)).body.data.map(
          (p: any) => p.id,
        ),
      ).toEqual([bookingPayment.id]);
      expect(
        (
          await list(a, `search=${bookingPayment.id.slice(0, 8)}`)
        ).body.data.map((p: any) => p.id),
      ).toEqual([bookingPayment.id]);
      expect((await list(a, 'search=chg_doesnotexist')).body.total).toBe(0);
      // `%` and `_` are not wildcards: as one, `%` would match everything and `c_g` would match "chg"
      expect((await list(a, 'search=%25')).body.total).toBe(0);
      expect((await list(a, 'search=c_g')).body.total).toBe(0);
      expect((await list(a, `search=${'x'.repeat(81)}`)).status).toBe(400);
    });

    it('E3. search stays inside the clinic: another clinic cannot find this charge', async () => {
      const charge = bookingPayment.gateway_payment_id!;
      expect((await list(b, `search=${charge}`)).body.total).toBe(0);
      expect(
        (await list(b, `search=${bookingPayment.id.slice(0, 8)}`)).body.total,
      ).toBe(0);
    });

    it('E4. add-on purchases are still returned when asked for by name — and searchable', async () => {
      const res = await list(
        a,
        `purpose=ADDON&search=${seeded.addon.gateway_payment_id}`,
      );
      expect(res.body.data.map((p: any) => p.id)).toEqual([seeded.addon.id]);
    });
  });

  // ═══════════════════ F. readers that called platform purchases "revenue" ═══════════════════ //

  describe('F. clinic analytics and the platform dashboard', () => {
    it('F1. a clinic’s revenue KPI is what patients paid it — not what it paid the platform', async () => {
      const kpis = await e2e.moduleRef
        .get(AnalyticsAggregationService, { strict: false })
        .computeDashboardKpis(a.tenantId);
      const metric = (key: string) =>
        kpis.find((k) => k.metric_key === key)?.metric_value;

      expect(metric('total_revenue')).toBeCloseTo(250, 2);
      expect(metric('total_paid_payments')).toBe(1);
    });

    it('F2. the platform dashboard’s volume and paying-clinic figures exclude platform purchases', async () => {
      const dashboard = e2e.moduleRef.get(PlatformDashboardService, {
        strict: false,
      });
      const before = await dashboard.summary({ range: '7d' } as never);

      // a fresh clinic whose ONLY payment is an add-on purchase, paid right now
      const c = await fx.makeClinic('pf-addon-only');
      await seedPayment(c, { amount: 500, purpose: 'ADDON' });
      await seedPayment(c, {
        amount: 45,
        purpose: 'ADDON',
        status: PaymentStatus.FAILED,
        paid_at: null,
      });

      const after = await dashboard.summary({ range: '7d' } as never);
      expect(
        after.metrics.grossVolume.current - before.metrics.grossVolume.current,
      ).toBe(0);
      expect(
        after.metrics.payingTenants.current -
          before.metrics.payingTenants.current,
      ).toBe(0);
      expect(
        after.metrics.failedPayments.current -
          before.metrics.failedPayments.current,
      ).toBe(0);
      // and the same clinic's BOOKING payment does count
      await seedPayment(c, { amount: 120, purpose: 'BOOKING' });
      const counted = await dashboard.summary({ range: '7d' } as never);
      expect(
        counted.metrics.grossVolume.current -
          before.metrics.grossVolume.current,
      ).toBe(120);
      expect(
        counted.metrics.payingTenants.current -
          before.metrics.payingTenants.current,
      ).toBe(1);
    });
  });

  // keep the invoice type referenced for the status enum the ledger tests lean on
  it('the ledger statuses used above are real invoice statuses', () => {
    expect(Object.values(InvoiceStatus)).toEqual(
      expect.arrayContaining(['OPEN', 'PAID', 'REFUNDED']),
    );
    expect(SubscriptionInvoice).toBeDefined();
  });
});
