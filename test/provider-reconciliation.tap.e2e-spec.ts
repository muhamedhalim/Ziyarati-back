/**
 * Tap migration, Phase 5 gate — the daily PROVIDER RECONCILIATION against what the
 * gateway reports, on real Postgres + Redis. Only Tap's network is stubbed
 * (`TapSandbox` answers `POST /v2/charges/download` with a CSV, `POST /v2/payouts/list`,
 * and can refuse a merchant the way Tap refuses a platform key for a sub-merchant).
 * Tap's payout report is live-only, so these fixtures ARE the evidence for plan
 * tests 19 and 20.
 *
 *  A. fees (test 20): applied ONCE from the report; never overwritten; a changed or
 *     internally inconsistent fee is raised;
 *  B. payouts (test 19): mirrored as read-only settlements, linked to their
 *     payments, checked against the net of their charges;
 *  C. discrepancies: amount, status, unknown capture, missing at provider, duplicate
 *     capture — recorded for a human, nothing moved;
 *  D. merchants Tap will not report on: a recorded fact, not a failure of the run;
 *  E. the exception queue: idempotent re-finding, closing, reopening on changed facts;
 *  F. the manual report import and the super-admin API.
 */
import './utils/tap-e2e-env.setup';
import './utils/tap-e2e-booking.setup';
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';
void TEST_META_ENV;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  authHeader,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import { TapSandbox, settle } from './utils/tap-e2e';
import { TapBookingFixtures, type Clinic } from './utils/tap-booking-fixtures';

import { TapApiClient } from '../src/modules/payments/providers/tap/tap-api.client';
import {
  ProviderReconciliationService,
  type ProviderReconcileSummary,
} from '../src/modules/payments/reconciliation/provider-reconciliation.service';
import { PaymentReconciliationService } from '../src/modules/payments/payment-reconciliation.service';
import { Payment } from '../src/entities/Payments/Payment';
import { PaymentStatus } from '../src/entities/enums';

const API = '/api/v1';
const SUITE = `pr-${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;

describe('Provider reconciliation over Tap (Phase 5) — real Postgres + Redis', () => {
  let e2e: E2eApp;
  const tap = new TapSandbox();
  let fx: TapBookingFixtures;
  let clinic: Clinic;
  let admin: string;

  const db = () => e2e.dataSource;
  const http = () => request(e2e.app.getHttpServer());
  const publicPost = (path: string) => http().post(`${API}${path}`);
  const svc = () =>
    e2e.moduleRef.get(ProviderReconciliationService, { strict: false });

  beforeAll(async () => {
    e2e = await createE2eApp((b) =>
      b.overrideProvider(TapApiClient).useValue(tap.asClient()),
    );
    fx = new TapBookingFixtures(e2e, tap, SUITE);
    clinic = await fx.makeClinic('pr');
    await fx.approve(clinic);
    admin = await fx.createSuperAdmin();
  }, 120_000);

  afterAll(async () => {
    await settle();
    await e2e.app.close();
  }, 30_000);

  beforeEach(() => {
    tap.reportRows.clear();
    tap.reportAccess.clear();
    tap.merchantPayouts.clear();
    tap.reportRequests.length = 0;
    tap.payoutRequests.length = 0;
    tap.maxReportPage = undefined;
    tap.endlessReport = false;
    tap.chargeListOutage = false;
  });

  // ───────────────────────────── helpers ───────────────────────────── //

  const paid = (c: Clinic = clinic) => fx.paidBooking(c, publicPost);

  /** The report row Tap would hold for a captured booking charge. */
  const rowFor = (
    c: Clinic,
    p: { gateway_payment_id?: string; id: string },
    appointmentId: string,
    over: Record<string, string | number> = {},
  ) =>
    tap.addReportRow(c.merchantId!, {
      charge_id: p.gateway_payment_id!,
      status: 'CAPTURED',
      currency: 'SAR',
      amount: '250.00',
      charge_date: String(Date.now() - 5 * HOUR),
      reference_transaction: p.id,
      reference_order: appointmentId,
      payment_method: 'MADA',
      fee: '3.75',
      fee_vat: '0.56',
      net_amount: '245.69',
      ...over,
    });

  const reconcile = (days = 3) => svc().run({ lookbackDays: days });
  const forMerchant = (s: ProviderReconcileSummary, merchantId?: string) =>
    s.merchants.find((m) => m.merchantId === merchantId)!;
  const exceptionsOn = (objectId: string, kind?: string) =>
    db().query(
      `SELECT * FROM payment_reconciliation_exceptions
        WHERE provider_object_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY kind`,
      kind ? [objectId, kind] : [objectId],
    );
  const payment = (id: string) => fx.paymentRow(id);

  // ═════════════════════════ A. fees (plan test 20) ═════════════════════════ //

  describe('A. fees', () => {
    it("A1. a captured charge's fee + VAT are written to the payment ONCE and marked final", async () => {
      const { appt, payment: p } = await paid();
      const before = await payment(p.id);
      expect(before.fees_reconciled_at).toBeNull(); // provisional: Tap reports no fee at capture
      expect(Number(before.gateway_fee)).toBe(0);
      rowFor(clinic, p, appt.id);

      const summary = await reconcile();

      const m = forMerchant(summary, clinic.merchantId);
      expect(m).toMatchObject({
        reports: 'ok',
        rows: 1,
        matched: 1,
        feesApplied: 1,
        exceptions: 0,
      });
      const after = await payment(p.id);
      expect(Number(after.gateway_fee)).toBe(4.31);
      expect(Number(after.net_amount)).toBe(245.69);
      expect(after.fees_reconciled_at).toBeTruthy();
      expect(after.payment_method).toBeTruthy();
      expect(after.metadata?.fee_breakdown).toMatchObject({
        source: 'tap_charges_report',
        fee: 3.75,
        fee_vat: 0.56,
      });
      // and what we asked Tap for: this merchant, this window, the charge-created view
      const asked = tap.reportRequests.find(
        (r) => r.merchants?.[0] === clinic.merchantId,
      )!;
      expect(asked).toMatchObject({
        period: { type: 'CHARGE' },
        merchants: [clinic.merchantId],
      });
      expect(
        Number(asked.period.date.to) - Number(asked.period.date.from),
      ).toBe(3 * 24 * HOUR);
    });

    it('A2. a re-run is a no-op: nothing re-applied, no exception, the stamp does not move', async () => {
      const { appt, payment: p } = await paid();
      rowFor(clinic, p, appt.id);
      await reconcile();
      const first = await payment(p.id);

      const again = forMerchant(await reconcile(), clinic.merchantId);

      expect(again).toMatchObject({
        feesApplied: 0,
        feesChanged: 0,
        exceptions: 0,
        matched: 1,
      });
      const second = await payment(p.id);
      expect(second.fees_reconciled_at!.getTime()).toBe(
        first.fees_reconciled_at!.getTime(),
      );
      expect(Number(second.gateway_fee)).toBe(4.31);
    });

    it('A3. TEST 20 — a fee that CHANGES after it was recorded is raised and NEVER overwritten', async () => {
      const { appt, payment: p } = await paid();
      rowFor(clinic, p, appt.id);
      await reconcile();
      tap.reportRows.clear();
      rowFor(clinic, p, appt.id, {
        fee: '6.00',
        fee_vat: '0.90',
        net_amount: '243.10',
      });

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m).toMatchObject({
        feesChanged: 1,
        feesApplied: 0,
        exceptions: 1,
      });
      expect(Number((await payment(p.id)).gateway_fee)).toBe(4.31); // untouched
      const [ex] = await exceptionsOn(p.gateway_payment_id!, 'FEE_MISMATCH');
      expect(ex).toMatchObject({
        status: 'OPEN',
        tenant_id: clinic.tenantId,
        payment_id: p.id,
      });
      expect(ex.details).toMatchObject({
        reason: 'CHANGED_AFTER_RECONCILED',
        recordedFee: 4.31,
        reportedFee: 6.9,
      });
    });

    it("A4. TEST 20 — Tap's own net_amount disagreeing with amount − fee − VAT is raised (the fee is still recorded)", async () => {
      const { appt, payment: p } = await paid();
      rowFor(clinic, p, appt.id, { net_amount: '200.00' });

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m).toMatchObject({ feesApplied: 1, exceptions: 1 });
      expect(Number((await payment(p.id)).gateway_fee)).toBe(4.31);
      const [ex] = await exceptionsOn(p.gateway_payment_id!, 'FEE_MISMATCH');
      expect(ex.details).toMatchObject({
        reason: 'NET_DOES_NOT_MATCH_AMOUNT_MINUS_FEE',
        reportedNet: 200,
      });
    });

    it('A5. a charge the report gives no fee for is left provisional (tried again next run), never "zero fee"', async () => {
      const { appt, payment: p } = await paid();
      rowFor(clinic, p, appt.id, { fee: '', fee_vat: '', net_amount: '' });

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m).toMatchObject({ feesApplied: 0, exceptions: 0, matched: 1 });
      expect((await payment(p.id)).fees_reconciled_at).toBeNull();
    });

    it('A6. a fee is only written to money that was really received (a FAILED payment is never given one)', async () => {
      const { token } = await fx.bookWithLink(clinic);
      await publicPost(`/public/payments/links/${token}/checkout`)
        .send({})
        .expect(200);
      const charge = tap.lastCharge();
      const p = await db()
        .getRepository(Payment)
        .findOneOrFail({ where: { gateway_payment_id: charge.id } });
      await db().query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [
        p.id,
      ]);
      rowFor(clinic, p, 'appt-x', {
        charge_date: String(Date.now() - 5 * HOUR),
      });

      await reconcile();

      const after = await payment(p.id);
      expect(after.fees_reconciled_at).toBeNull();
      expect(Number(after.gateway_fee)).toBe(0);
    });

    it('A7. paging: a report served two rows at a time is read to the end', async () => {
      tap.maxReportPage = 2;
      const made: Payment[] = [];
      for (let i = 0; i < 5; i += 1) {
        const x = await paid();
        rowFor(clinic, x.payment, x.appt.id);
        made.push(x.payment);
      }

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m).toMatchObject({ rows: 5, feesApplied: 5 });
      for (const p of made)
        expect((await payment(p.id)).fees_reconciled_at).toBeTruthy();
      expect(
        tap.reportRequests.filter((r) => r.merchants[0] === clinic.merchantId)
          .length,
      ).toBeGreaterThanOrEqual(3);
    });

    it('A8. a platform-revenue payment (add-on) is reconciled against the PLATFORM merchant, not a clinic', async () => {
      const addon = await db()
        .getRepository(Payment)
        .save({
          tenant: { id: clinic.tenantId },
          amount: 100,
          currency: 'SAR',
          status: PaymentStatus.PAID,
          gateway: 'tap',
          gateway_payment_id: `chg_addon${randomUUID().replace(/-/g, '')}`,
          purpose: 'ADDON',
          settlement_mode: 'NONE',
          paid_at: new Date(Date.now() - 6 * HOUR),
        } as unknown as Payment);
      tap.addReportRow('e2e-merchant', {
        charge_id: addon.gateway_payment_id!,
        status: 'CAPTURED',
        currency: 'SAR',
        amount: '100.00',
        charge_date: String(Date.now() - 6 * HOUR),
        fee: '1.50',
        fee_vat: '0.23',
        net_amount: '98.27',
      });

      const s = await reconcile();

      expect(forMerchant(s, 'e2e-merchant')).toMatchObject({
        scope: 'platform',
        reports: 'ok',
      });
      expect(Number((await payment(addon.id)).gateway_fee)).toBe(1.73);
    });
  });

  // ═════════════════ B. payouts and settlements (plan test 19) ═════════════════ //

  describe('B. payouts', () => {
    const payoutFor = (
      merchantId: string,
      over: Record<string, unknown> = {},
    ) => ({
      id: `payout_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      status: 'PAID_OUT',
      date: Date.now() - 2 * HOUR,
      amount: 245.69,
      currency: 'SAR',
      merchant_id: merchantId,
      bank_reference: 'BANKREF-1',
      ...over,
    });
    const settlementOf = async (payoutId: string) =>
      (
        await db().query(
          `SELECT * FROM settlements WHERE provider = 'tap' AND provider_payout_id = $1`,
          [payoutId],
        )
      )[0];

    it('B1. a payout is MIRRORED as a read-only settlement, linked to the payments it paid out, which become SETTLED', async () => {
      const { appt, payment: p } = await paid();
      const payout = payoutFor(clinic.merchantId!);
      tap.merchantPayouts.set(clinic.merchantId!, [payout]);
      rowFor(clinic, p, appt.id, {
        payout_id: payout.id,
        settlement_id: 'stl_1',
      });

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m).toMatchObject({ payoutsMirrored: 1, exceptions: 0 });
      const s = await settlementOf(payout.id);
      expect(s).toMatchObject({
        source: 'PROVIDER',
        provider: 'tap',
        status: 'PAID',
        currency: 'SAR',
        bank_reference: 'BANKREF-1',
        tenantId: clinic.tenantId,
      });
      expect(Number(s.net_amount)).toBe(245.69);
      expect(Number(s.gross_amount)).toBe(250);
      expect(Number(s.fee_amount)).toBe(4.31);
      expect(s.paid_at).toBeTruthy();

      const items = await db().query(
        `SELECT payment_id FROM settlement_items WHERE settlement_id = $1`,
        [s.id],
      );
      expect(items.map((i: { payment_id: string }) => i.payment_id)).toEqual([
        p.id,
      ]);
      const after = await payment(p.id);
      expect(after.settlement_status).toBe('SETTLED');
      expect(after.provider_payout_id).toBe(payout.id);
      // the payout was asked for by merchant, and its charges by payout id
      expect(tap.payoutRequests.at(-1)).toMatchObject({
        merchants: [clinic.merchantId],
      });
      expect(
        tap.reportRequests.find((r) => r.payouts?.payout_id?.[0] === payout.id),
      ).toMatchObject({ period: { type: 'PAID_OUT' } });
    });

    it('B2. importing the same payout again creates NO second settlement and re-links nothing twice', async () => {
      const { appt, payment: p } = await paid();
      const payout = payoutFor(clinic.merchantId!);
      tap.merchantPayouts.set(clinic.merchantId!, [payout]);
      rowFor(clinic, p, appt.id, { payout_id: payout.id });
      await reconcile();
      await reconcile();

      const rows = await db().query(
        `SELECT id FROM settlements WHERE provider_payout_id = $1`,
        [payout.id],
      );
      expect(rows).toHaveLength(1);
      const items = await db().query(
        `SELECT 1 FROM settlement_items WHERE settlement_id = $1`,
        [rows[0].id],
      );
      expect(items).toHaveLength(1);
    });

    it('B3. TEST 19 — a payout that does not equal the net of its charges is raised; fixing it resolves it', async () => {
      const { appt, payment: p } = await paid();
      const payout = payoutFor(clinic.merchantId!, { amount: 200 }); // charges net 245.69
      tap.merchantPayouts.set(clinic.merchantId!, [payout]);
      rowFor(clinic, p, appt.id, { payout_id: payout.id });

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m.exceptions).toBe(1);
      const [ex] = await exceptionsOn(payout.id, 'SETTLEMENT_MISMATCH');
      expect(ex).toMatchObject({ status: 'OPEN', tenant_id: clinic.tenantId });
      expect(ex.details).toMatchObject({
        payoutCents: 20000,
        chargesNetCents: 24569,
        differenceCents: -4569,
        chargeCount: 1,
      });

      // Tap corrects the payout: the same sweep now finds it adds up and closes the row itself
      tap.merchantPayouts.set(clinic.merchantId!, [
        { ...payout, amount: 245.69 },
      ]);
      await reconcile();
      const [closed] = await exceptionsOn(payout.id, 'SETTLEMENT_MISMATCH');
      expect(closed.status).toBe('RESOLVED');
      expect(closed.resolution_note).toMatch(/now equals/);
    });

    it('B4. a payout with a refund recorded against its charges matches EITHER reading (refund netted or not)', async () => {
      const { appt, payment: p } = await paid();
      await db().query(
        `UPDATE payments SET refunded_amount = 50 WHERE id = $1`,
        [p.id],
      );
      const payout = payoutFor(clinic.merchantId!, { amount: 195.69 }); // 245.69 − 50
      tap.merchantPayouts.set(clinic.merchantId!, [payout]);
      rowFor(clinic, p, appt.id, { payout_id: payout.id });

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m.exceptions).toBe(0);
      expect(await exceptionsOn(payout.id, 'SETTLEMENT_MISMATCH')).toHaveLength(
        0,
      );
    });

    it('B5. a payout still on its way is mirrored as PROCESSING, its payments only IN_BATCH — and later PAID_OUT it moves forward, never back', async () => {
      const { appt, payment: p } = await paid();
      const payout = payoutFor(clinic.merchantId!, { status: 'INITIATED' });
      tap.merchantPayouts.set(clinic.merchantId!, [payout]);
      rowFor(clinic, p, appt.id, { payout_id: payout.id });

      await reconcile();
      expect((await settlementOf(payout.id)).status).toBe('PROCESSING');
      expect((await payment(p.id)).settlement_status).toBe('IN_BATCH');

      tap.merchantPayouts.set(clinic.merchantId!, [
        { ...payout, status: 'PAID_OUT' },
      ]);
      await reconcile();
      expect((await settlementOf(payout.id)).status).toBe('PAID');
      expect((await payment(p.id)).settlement_status).toBe('SETTLED');

      // a stale answer must not walk a PAID payout back
      tap.merchantPayouts.set(clinic.merchantId!, [
        { ...payout, status: 'INITIATED' },
      ]);
      await reconcile();
      expect((await settlementOf(payout.id)).status).toBe('PAID');
      expect((await payment(p.id)).settlement_status).toBe('SETTLED');
    });

    it('B6. a FAILED payout is mirrored as FAILED and links nothing', async () => {
      const { appt, payment: p } = await paid();
      const payout = payoutFor(clinic.merchantId!, { status: 'FAILED' });
      tap.merchantPayouts.set(clinic.merchantId!, [payout]);
      rowFor(clinic, p, appt.id, { payout_id: payout.id });

      await reconcile();

      const s = await settlementOf(payout.id);
      expect(s.status).toBe('FAILED');
      expect(
        await db().query(
          `SELECT 1 FROM settlement_items WHERE settlement_id = $1`,
          [s.id],
        ),
      ).toHaveLength(0);
      expect((await payment(p.id)).settlement_status).toBe('UNSETTLED');
    });

    it("B7. another clinic's payment can never be linked to this clinic's payout", async () => {
      const other = await fx.makeClinic('pr-b7');
      await fx.approve(other);
      const theirs = await paid(other);
      const payout = payoutFor(clinic.merchantId!);
      tap.merchantPayouts.set(clinic.merchantId!, [payout]);
      // a (mis-attributed) row in OUR clinic's report that names THEIR charge
      tap.addReportRow(clinic.merchantId!, {
        charge_id: theirs.payment.gateway_payment_id!,
        status: 'CAPTURED',
        currency: 'SAR',
        amount: '250.00',
        charge_date: String(Date.now() - 5 * HOUR),
        payout_id: payout.id,
        fee: '3.75',
        fee_vat: '0.56',
        net_amount: '245.69',
      });

      await reconcile();

      const s = await settlementOf(payout.id);
      expect(
        await db().query(
          `SELECT 1 FROM settlement_items WHERE settlement_id = $1`,
          [s.id],
        ),
      ).toHaveLength(0);
      expect((await payment(theirs.payment.id)).settlement_status).not.toBe(
        'SETTLED',
      );
    });

    it('B8. a payout record that cannot be trusted (no id / negative amount / bad currency) is skipped, not mirrored', async () => {
      tap.merchantPayouts.set(clinic.merchantId!, [
        { id: '', status: 'PAID_OUT', amount: 10, currency: 'SAR' },
        payoutFor(clinic.merchantId!, { amount: -5 }),
        payoutFor(clinic.merchantId!, { currency: 'SARR' }),
        payoutFor(clinic.merchantId!, { amount: 'abc' }),
      ]);
      tap.addReportRow(clinic.merchantId!, {
        charge_id: 'chg_filler',
        status: 'DECLINED',
        currency: 'SAR',
        amount: '1',
      });

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m.payoutsMirrored).toBe(0);
    });
  });

  // ═════════════════════════════ C. discrepancies ═════════════════════════════ //

  describe('C. discrepancies are recorded for a human, never resolved by moving money', () => {
    it('C1. a captured amount that differs from ours → AMOUNT_MISMATCH, and no fee is applied', async () => {
      const { appt, payment: p } = await paid();
      rowFor(clinic, p, appt.id, { amount: '1.00' });

      await reconcile();

      const [ex] = await exceptionsOn(p.gateway_payment_id!, 'AMOUNT_MISMATCH');
      expect(ex.details).toMatchObject({
        reportAmountCents: 100,
        recordAmountCents: 25000,
      });
      expect((await payment(p.id)).fees_reconciled_at).toBeNull();
      expect((await payment(p.id)).status).toBe(PaymentStatus.PAID); // status untouched
    });

    it('C2. captured at Tap but not paid here (and old enough that our own paths must have landed) → STATUS_MISMATCH; a recent one is left alone', async () => {
      const { token } = await fx.bookWithLink(clinic);
      await publicPost(`/public/payments/links/${token}/checkout`)
        .send({})
        .expect(200);
      const p = await db()
        .getRepository(Payment)
        .findOneOrFail({ where: { gateway_payment_id: tap.lastCharge().id } });
      await db().query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [
        p.id,
      ]);
      rowFor(clinic, p, 'appt-c2', {
        charge_date: String(Date.now() - 10 * 60_000),
      }); // 10 minutes ago

      await reconcile();
      expect(
        await exceptionsOn(p.gateway_payment_id!, 'STATUS_MISMATCH'),
      ).toHaveLength(0);

      tap.reportRows.clear();
      rowFor(clinic, p, 'appt-c2', {
        charge_date: String(Date.now() - 5 * HOUR),
      });
      await reconcile();
      const [ex] = await exceptionsOn(p.gateway_payment_id!, 'STATUS_MISMATCH');
      expect(ex.details).toMatchObject({
        direction: 'CAPTURED_BUT_NOT_PAID',
        paymentStatus: 'FAILED',
      });
      expect((await payment(p.id)).status).toBe(PaymentStatus.FAILED); // never flipped by the report
    });

    it('C3. paid here but VOID at Tap → STATUS_MISMATCH the other way', async () => {
      const { appt, payment: p } = await paid();
      rowFor(clinic, p, appt.id, { status: 'VOID' });

      await reconcile();

      const [ex] = await exceptionsOn(p.gateway_payment_id!, 'STATUS_MISMATCH');
      expect(ex.details).toMatchObject({
        direction: 'PAID_BUT_NOT_CAPTURED',
        reportStatus: 'VOID',
      });
      expect((await payment(p.id)).status).toBe(PaymentStatus.PAID);
    });

    it('C4. a capture we have no record of → UNKNOWN_CHARGE (and a charge still in flight is ignored)', async () => {
      const unknown = `chg_unknown${randomUUID().replace(/-/g, '')}`;
      const inflight = `chg_inflight${randomUUID().replace(/-/g, '')}`;
      tap.addReportRow(clinic.merchantId!, {
        charge_id: unknown,
        status: 'CAPTURED',
        currency: 'SAR',
        amount: '75.00',
        charge_date: String(Date.now() - 5 * HOUR),
        reference_order: 'someone-elses-appt',
      });
      tap.addReportRow(clinic.merchantId!, {
        charge_id: inflight,
        status: 'INITIATED',
        currency: 'SAR',
        amount: '75.00',
        charge_date: String(Date.now() - 5 * HOUR),
      });

      await reconcile();

      const [ex] = await exceptionsOn(unknown, 'UNKNOWN_CHARGE');
      expect(ex).toMatchObject({
        status: 'OPEN',
        merchant_id: clinic.merchantId,
        tenant_id: clinic.tenantId,
      });
      expect(ex.details).toMatchObject({
        amount: 75,
        currency: 'SAR',
        referenceOrder: 'someone-elses-appt',
      });
      expect(await exceptionsOn(inflight)).toHaveLength(0);
    });

    it("C5. a payment we booked as paid that Tap's COMPLETE report does not contain → MISSING_AT_PROVIDER; an incomplete report never says so", async () => {
      const { payment: p } = await paid();
      await db().query(
        `UPDATE payments SET paid_at = now() - interval '6 hours' WHERE id = $1`,
        [p.id],
      );
      tap.addReportRow(clinic.merchantId!, {
        charge_id: 'chg_other',
        status: 'DECLINED',
        currency: 'SAR',
        amount: '1',
      });

      await reconcile();
      const [ex] = await exceptionsOn(
        p.gateway_payment_id!,
        'MISSING_AT_PROVIDER',
      );
      expect(ex).toMatchObject({
        payment_id: p.id,
        tenant_id: clinic.tenantId,
      });

      // an INCOMPLETE report (more pages promised, none reachable) proves nothing
      const q = await paid();
      await db().query(
        `UPDATE payments SET paid_at = now() - interval '6 hours' WHERE id = $1`,
        [q.payment.id],
      );
      tap.endlessReport = true;
      await reconcile();
      expect(
        await exceptionsOn(
          q.payment.gateway_payment_id!,
          'MISSING_AT_PROVIDER',
        ),
      ).toHaveLength(0);
    });

    it('C6. two live captures for ONE booking → DUPLICATE_CAPTURE on the later one, naming both', async () => {
      const { appt, payment: first } = await paid();
      const second = await db()
        .getRepository(Payment)
        .save({
          tenant: { id: clinic.tenantId },
          appointment: { id: appt.id },
          amount: 250,
          currency: 'SAR',
          status: PaymentStatus.PAID,
          gateway: 'tap',
          gateway_payment_id: `chg_dup${randomUUID().replace(/-/g, '')}`,
          purpose: 'BOOKING',
          settlement_mode: 'PROVIDER',
          paid_at: new Date(Date.now() - 4 * HOUR),
        } as unknown as Payment);
      rowFor(clinic, first, appt.id, {
        charge_date: String(Date.now() - 6 * HOUR),
      });
      rowFor(clinic, second, appt.id, {
        charge_date: String(Date.now() - 4 * HOUR),
      });

      await reconcile();

      const [ex] = await exceptionsOn(
        second.gateway_payment_id!,
        'DUPLICATE_CAPTURE',
      );
      expect(ex).toMatchObject({
        status: 'OPEN',
        payment_id: second.id,
        tenant_id: clinic.tenantId,
      });
      expect(ex.details).toMatchObject({
        reference: appt.id,
        firstChargeId: first.gateway_payment_id,
      });
      expect(
        await exceptionsOn(first.gateway_payment_id!, 'DUPLICATE_CAPTURE'),
      ).toHaveLength(0);
      // nothing was refunded or changed automatically
      expect((await payment(first.id)).status).toBe(PaymentStatus.PAID);
      expect((await payment(second.id)).status).toBe(PaymentStatus.PAID);
    });

    it('C7. paid, FULLY refunded, then paid again is NOT a duplicate', async () => {
      const { appt, payment: first } = await paid();
      await db().query(
        `UPDATE payments SET status = 'REFUNDED', refunded_amount = 250 WHERE id = $1`,
        [first.id],
      );
      const second = await db()
        .getRepository(Payment)
        .save({
          tenant: { id: clinic.tenantId },
          appointment: { id: appt.id },
          amount: 250,
          currency: 'SAR',
          status: PaymentStatus.PAID,
          gateway: 'tap',
          gateway_payment_id: `chg_again${randomUUID().replace(/-/g, '')}`,
          purpose: 'BOOKING',
          settlement_mode: 'PROVIDER',
          paid_at: new Date(Date.now() - 4 * HOUR),
        } as unknown as Payment);
      rowFor(clinic, first, appt.id, {
        charge_date: String(Date.now() - 6 * HOUR),
      });
      rowFor(clinic, second, appt.id, {
        charge_date: String(Date.now() - 4 * HOUR),
      });

      await reconcile();

      expect(
        await exceptionsOn(second.gateway_payment_id!, 'DUPLICATE_CAPTURE'),
      ).toHaveLength(0);
    });

    it('C8. a row naming ANOTHER merchant, beside ours, is not ours to judge and never touches our records', async () => {
      // A clinic of its own: the shared one still holds old PAID rows an unrelated report omits.
      const own = await fx.makeClinic('pr-c8');
      await fx.approve(own);
      const { appt, payment: p } = await paid(own);
      const other = await paid(own);
      rowFor(own, p, appt.id);
      rowFor(own, other.payment, other.appt.id, {
        merchant_id: 'merchant_SOMEONE_ELSE',
      });

      const m = forMerchant(await reconcile(), own.merchantId);

      expect(m).toMatchObject({ rows: 1, feesApplied: 1, exceptions: 0 });
      expect((await payment(p.id)).fees_reconciled_at).toBeTruthy();
      expect((await payment(other.payment.id)).fees_reconciled_at).toBeNull();
    });

    it('C9. when EVERY row carries one id in another format than the filter (Tap\'s column vs merchants[]), the report is trusted as asked — never read as "Tap reports nothing"', async () => {
      const { appt, payment: p } = await paid();
      await db().query(
        `UPDATE payments SET paid_at = now() - interval '6 hours' WHERE id = $1`,
        [p.id],
      );
      rowFor(clinic, p, appt.id, { merchant_id: '599242' }); // numeric id, as in Tap's examples

      const m = forMerchant(await reconcile(), clinic.merchantId);

      expect(m).toMatchObject({ rows: 1, feesApplied: 1 });
      expect((await payment(p.id)).fees_reconciled_at).toBeTruthy();
      // …and our paid-6-hours-ago payment is NOT flagged as missing from an "empty" report
      expect(
        await exceptionsOn(p.gateway_payment_id!, 'MISSING_AT_PROVIDER'),
      ).toHaveLength(0);
    });
  });

  // ═════════════════════ D. merchants Tap will not report on ═════════════════════ //

  describe('D. a merchant whose report Tap will not give us', () => {
    it('D1. is recorded ONCE as a fact on the account, never as an error per charge — and the other merchants are still reconciled', async () => {
      const blocked = await fx.makeClinic('pr-d1');
      await fx.approve(blocked);
      await paid(blocked);
      tap.reportAccess.set(blocked.merchantId!, 'denied');
      const { appt, payment: p } = await paid();
      rowFor(clinic, p, appt.id);

      const s = await reconcile();

      expect(forMerchant(s, blocked.merchantId)).toMatchObject({
        reports: 'unreachable',
        exceptions: 1,
      });
      const acct = (
        await db().query(
          `SELECT provider_reports_status, provider_reports_checked_at FROM merchant_accounts WHERE "tenantId" = $1`,
          [blocked.tenantId],
        )
      )[0];
      expect(acct.provider_reports_status).toBe('UNREACHABLE');
      expect(acct.provider_reports_checked_at).toBeTruthy();
      const [ex] = await exceptionsOn(
        blocked.merchantId!,
        'REPORTS_UNREACHABLE',
      );
      expect(ex.details).toMatchObject({
        scope: 'clinic',
        reason: 'rejected',
        httpStatus: 403,
      });
      // …while the reachable clinic went through
      expect(forMerchant(s, clinic.merchantId)).toMatchObject({
        reports: 'ok',
        feesApplied: 1,
      });
      // and the blocked clinic's charges are not flagged as missing
      expect(
        await db().query(
          `SELECT 1 FROM payment_reconciliation_exceptions WHERE kind = 'MISSING_AT_PROVIDER' AND tenant_id = $1`,
          [blocked.tenantId],
        ),
      ).toHaveLength(0);
    });

    it('D2. when Tap lets us read it again, the status flips to OK and the exception closes itself', async () => {
      const blocked = await fx.makeClinic('pr-d2');
      await fx.approve(blocked);
      tap.reportAccess.set(blocked.merchantId!, 'denied');
      await reconcile();
      expect(
        (await exceptionsOn(blocked.merchantId!, 'REPORTS_UNREACHABLE'))[0]
          .status,
      ).toBe('OPEN');

      tap.reportAccess.set(blocked.merchantId!, 'ok');
      tap.reportRows.set(blocked.merchantId!, []);
      await reconcile();

      const acct = (
        await db().query(
          `SELECT provider_reports_status FROM merchant_accounts WHERE "tenantId" = $1`,
          [blocked.tenantId],
        )
      )[0];
      expect(acct.provider_reports_status).toBe('OK');
      expect(
        (await exceptionsOn(blocked.merchantId!, 'REPORTS_UNREACHABLE'))[0]
          .status,
      ).toBe('RESOLVED');
    });

    it('D3. a Tap OUTAGE is not a verdict: no exception, the recorded status is unchanged, the run carries on', async () => {
      const flaky = await fx.makeClinic('pr-d3');
      await fx.approve(flaky);
      tap.reportAccess.set(flaky.merchantId!, 'ok');
      tap.reportRows.set(flaky.merchantId!, []);
      await reconcile(); // OK recorded
      tap.reportAccess.set(flaky.merchantId!, 'outage');

      const s = await reconcile();

      expect(forMerchant(s, flaky.merchantId)).toMatchObject({
        reports: 'unavailable',
        exceptions: 0,
      });
      const acct = (
        await db().query(
          `SELECT provider_reports_status FROM merchant_accounts WHERE "tenantId" = $1`,
          [flaky.tenantId],
        )
      )[0];
      expect(acct.provider_reports_status).toBe('OK');
      expect(
        await exceptionsOn(flaky.merchantId!, 'REPORTS_UNREACHABLE'),
      ).toHaveLength(0);
    });

    it('D4. a report that is not a report (HTML, wrong columns) is "unreachable", never half-applied', async () => {
      const bad = await fx.makeClinic('pr-d4');
      await fx.approve(bad);
      tap.reportAccess.set(bad.merchantId!, 'garbage');

      const s = await reconcile();

      expect(forMerchant(s, bad.merchantId)).toMatchObject({
        reports: 'unreachable',
      });
      const [ex] = await exceptionsOn(bad.merchantId!, 'REPORTS_UNREACHABLE');
      expect(ex.details).toMatchObject({ reason: 'unparsable_report' });
    });
  });

  // ═══════════════════════════ E. the exception queue ═══════════════════════════ //

  describe('E. the exception queue', () => {
    it('E1. the same discrepancy found by a later run is the SAME row (occurrences), not a new one', async () => {
      const unknown = `chg_e1${randomUUID().replace(/-/g, '')}`;
      tap.addReportRow(clinic.merchantId!, {
        charge_id: unknown,
        status: 'CAPTURED',
        currency: 'SAR',
        amount: '9.00',
        charge_date: String(Date.now() - 5 * HOUR),
      });

      const first = forMerchant(await reconcile(), clinic.merchantId);
      const second = forMerchant(await reconcile(), clinic.merchantId);

      expect(first.exceptions).toBe(1);
      expect(second.exceptions).toBe(0); // re-found, not news
      const rows = await exceptionsOn(unknown, 'UNKNOWN_CHARGE');
      expect(rows).toHaveLength(1);
      expect(rows[0].occurrences).toBe(2);
    });

    it('E2. a closed exception stays closed while the facts are the same, and REOPENS when they change', async () => {
      const unknown = `chg_e2${randomUUID().replace(/-/g, '')}`;
      const add = (amount: string) => {
        tap.reportRows.clear();
        tap.addReportRow(clinic.merchantId!, {
          charge_id: unknown,
          status: 'CAPTURED',
          currency: 'SAR',
          amount,
          charge_date: String(Date.now() - 5 * HOUR),
        });
      };
      add('9.00');
      await reconcile();
      const [open] = await exceptionsOn(unknown, 'UNKNOWN_CHARGE');
      await http()
        .patch(`${API}/platform/finance/reconciliation/${open.id}`)
        .set(...authHeader(admin))
        .send({
          status: 'IGNORED',
          note: 'test charge from the clinic owner, ignored',
        })
        .expect(200);

      await reconcile(); // same facts
      expect((await exceptionsOn(unknown, 'UNKNOWN_CHARGE'))[0].status).toBe(
        'IGNORED',
      );

      add('12.00'); // the facts changed
      const m = forMerchant(await reconcile(), clinic.merchantId);
      const [reopened] = await exceptionsOn(unknown, 'UNKNOWN_CHARGE');
      expect(reopened.status).toBe('OPEN');
      expect(reopened.resolution_note).toBeNull();
      expect(m.exceptions).toBe(1);
    });
  });

  // ═══════════════════ F. the manual import and the platform API ═══════════════════ //

  describe('F. manual report import and the super-admin API', () => {
    const csvFor = (rows: Array<Record<string, string>>) =>
      TapSandbox.csv(rows);
    const importCsv = (csv: string, token = admin) =>
      http()
        .post(`${API}/platform/finance/reconciliation/import`)
        .set(...authHeader(token))
        .send({ csv });
    const standalone = (
      p: { gateway_payment_id?: string; id: string },
      appId: string,
      over: Record<string, string | number> = {},
    ) => {
      const rows = tap.addReportRow('__import__', {
        charge_id: p.gateway_payment_id!,
        status: 'CAPTURED',
        currency: 'SAR',
        amount: '250.00',
        charge_date: String(Date.now() - 5 * HOUR),
        reference_transaction: p.id,
        reference_order: appId,
        payment_method: 'VISA',
        fee: '3.75',
        fee_vat: '0.56',
        net_amount: '245.69',
        merchant_id: '',
        ...over,
      });
      tap.reportRows.delete('__import__');
      return rows;
    };

    it('F1. applies fees and payout ids to charges we hold, ONCE, and reports what it did — without touching a status', async () => {
      const { appt, payment: p } = await paid();
      const row = standalone(p, appt.id, { payout_id: 'payout_import_1' });

      const res = await importCsv(csvFor([row])).expect(200);

      expect(res.body).toMatchObject({
        scope: 'import',
        rows: 1,
        matched: 1,
        feesApplied: 1,
        exceptions: 0,
      });
      const after = await payment(p.id);
      expect(Number(after.gateway_fee)).toBe(4.31);
      expect(after.provider_payout_id).toBe('payout_import_1');
      expect(after.status).toBe(PaymentStatus.PAID);

      const again = await importCsv(csvFor([row])).expect(200);
      expect(again.body).toMatchObject({ feesApplied: 0 });
    });

    it('F2. flags a discrepancy instead of applying it, and counts rows it could not read', async () => {
      const { appt, payment: p } = await paid();
      const row = standalone(p, appt.id, { amount: '5.00' });
      const csv = `${csvFor([row])}\ntoo,few,cells`;

      const res = await importCsv(csv).expect(200);

      expect(res.body).toMatchObject({
        rows: 1,
        skippedRows: 1,
        feesApplied: 0,
        exceptions: 1,
      });
      expect(
        await exceptionsOn(p.gateway_payment_id!, 'AMOUNT_MISMATCH'),
      ).toHaveLength(1);
    });

    it('F3. refuses an empty report, a non-report, and a clinic user', async () => {
      await importCsv('').expect(422);
      await importCsv('   ').expect(422);
      await importCsv('<html>502</html>').expect(422);
      await importCsv('charge_id,amount\nchg_1,1').expect(422); // missing required columns
      await importCsv(csvFor([]), clinic.owner.token).expect(403);
    });

    it('F4. lists exceptions (filterable, with counts) for a super admin only', async () => {
      const unknown = `chg_f4${randomUUID().replace(/-/g, '')}`;
      tap.addReportRow(clinic.merchantId!, {
        charge_id: unknown,
        status: 'CAPTURED',
        currency: 'SAR',
        amount: '3.00',
        charge_date: String(Date.now() - 5 * HOUR),
      });
      await reconcile();

      const res = await http()
        .get(
          `${API}/platform/finance/reconciliation?kind=UNKNOWN_CHARGE&status=OPEN&tenantId=${clinic.tenantId}`,
        )
        .set(...authHeader(admin))
        .expect(200);
      expect(
        res.body.data.map(
          (e: { provider_object_id: string }) => e.provider_object_id,
        ),
      ).toContain(unknown);
      expect(res.body.counts.OPEN).toBeGreaterThanOrEqual(1);
      expect(
        res.body.data.every(
          (e: { tenant_id: string }) => e.tenant_id === clinic.tenantId,
        ),
      ).toBe(true);

      await http()
        .get(`${API}/platform/finance/reconciliation`)
        .set(...authHeader(clinic.owner.token))
        .expect(403);
      await http().get(`${API}/platform/finance/reconciliation`).expect(401);
      await http()
        .get(`${API}/platform/finance/reconciliation?kind=NOPE`)
        .set(...authHeader(admin))
        .expect(400);
    });

    it('F5. closing: IGNORED needs a note; a closed row cannot be closed the other way; the action is audited', async () => {
      const unknown = `chg_f5${randomUUID().replace(/-/g, '')}`;
      tap.addReportRow(clinic.merchantId!, {
        charge_id: unknown,
        status: 'CAPTURED',
        currency: 'SAR',
        amount: '3.00',
        charge_date: String(Date.now() - 5 * HOUR),
      });
      await reconcile();
      const [ex] = await exceptionsOn(unknown, 'UNKNOWN_CHARGE');
      const patch = (body: object, token = admin) =>
        http()
          .patch(`${API}/platform/finance/reconciliation/${ex.id}`)
          .set(...authHeader(token))
          .send(body);

      await patch({ status: 'IGNORED' }).expect(422); // no note
      await patch({ status: 'IGNORED', note: 'x' }).expect(200);
      await patch({ status: 'IGNORED', note: 'x' }).expect(200); // idempotent
      await patch({ status: 'RESOLVED' }).expect(409); // already closed the other way
      await patch({ status: 'RESOLVED' }, clinic.owner.token).expect(403);
      await patch({ status: 'MAYBE' }).expect(400);

      const closed = (await exceptionsOn(unknown, 'UNKNOWN_CHARGE'))[0];
      expect(closed).toMatchObject({ status: 'IGNORED', resolution_note: 'x' });
      expect(closed.resolved_by).toBeTruthy();
      const audit = await db().query(
        `SELECT action FROM audit_logs WHERE entity_type = 'payment_reconciliation_exception' AND entity_id = $1`,
        [ex.id],
      );
      expect(audit.map((a: { action: string }) => a.action)).toContain(
        'platform_admin.reconciliation.exception_ignored',
      );
    });
  });
  // ═══════════ G. payments whose gateway id was never stored (REL-002) ═══════════ //

  describe('G. a PENDING payment with no gateway id (create reached Tap, our finalize failed)', () => {
    const sweep = () =>
      e2e.moduleRef
        .get(PaymentReconciliationService, { strict: false })
        .reconcileStalePending();

    /** A PENDING payment whose Tap id we "lost", old enough for the sweep to look at. */
    async function lostIdPayment() {
      const { appt, token } = await fx.bookWithLink(clinic);
      await publicPost(`/public/payments/links/${token}/checkout`)
        .send({})
        .expect(200);
      const charge = tap.lastCharge();
      const p = await db()
        .getRepository(Payment)
        .findOneOrFail({ where: { gateway_payment_id: charge.id } });
      await db().query(
        `UPDATE payments SET gateway_payment_id = NULL, created_at = now() - interval '30 minutes' WHERE id = $1`,
        [p.id],
      );
      return { appt, p, charge };
    }

    it('G1. the payer PAID and the webhook was lost too: the sweep finds the charge by OUR reference, attaches its id and books the payment', async () => {
      const { appt, p, charge } = await lostIdPayment();
      tap.capture(charge.id); // captured at Tap; no webhook will ever arrive

      const summary = await sweep();

      expect(summary.attached).toBeGreaterThanOrEqual(1);
      const after = await payment(p.id);
      expect(after.gateway_payment_id).toBe(charge.id);
      expect(after.status).toBe(PaymentStatus.PAID);
      // the booking follows through the durable outcome, exactly as for a webhook-paid one
      await fx.runOutcome(clinic.tenantId, p.id, 'paid');
      expect((await fx.apptRow(appt.id)).status).toBe('CONFIRMED');
      expect(tap.listCharges).toHaveBeenCalledWith(
        expect.objectContaining({ reference: { transaction: [p.id] } }),
      );
    });

    it('G2. the charge exists at Tap but is not paid yet: the id is attached and the payment stays PENDING', async () => {
      const { p, charge } = await lostIdPayment();

      await sweep();

      const after = await payment(p.id);
      expect(after.gateway_payment_id).toBe(charge.id);
      expect(after.status).toBe(PaymentStatus.PENDING);
    });

    it('G3. Tap holds nothing for it: the payment is left exactly as it was — "not found" is never "failed"', async () => {
      const { p, charge } = await lostIdPayment();
      tap.charges.delete(charge.id);

      await sweep();

      const after = await payment(p.id);
      expect(after.gateway_payment_id).toBeNull();
      expect(after.status).toBe(PaymentStatus.PENDING);
    });

    it('G4. Tap cannot answer (outage): nothing changes', async () => {
      const { p, charge } = await lostIdPayment();
      tap.capture(charge.id);
      tap.chargeListOutage = true;

      await sweep();

      const after = await payment(p.id);
      expect(after.gateway_payment_id).toBeNull();
      expect(after.status).toBe(PaymentStatus.PENDING);
    });

    it('G5. a charge already attached to ANOTHER payment is never stolen (the unique id holds)', async () => {
      const { p, charge } = await lostIdPayment();
      tap.capture(charge.id);
      // another payment row already claims that very charge id
      await db()
        .getRepository(Payment)
        .save({
          tenant: { id: clinic.tenantId },
          amount: 250,
          currency: 'SAR',
          status: PaymentStatus.PAID,
          gateway: 'tap',
          gateway_payment_id: charge.id,
          purpose: 'MANUAL',
          settlement_mode: 'PROVIDER',
          paid_at: new Date(),
        } as unknown as Payment);

      await sweep();

      expect((await payment(p.id)).gateway_payment_id).toBeNull();
    });
  });

  // ═════════════ H. live detection (not waiting for the daily report) ═════════════ //

  describe('H. discrepancies noticed as they happen', () => {
    it('H1. a captured amount that differs from ours is refused AND recorded the moment the webhook arrives', async () => {
      const { token } = await fx.bookWithLink(clinic);
      await publicPost(`/public/payments/links/${token}/checkout`)
        .send({})
        .expect(200);
      const charge = tap.lastCharge();
      tap.capture(charge.id, { amount: 1 }); // Tap says the payer paid 1 SAR, not 250

      await tap.deliver(e2e.app, charge).expect(200);
      await settle();

      const p = await db()
        .getRepository(Payment)
        .findOneOrFail({ where: { gateway_payment_id: charge.id } });
      expect(p.status).toBe(PaymentStatus.PENDING); // never booked
      const [ex] = await exceptionsOn(charge.id, 'AMOUNT_MISMATCH');
      expect(ex).toMatchObject({
        status: 'OPEN',
        payment_id: p.id,
        tenant_id: clinic.tenantId,
      });
      expect(ex.details).toMatchObject({
        source: 'webhook',
        expectedAmountCents: 25000,
        reportedAmountCents: 100,
      });
    });

    it('H2. a SECOND live capture for a booking is recorded as soon as its payment is applied; the first is never blamed', async () => {
      const { appt, payment: first } = await paid();
      const second = await db()
        .getRepository(Payment)
        .save({
          tenant: { id: clinic.tenantId },
          appointment: { id: appt.id },
          amount: 250,
          currency: 'SAR',
          status: PaymentStatus.PAID,
          gateway: 'tap',
          gateway_payment_id: `chg_live${randomUUID().replace(/-/g, '')}`,
          purpose: 'BOOKING',
          settlement_mode: 'PROVIDER',
          paid_at: new Date(Date.now() + 1000), // later than the first
        } as unknown as Payment);

      await fx.runOutcome(clinic.tenantId, second.id, 'paid');

      const [ex] = await exceptionsOn(
        second.gateway_payment_id!,
        'DUPLICATE_CAPTURE',
      );
      expect(ex).toMatchObject({
        status: 'OPEN',
        payment_id: second.id,
        tenant_id: clinic.tenantId,
      });
      expect(ex.details).toMatchObject({
        reference: appt.id,
        firstChargeId: first.gateway_payment_id,
      });
      expect(
        await exceptionsOn(first.gateway_payment_id!, 'DUPLICATE_CAPTURE'),
      ).toHaveLength(0);
      // nothing moved
      expect((await payment(first.id)).status).toBe(PaymentStatus.PAID);
      expect((await payment(second.id)).status).toBe(PaymentStatus.PAID);

      // …and the daily report finds the SAME row rather than a second one
      rowFor(clinic, first, appt.id, {
        charge_date: String(Date.now() - 6 * HOUR),
      });
      rowFor(clinic, second, appt.id, {
        charge_date: String(Date.now() - 4 * HOUR),
      });
      await reconcile();
      expect(
        await exceptionsOn(second.gateway_payment_id!, 'DUPLICATE_CAPTURE'),
      ).toHaveLength(1);
    });

    it('H3. an ordinary single payment raises nothing', async () => {
      const { payment: p } = await paid();
      await fx.runOutcome(clinic.tenantId, p.id, 'paid');
      expect(await exceptionsOn(p.gateway_payment_id!)).toHaveLength(0);
    });

    it('H4. a booking paid, fully refunded and paid again is not a duplicate', async () => {
      const { appt, payment: first } = await paid();
      await db().query(
        `UPDATE payments SET status = 'REFUNDED', refunded_amount = 250 WHERE id = $1`,
        [first.id],
      );
      const second = await db()
        .getRepository(Payment)
        .save({
          tenant: { id: clinic.tenantId },
          appointment: { id: appt.id },
          amount: 250,
          currency: 'SAR',
          status: PaymentStatus.PAID,
          gateway: 'tap',
          gateway_payment_id: `chg_again${randomUUID().replace(/-/g, '')}`,
          purpose: 'BOOKING',
          settlement_mode: 'PROVIDER',
          paid_at: new Date(),
        } as unknown as Payment);

      await fx.runOutcome(clinic.tenantId, second.id, 'paid');

      expect(
        await exceptionsOn(second.gateway_payment_id!, 'DUPLICATE_CAPTURE'),
      ).toHaveLength(0);
    });
  });
});
