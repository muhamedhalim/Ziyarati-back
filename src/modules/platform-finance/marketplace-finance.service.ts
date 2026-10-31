import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Transaction } from '../../entities/Payments/Transaction';
import { Refund } from '../../entities/Payments/Refund';
import { AppError, ErrorCode } from '../../common/errors';
import { escapeSpreadsheetCell } from '../../common/import/spreadsheet-escape';
import {
  CLINIC_REVENUE_PURPOSES,
  PLATFORM_REVENUE_PURPOSES,
  round2,
} from '../payments/payments.constants';
import { QueryMarketplaceTransactionsDto } from './dto/query-marketplace-transactions.dto';
import {
  FINANCE_METRICS,
  MEASURE_SQL,
  type MetricDef,
} from './metrics.constants';

export interface TrendPoint { label: string; value: number; count: number }
export interface BreakdownRow { key: string | null; label: string | null; value: number; gross: number; count: number }

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** A flattened marketplace transaction row for the admin table/export. */
export interface MarketplaceTransactionRow {
  id: string;
  bookingId: string | null;
  clinicId: string | null;
  clinicName: string | null;
  branchName: string | null;
  patientName: string | null;
  serviceName: string | null;
  gateway: string | null;
  paymentMethod: string | null;
  grossAmount: number;
  gatewayFee: number;
  platformFee: number;
  netAmount: number;
  refundedAmount: number;
  currency: string;
  paymentStatus: string;
  splitStatus: string;
  payoutStatus: string | null;
  refundStatus: string;
  gatewayPaymentId: string | null;
  merchantId: string | null;
  settlementId: string | null;
  settlementDate: string | null;
  paidAt: string | null;
  createdAt: string;
  /** BOOKING / MANUAL (clinic money) or ADDON / BILLING_UPGRADE (platform revenue). */
  purpose: string;
  /** INTERNAL (we batch it), PROVIDER (the gateway settles to the clinic), NONE (platform revenue). */
  settlementMode: string;
  /**
   * Whether the provider fee is final. `PROVISIONAL` = captured but the provider has not
   * reported its fee yet; `RECONCILED` = written from the provider report;
   * `NOT_APPLICABLE` = money was never captured.
   */
  feeStatus: FeeStatus;
  /** The provider payout this payment was settled in, once the report names one. */
  providerPayoutId: string | null;
  /** Reconciliation exceptions still OPEN on this payment. */
  openExceptions: number;
}

export type FeeStatus = 'PROVISIONAL' | 'RECONCILED' | 'NOT_APPLICABLE';

/** What the platform itself collected in one currency (see `kpis().collectedRevenue`). */
export interface PlatformRevenueRow {
  currency: string;
  subscriptions: number;
  addOns: number;
  total: number;
}

/** Statuses where money was captured, so a provider fee exists to be reconciled. */
const CAPTURED_STATUSES = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

const feeStatusOf = (status: string, reconciledAt: unknown): FeeStatus =>
  !(CAPTURED_STATUSES as readonly string[]).includes(status)
    ? 'NOT_APPLICABLE'
    : reconciledAt
      ? 'RECONCILED'
      : 'PROVISIONAL';

/** Resolves a `purpose` filter (a purpose, or one of the two groups) to purposes. */
export const purposesOf = (filter: string): string[] =>
  filter === 'CLINIC_MONEY'
    ? [...CLINIC_REVENUE_PURPOSES]
    : filter === 'PLATFORM_REVENUE'
      ? [...PLATFORM_REVENUE_PURPOSES]
      : [filter];

/**
 * Read-only marketplace financial reporting for super-admins. Aggregates ACROSS
 * tenants over the existing ledger tables (`payments` + `settlements`/
 * `settlement_items` + `transactions` + `refunds`) — it never writes financial
 * state and introduces no parallel ledger. All listing is server-side paginated,
 * filtered and sorted.
 */
@Injectable()
export class MarketplaceFinanceService {
  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    @InjectRepository(Refund)
    private readonly refunds: Repository<Refund>,
    private readonly dataSource: DataSource,
  ) {}

  // ───────────────────────────── Listing ───────────────────────────────── //

  private base(): SelectQueryBuilder<Payment> {
    return this.payments
      .createQueryBuilder('p')
      .leftJoin('p.tenant', 't')
      .leftJoin('p.branch', 'b')
      .leftJoin('p.customer', 'c')
      .leftJoin('settlement_items', 'si', 'si.payment_id = p.id')
      .leftJoin('settlements', 'st', 'st.id = si.settlement_id');
  }

  private applyFilters(
    qb: SelectQueryBuilder<Payment>,
    q: QueryMarketplaceTransactionsDto,
  ): void {
    if (q.tenantId) qb.andWhere('t.id = :tenantId', { tenantId: q.tenantId });
    if (q.branchId) qb.andWhere('b.id = :branchId', { branchId: q.branchId });
    if (q.customerId) qb.andWhere('c.id = :customerId', { customerId: q.customerId });
    if (q.appointmentId) qb.andWhere('p."appointmentId" = :apptId', { apptId: q.appointmentId });
    if (q.transactionId) qb.andWhere('p.id = :txnId', { txnId: q.transactionId });
    if (q.settlementId) qb.andWhere('st.id = :settlementId', { settlementId: q.settlementId });
    if (q.gatewayPaymentId) qb.andWhere('p.gateway_payment_id = :gpi', { gpi: q.gatewayPaymentId });
    if (q.merchantId) qb.andWhere('p.merchant_id = :mid', { mid: q.merchantId });
    if (q.subMerchantId) qb.andWhere('p.sub_merchant_id = :smid', { smid: q.subMerchantId });
    if (q.gateway) qb.andWhere('p.gateway = :gw', { gw: q.gateway });
    if (q.paymentMethod) qb.andWhere('p.payment_method = :pm', { pm: q.paymentMethod });
    if (q.currency) qb.andWhere('p.currency = :cur', { cur: q.currency });
    if (q.status) qb.andWhere('p.status = :status', { status: q.status });
    if (q.settlementStatus) qb.andWhere('p.settlement_status = :ss', { ss: q.settlementStatus });
    if (q.payoutStatus) qb.andWhere('st.status = :ps', { ps: q.payoutStatus });
    if (q.refundStatus) {
      qb.andWhere("COALESCE(p.refund_status, 'NONE') = :rs", { rs: q.refundStatus });
    }
    if (q.serviceId) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM appointment_services aps WHERE aps."appointmentId" = p."appointmentId" AND aps."serviceId" = :serviceId)`,
        { serviceId: q.serviceId },
      );
    }
    if (q.purpose) {
      qb.andWhere('p.purpose IN (:...purposes)', {
        purposes: purposesOf(q.purpose),
      });
    }
    if (q.feeStatus) {
      // A fee only exists for captured money, so the filter implies it.
      qb.andWhere('p.status IN (:...capturedStatuses)', {
        capturedStatuses: [...CAPTURED_STATUSES],
      });
      qb.andWhere(
        q.feeStatus === 'RECONCILED'
          ? 'p.fees_reconciled_at IS NOT NULL'
          : 'p.fees_reconciled_at IS NULL',
      );
    }
    if (q.hasOpenException === 'true') {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM payment_reconciliation_exceptions rx WHERE rx.payment_id = p.id AND rx.status = 'OPEN')`,
      );
    }

    this.dateRange(qb, 'p.created_at', q.createdFrom, q.createdTo, 'created');
    this.dateRange(qb, 'p.paid_at', q.paidFrom, q.paidTo, 'paid');
    this.dateRange(qb, 'st.paid_at', q.settlementFrom, q.settlementTo, 'settled');

    this.numRange(qb, 'p.amount', q.grossMin, q.grossMax, 'gross');
    this.numRange(qb, 'p.net_amount', q.netMin, q.netMax, 'net');
    this.numRange(qb, 'p.gateway_fee', q.gatewayFeeMin, q.gatewayFeeMax, 'gwf');
    this.numRange(qb, 'p.platform_fee', q.platformFeeMin, q.platformFeeMax, 'plf');

    if (q.search?.trim()) {
      const term = `%${q.search.trim()}%`;
      qb.andWhere(
        `(t.name ILIKE :term OR b.name ILIKE :term OR c.full_name ILIKE :term
          OR CAST(p.id AS text) ILIKE :term OR CAST(p."appointmentId" AS text) ILIKE :term
          OR p.gateway_payment_id ILIKE :term OR p.merchant_id ILIKE :term)`,
        { term },
      );
    }
  }

  private dateRange(
    qb: SelectQueryBuilder<Payment>,
    col: string,
    from?: string,
    to?: string,
    key = 'd',
  ): void {
    if (from) qb.andWhere(`${col} >= :${key}From`, { [`${key}From`]: new Date(from) });
    if (to) qb.andWhere(`${col} <= :${key}To`, { [`${key}To`]: new Date(to) });
  }

  private numRange(
    qb: SelectQueryBuilder<Payment>,
    col: string,
    min?: string,
    max?: string,
    key = 'n',
  ): void {
    if (min != null) qb.andWhere(`${col} >= :${key}Min`, { [`${key}Min`]: Number(min) });
    if (max != null) qb.andWhere(`${col} <= :${key}Max`, { [`${key}Max`]: Number(max) });
  }

  /**
   * @param extend optional predicate applied AFTER the standard filters — used by
   * metric drill-downs to add metric-specific constraints without duplicating the
   * filter/paginate/select machinery.
   */
  async listTransactions(
    q: QueryMarketplaceTransactionsDto,
    extend?: (qb: SelectQueryBuilder<Payment>) => void,
  ): Promise<{
    data: MarketplaceTransactionRow[];
    total: number;
    page: number;
    limit: number;
  }> {
    const countQb = this.base();
    this.applyFilters(countQb, q);
    extend?.(countQb);
    const totalRow = await countQb
      .select('COUNT(DISTINCT p.id)', 'cnt')
      .getRawOne<{ cnt: string }>();
    const total = n(totalRow?.cnt);

    const dataQb = this.base();
    this.applyFilters(dataQb, q);
    extend?.(dataQb);
    const rows = await dataQb
      .select([
        'p.id AS id',
        'p."appointmentId" AS booking_id',
        't.id AS clinic_id',
        't.name AS clinic_name',
        'b.name AS branch_name',
        'c.full_name AS patient_name',
        'p.amount AS gross_amount',
        'p.gateway_fee AS gateway_fee',
        'p.platform_fee AS platform_fee',
        'p.net_amount AS net_amount',
        'p.refunded_amount AS refunded_amount',
        'p.currency AS currency',
        'p.gateway AS gateway',
        'p.payment_method AS payment_method',
        'p.status AS payment_status',
        'p.settlement_status AS split_status',
        "COALESCE(p.refund_status, 'NONE') AS refund_status",
        'p.gateway_payment_id AS gateway_payment_id',
        'p.merchant_id AS merchant_id',
        'st.id AS settlement_id',
        'st.status AS payout_status',
        'st.paid_at AS settlement_date',
        'p.paid_at AS paid_at',
        'p.created_at AS created_at',
        'p.purpose AS purpose',
        'p.settlement_mode AS settlement_mode',
        'p.fees_reconciled_at AS fees_reconciled_at',
        'p.provider_payout_id AS provider_payout_id',
        `(SELECT COUNT(*)::int FROM payment_reconciliation_exceptions rx WHERE rx.payment_id = p.id AND rx.status = 'OPEN') AS open_exceptions`,
        `(SELECT s.name FROM appointment_services aps JOIN services s ON s.id = aps."serviceId" WHERE aps."appointmentId" = p."appointmentId" ORDER BY aps.created_at ASC LIMIT 1) AS service_name`,
      ])
      .orderBy(`p.${q.sortBy}`, q.sortDir)
      .addOrderBy('p.id', 'DESC')
      .offset((q.page - 1) * q.limit)
      .limit(q.limit)
      .getRawMany();

    return {
      data: rows.map((r) => this.mapRow(r)),
      total,
      page: q.page,
      limit: q.limit,
    };
  }

  private mapRow(r: Record<string, unknown>): MarketplaceTransactionRow {
    const iso = (v: unknown): string | null =>
      v ? new Date(v as string).toISOString() : null;
    return {
      id: r.id as string,
      bookingId: (r.booking_id as string) ?? null,
      clinicId: (r.clinic_id as string) ?? null,
      clinicName: (r.clinic_name as string) ?? null,
      branchName: (r.branch_name as string) ?? null,
      patientName: (r.patient_name as string) ?? null,
      serviceName: (r.service_name as string) ?? null,
      gateway: (r.gateway as string) ?? null,
      paymentMethod: (r.payment_method as string) ?? null,
      grossAmount: round2(n(r.gross_amount)),
      gatewayFee: round2(n(r.gateway_fee)),
      platformFee: round2(n(r.platform_fee)),
      netAmount: r.net_amount == null ? round2(n(r.gross_amount)) : round2(n(r.net_amount)),
      refundedAmount: round2(n(r.refunded_amount)),
      currency: (r.currency as string) ?? 'SAR',
      paymentStatus: r.payment_status as string,
      splitStatus: r.split_status as string,
      payoutStatus: (r.payout_status as string) ?? null,
      refundStatus: (r.refund_status as string) ?? 'NONE',
      gatewayPaymentId: (r.gateway_payment_id as string) ?? null,
      merchantId: (r.merchant_id as string) ?? null,
      settlementId: (r.settlement_id as string) ?? null,
      settlementDate: iso(r.settlement_date),
      paidAt: iso(r.paid_at),
      createdAt: new Date(r.created_at as string).toISOString(),
      purpose: (r.purpose as string) ?? 'BOOKING',
      settlementMode: (r.settlement_mode as string) ?? 'INTERNAL',
      feeStatus: feeStatusOf(r.payment_status as string, r.fees_reconciled_at),
      providerPayoutId: (r.provider_payout_id as string) ?? null,
      openExceptions: n(r.open_exceptions),
    };
  }

  // ───────────────────────────── Detail ────────────────────────────────── //

  async getTransaction(id: string) {
    // `payment`, `events`, `refunds` and `settlement` each key off the `id`
    // parameter independently — none consumes another's result — so they run
    // concurrently (PERF-BE-005). `serviceRows` genuinely depends on
    // `payment.appointment.id` and stays sequential after.
    const [payment, events, refunds, settlement, exceptions] = await Promise.all([
      this.payments.findOne({
        where: { id },
        relations: { tenant: true, branch: true, customer: true, appointment: true },
      }),
      this.transactions.find({
        where: { payment: { id } },
        order: { created_at: 'ASC' },
      }),
      this.refunds.find({
        where: { payment: { id } },
        order: { created_at: 'ASC' },
      }),
      this.dataSource.query(
        `SELECT st.id, st.status, st.paid_at, st.period_start, st.period_end,
              st.gross_amount, st.fee_amount, st.net_amount, st.currency
         FROM settlement_items si JOIN settlements st ON st.id = si.settlement_id
        WHERE si.payment_id = $1 LIMIT 1`,
        [id],
      ),
      // What the provider reconciliation has flagged on this payment (any state, newest first).
      this.dataSource.query(
        `SELECT id, kind, status, occurrences, first_seen_at, last_seen_at
           FROM payment_reconciliation_exceptions
          WHERE payment_id = $1
          ORDER BY last_seen_at DESC LIMIT 20`,
        [id],
      ),
    ]);
    if (!payment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Transaction not found' });
    }

    const serviceRows = await this.dataSource.query(
      `SELECT s.name, aps.price, aps.duration_minutes
         FROM appointment_services aps JOIN services s ON s.id = aps."serviceId"
        WHERE aps."appointmentId" = $1`,
      [payment.appointment?.id ?? null],
    );

    const gross = n(payment.amount);
    return {
      id: payment.id,
      booking: payment.appointment
        ? { id: payment.appointment.id }
        : null,
      clinic: payment.tenant
        ? { id: payment.tenant.id, name: payment.tenant.name }
        : null,
      branch: payment.branch
        ? { id: payment.branch.id, name: payment.branch.name }
        : null,
      patient: payment.customer
        ? { id: payment.customer.id, name: payment.customer.full_name ?? null }
        : null,
      services: serviceRows.map((s: Record<string, unknown>) => ({
        name: s.name as string,
        price: round2(n(s.price)),
        durationMinutes: n(s.duration_minutes),
      })),
      payment: {
        grossAmount: round2(gross),
        gatewayFee: round2(n(payment.gateway_fee)),
        platformFee: round2(n(payment.platform_fee)),
        netAmount: payment.net_amount == null ? round2(gross) : round2(n(payment.net_amount)),
        currency: payment.currency,
        status: payment.status,
        gateway: payment.gateway ?? null,
        paymentMethod: payment.payment_method ?? null,
        gatewayPaymentId: payment.gateway_payment_id ?? null,
        merchantId: payment.merchant_id ?? null,
        subMerchantId: payment.sub_merchant_id ?? null,
        purpose: payment.purpose,
        settlementMode: payment.settlement_mode,
        feeStatus: feeStatusOf(payment.status, payment.fees_reconciled_at),
        feesReconciledAt: payment.fees_reconciled_at?.toISOString() ?? null,
        providerPayoutId: payment.provider_payout_id ?? null,
        failureReason: payment.failure_reason ?? null,
        paidAt: payment.paid_at?.toISOString() ?? null,
        createdAt: payment.created_at.toISOString(),
      },
      settlement: settlement[0]
        ? {
            id: settlement[0].id,
            status: settlement[0].status,
            splitStatus: payment.settlement_status,
            paidAt: settlement[0].paid_at
              ? new Date(settlement[0].paid_at).toISOString()
              : null,
            grossAmount: round2(n(settlement[0].gross_amount)),
            feeAmount: round2(n(settlement[0].fee_amount)),
            netAmount: round2(n(settlement[0].net_amount)),
            currency: settlement[0].currency,
          }
        : { splitStatus: payment.settlement_status },
      refunds: refunds.map((r) => ({
        id: r.id,
        amount: round2(n(r.amount)),
        status: r.status,
        reason: r.reason ?? null,
        gatewayRefundId: r.gateway_refund_id ?? null,
        createdAt: r.created_at.toISOString(),
      })),
      exceptions: (exceptions as Record<string, unknown>[]).map((e) => ({
        id: e.id as string,
        kind: e.kind as string,
        status: e.status as string,
        occurrences: n(e.occurrences),
        firstSeenAt: new Date(e.first_seen_at as string).toISOString(),
        lastSeenAt: new Date(e.last_seen_at as string).toISOString(),
      })),
      webhooks: events.map((e) => ({
        id: e.id,
        type: e.type,
        status: e.status,
        gatewayTransactionId: e.gateway_transaction_id ?? null,
        payload: e.raw_response ?? null,
        receivedAt: e.created_at.toISOString(),
      })),
      timeline: this.buildTimeline(payment, events),
    };
  }

  /** Derives the marketplace lifecycle timeline from persisted facts. */
  private buildTimeline(payment: Payment, events: Transaction[]) {
    const steps: { key: string; label: string; at: string | null; done: boolean }[] = [];
    const firstOf = (pred: (e: Transaction) => boolean) =>
      events.find(pred)?.created_at?.toISOString() ?? null;

    const charge = firstOf((e) => e.type === 'charge');
    const verify = firstOf((e) => e.type === 'verify');
    const webhook = firstOf((e) => e.type === 'webhook');
    const paid = payment.paid_at?.toISOString() ?? null;

    steps.push({ key: 'created', label: 'Payment Created', at: payment.created_at.toISOString(), done: true });
    steps.push({ key: 'charge', label: 'Payment Started', at: charge ?? verify, done: !!(charge || verify) });
    steps.push({ key: 'completed', label: 'Payment Completed', at: paid, done: !!paid });
    steps.push({ key: 'webhook', label: 'Webhook Received', at: webhook, done: !!webhook });
    steps.push({
      key: 'split',
      label: 'Split / In Settlement Batch',
      at: null,
      done: payment.settlement_status === 'IN_BATCH' || payment.settlement_status === 'SETTLED',
    });
    steps.push({
      key: 'payout',
      label: 'Payout Completed',
      at: null,
      done: payment.settlement_status === 'SETTLED',
    });
    return steps;
  }

  // ─────────────────────────────── KPIs ────────────────────────────────── //

  async kpis() {
    // Four independent domains (payments, subscriptions, subscription-plan MRR,
    // tenants) — none depends on another's result, so they run concurrently
    // instead of as four sequential round-trips (PERF-BE-005).
    const [[r], [subs], [mrrRow], [clinics], currencyRows, platformRows, revenueRows] = await Promise.all([
      // Payment-derived metrics — single pass over the money-kept set (no per-card query).
      // FIN-X3: a part-refunded payment still earned money, and every revenue figure is
      // what is left AFTER its refunds (`net_paid`), not the amount first charged.
      this.dataSource.query(`
      WITH paid AS (
        SELECT *, amount - COALESCE(refunded_amount, 0) AS net_paid
          FROM payments
         WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND purpose = ANY($1)
      )
      SELECT
        COALESCE((SELECT SUM(net_paid) FROM paid WHERE paid_at >= date_trunc('day', now())), 0) AS today_revenue,
        COALESCE((SELECT COUNT(*) FROM paid WHERE paid_at >= date_trunc('day', now())), 0) AS today_transactions,
        COALESCE((SELECT SUM(net_paid) FROM paid WHERE paid_at >= date_trunc('month', now())), 0) AS month_revenue,
        COALESCE((SELECT SUM(platform_fee) FROM paid), 0) AS platform_fee_total,
        COALESCE((SELECT SUM(gateway_fee) FROM paid), 0) AS gateway_fee_total,
        COALESCE((SELECT SUM(net_paid - gateway_fee) FROM paid), 0) AS net_of_gateway_total,
        COALESCE((SELECT SUM(COALESCE(net_amount, amount)) FROM paid WHERE settlement_status = 'UNSETTLED'), 0) AS waiting_split,
        COALESCE((SELECT SUM(net_amount) FROM settlements WHERE status IN ('PENDING','PROCESSING')), 0) AS waiting_payout,
        COALESCE((SELECT SUM(net_amount) FROM settlements WHERE status = 'PAID'), 0) AS completed_payouts,
        COALESCE((SELECT COUNT(*) FROM settlements WHERE status IN ('PENDING','PROCESSING')), 0) AS pending_settlements,
        COALESCE((SELECT COUNT(*) FROM payments WHERE status = 'FAILED' AND purpose = ANY($1)), 0) AS failed_payments,
        COALESCE((SELECT SUM(rf.amount) FROM refunds rf JOIN payments rp ON rp.id = rf."paymentId" WHERE rf.status = 'SUCCEEDED' AND rp.purpose = ANY($1)), 0) AS refunds_total,
        COALESCE((SELECT AVG(amount) FROM paid), 0) AS avg_booking_value,
        COALESCE((SELECT COUNT(DISTINCT "tenantId") FROM paid), 0) AS clinic_count,
        COALESCE((SELECT SUM(COALESCE(net_amount, amount) - COALESCE(refunded_amount, 0)) FROM paid), 0) AS net_total
    `, [[...CLINIC_REVENUE_PURPOSES]]),
      // Subscription metrics (distinct domain — not a payment calculation).
      this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'ACTIVE' AND ends_at > now())::int AS active_subs,
        COUNT(*) FILTER (WHERE ends_at < now() OR status IN ('CANCELLED','SUSPENDED'))::int AS expired_subs
      FROM subscriptions WHERE deleted_at IS NULL
    `),
      this.dataSource.query(`
      SELECT COALESCE(SUM(
        CASE sp.billing_cycle WHEN 'MONTHLY' THEN sp.price WHEN 'YEARLY' THEN sp.price / 12 ELSE 0 END
      ), 0) AS mrr
      FROM subscriptions s JOIN subscription_plans sp ON sp.id = s."planId"
      WHERE s.status = 'ACTIVE' AND s.ends_at > now() AND s.deleted_at IS NULL
    `),
      this.dataSource.query(`SELECT COUNT(*)::int AS total FROM tenants WHERE deleted_at IS NULL`),
      // Which currencies the figures above actually mix. Every money aggregate
      // in this method SUMs across `payments` WITHOUT grouping by currency — so
      // the moment a second currency exists, `todayRevenue` and friends become a
      // meaningless addition of unlike units. Reporting the set makes that
      // visible to the caller instead of leaving it to be discovered later; the
      // sums themselves are unchanged (additive field, no contract break).
      this.dataSource.query(
        `SELECT DISTINCT currency FROM payments WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND purpose = ANY($1) AND currency IS NOT NULL ORDER BY currency`,
        [[...CLINIC_REVENUE_PURPOSES]],
      ),
      // What the platform itself collected, per currency (never summed across currencies).
      this.platformRevenueByCurrency(),
      // FIN-X3: the same revenue figures, one row per currency, so a deployment with
      // more than one currency has a number it can actually show.
      this.dataSource.query(
        `SELECT currency,
                COALESCE(SUM(amount - COALESCE(refunded_amount, 0)) FILTER (WHERE paid_at >= date_trunc('day', now())), 0) AS today_revenue,
                COALESCE(SUM(amount - COALESCE(refunded_amount, 0)) FILTER (WHERE paid_at >= date_trunc('month', now())), 0) AS month_revenue,
                COALESCE(SUM(gateway_fee), 0) AS gateway_fees,
                COALESCE(SUM(platform_fee), 0) AS platform_fees
           FROM payments
          WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND purpose = ANY($1) AND currency IS NOT NULL
          GROUP BY currency ORDER BY currency`,
        [[...CLINIC_REVENUE_PURPOSES]],
      ),
    ]);

    const clinicCount = n(r.clinic_count);
    return {
      // Revenue
      todayRevenue: round2(n(r.today_revenue)),
      monthlyRevenue: round2(n(r.month_revenue)),
      platformRevenue: round2(n(r.platform_fee_total)),
      clinicRevenue: round2(n(r.net_total)),
      netRevenue: round2(n(r.net_of_gateway_total)),
      // Fees
      gatewayFees: round2(n(r.gateway_fee_total)),
      platformFees: round2(n(r.platform_fee_total)),
      // Transactions
      todayTransactions: n(r.today_transactions),
      failedPayments: n(r.failed_payments),
      refunds: round2(n(r.refunds_total)),
      // Split & settlement
      moneyWaitingSplit: round2(n(r.waiting_split)),
      moneyWaitingPayout: round2(n(r.waiting_payout)),
      completedPayouts: round2(n(r.completed_payouts)),
      pendingSettlements: n(r.pending_settlements),
      // Subscription
      activeSubscriptions: n(subs.active_subs),
      expiredSubscriptions: n(subs.expired_subs),
      monthlyRecurringRevenue: round2(n(mrrRow.mrr)),
      // Clinics
      totalClinics: n(clinics.total),
      averageClinicRevenue: clinicCount ? round2(n(r.net_total) / clinicCount) : 0,
      // Booking
      averageBookingValue: round2(n(r.avg_booking_value)),
      /**
       * Currencies represented in the PAID set the money figures above were
       * summed over. One entry (or none) means every amount is comparable; more
       * than one means these totals add unlike units and must not be rendered
       * with a single currency symbol.
       */
      currencies: (currencyRows as { currency: string }[]).map((c) => c.currency),
      /** The revenue / fee figures above, split by currency (use these when `currencies` has more than one). */
      revenueByCurrency: (revenueRows as Record<string, unknown>[]).map((c) => ({
        currency: c.currency as string,
        todayRevenue: round2(n(c.today_revenue)),
        monthlyRevenue: round2(n(c.month_revenue)),
        gatewayFees: round2(n(c.gateway_fees)),
        platformFees: round2(n(c.platform_fees)),
      })),
      /**
       * What ZiyaraTech itself collected — NOT clinic money, so none of the figures above
       * include it: paid subscription invoices and the clinics' add-on / billing-upgrade
       * payments, net of refunds, one entry per currency.
       */
      collectedRevenue: platformRows,
    };
  }

  /** Paid subscription invoices + add-on / billing-upgrade payments, net of refunds, by currency. */
  private async platformRevenueByCurrency(): Promise<PlatformRevenueRow[]> {
    const [invoices, payments] = await Promise.all([
      this.dataSource.query(
        `SELECT currency, SUM(amount) AS amount
           FROM subscription_invoices WHERE status = 'PAID' GROUP BY currency`,
      ),
      this.dataSource.query(
        `SELECT currency, SUM(amount - COALESCE(refunded_amount, 0)) AS amount
           FROM payments
          WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND purpose = ANY($1)
          GROUP BY currency`,
        [[...PLATFORM_REVENUE_PURPOSES]],
      ),
    ]);
    const byCurrency = new Map<string, PlatformRevenueRow>();
    const row = (currency: string) => {
      let r = byCurrency.get(currency);
      if (!r) {
        r = { currency, subscriptions: 0, addOns: 0, total: 0 };
        byCurrency.set(currency, r);
      }
      return r;
    };
    for (const i of invoices as Record<string, unknown>[]) {
      row(i.currency as string).subscriptions = round2(n(i.amount));
    }
    for (const p of payments as Record<string, unknown>[]) {
      row(p.currency as string).addOns = round2(n(p.amount));
    }
    return [...byCurrency.values()]
      .map((r) => ({ ...r, total: round2(r.subscriptions + r.addOns) }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }

  // ─────────────────────── KPI drill-down (single path) ────────────────── //

  /**
   * Rich drill-down for any dashboard KPI. Resolves the metric from the registry
   * and reuses the SAME base()/applyFilters()/listTransactions() machinery — one
   * aggregation path, no duplicated SQL. Payment metrics return
   * totals/statistics/charts/breakdowns/transactions; settlement/subscription/
   * clinic metrics return their domain summary + rows.
   */
  async metricDrilldown(metric: string, q: QueryMarketplaceTransactionsDto) {
    const def = FINANCE_METRICS[metric];
    if (!def) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: `Unknown metric "${metric}"` });
    }
    if (def.kind === 'payments') return this.paymentsDrilldown(metric, def, q);
    if (def.kind === 'settlements') return this.settlementsDrilldown(metric, def, q);
    if (def.kind === 'subscriptions') return this.subscriptionsDrilldown(metric, def, q);
    return this.clinicsDrilldown(metric, def, q);
  }

  /** Merge a metric's base filter into the user query; return the query + extras. */
  private applyBase(def: MetricDef, q: QueryMarketplaceTransactionsDto) {
    const merged: QueryMarketplaceTransactionsDto = { ...q };
    // The marketplace metrics are about what patients paid clinics; the platform's own
    // revenue (add-ons, billing upgrades) is reported separately in `collectedRevenue`.
    if (!merged.purpose) merged.purpose = 'CLINIC_MONEY';
    if (def.base?.status && !merged.status) merged.status = def.base.status;
    if (def.base?.settlementStatus && !merged.settlementStatus) {
      merged.settlementStatus = def.base.settlementStatus;
    }
    if (def.base?.period && !merged.paidFrom) {
      const now = new Date();
      const start =
        def.base.period === 'today'
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
          : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      merged.paidFrom = start.toISOString();
    }
    const extend = def.base?.refunded
      ? (qb: SelectQueryBuilder<Payment>) => qb.andWhere('p.refunded_amount > 0')
      : undefined;
    return { merged, extend };
  }

  private fq(
    merged: QueryMarketplaceTransactionsDto,
    extend?: (qb: SelectQueryBuilder<Payment>) => void,
  ): SelectQueryBuilder<Payment> {
    const qb = this.base();
    this.applyFilters(qb, merged);
    extend?.(qb);
    return qb;
  }

  private mapPoint = (r: Record<string, unknown>): TrendPoint => ({
    label: (r.label as string) ?? '—',
    value: round2(n(r.value)),
    count: n(r.count),
  });

  private async trend(
    merged: QueryMarketplaceTransactionsDto,
    extend: ((qb: SelectQueryBuilder<Payment>) => void) | undefined,
    measureExpr: string,
    unit: 'day' | 'month',
  ): Promise<TrendPoint[]> {
    const fmt = unit === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
    const bucket = `to_char(date_trunc('${unit}', COALESCE(p.paid_at, p.created_at)), '${fmt}')`;
    const rows = await this.fq(merged, extend)
      .select([`${bucket} AS label`, `COALESCE(${measureExpr},0) AS value`, 'COUNT(DISTINCT p.id) AS count'])
      .groupBy(bucket)
      .orderBy(bucket, 'ASC')
      .limit(180)
      .getRawMany();
    return rows.map(this.mapPoint);
  }

  private async breakdown(
    merged: QueryMarketplaceTransactionsDto,
    extend: ((qb: SelectQueryBuilder<Payment>) => void) | undefined,
    measureExpr: string,
    group: { by: string; key: string; label: string },
  ): Promise<BreakdownRow[]> {
    const rows = await this.fq(merged, extend)
      .select([
        `${group.key} AS key`,
        `${group.label} AS label`,
        `COALESCE(${measureExpr},0) AS value`,
        'COALESCE(SUM(p.amount),0) AS gross',
        'COUNT(DISTINCT p.id) AS count',
      ])
      .groupBy(group.by)
      .orderBy('value', 'DESC')
      .limit(50)
      .getRawMany();
    return rows.map((r) => ({
      key: (r.key as string) ?? null,
      label: (r.label as string) ?? null,
      value: round2(n(r.value)),
      gross: round2(n(r.gross)),
      count: n(r.count),
    }));
  }

  /** Revenue-by-service uses the service line price (not the payment amount). */
  private async serviceBreakdown(
    merged: QueryMarketplaceTransactionsDto,
    extend?: (qb: SelectQueryBuilder<Payment>) => void,
  ): Promise<BreakdownRow[]> {
    const qb = this.fq(merged, extend)
      .leftJoin('appointment_services', 'aps', 'aps."appointmentId" = p."appointmentId"')
      .leftJoin('services', 's', 's.id = aps."serviceId"');
    const rows = await qb
      .select([
        's.id AS key',
        's.name AS label',
        'COALESCE(SUM(aps.price),0) AS value',
        'COALESCE(SUM(aps.price),0) AS gross',
        'COUNT(DISTINCT p.id) AS count',
      ])
      .andWhere('s.id IS NOT NULL')
      .groupBy('s.id')
      .addGroupBy('s.name')
      .orderBy('value', 'DESC')
      .limit(50)
      .getRawMany();
    return rows.map((r) => ({
      key: (r.key as string) ?? null,
      label: (r.label as string) ?? null,
      value: round2(n(r.value)),
      gross: round2(n(r.gross)),
      count: n(r.count),
    }));
  }

  private async paymentsDrilldown(
    metric: string,
    def: MetricDef,
    q: QueryMarketplaceTransactionsDto,
  ) {
    const { merged, extend } = this.applyBase(def, q);
    const measureExpr = MEASURE_SQL[def.measure ?? 'gross'];

    const totals = await this.fq(merged, extend)
      .select([
        'COALESCE(SUM(p.amount),0) AS gross',
        'COALESCE(SUM(p.gateway_fee),0) AS gateway_fee',
        'COALESCE(SUM(p.platform_fee),0) AS platform_fee',
        'COALESCE(SUM(COALESCE(p.net_amount,p.amount)),0) AS net',
        'COALESCE(SUM(p.refunded_amount),0) AS refunded',
        'COUNT(DISTINCT p.id) AS cnt',
        'COALESCE(AVG(p.amount),0) AS avg',
        'COALESCE(MIN(p.amount),0) AS min',
        'COALESCE(MAX(p.amount),0) AS max',
        `COALESCE(${measureExpr},0) AS measure`,
      ])
      .getRawOne<Record<string, unknown>>();

    const [daily, monthly, byStatus, byClinic, byBranch, byGateway, byMethod, byService, transactions] =
      await Promise.all([
        this.trend(merged, extend, measureExpr, 'day'),
        this.trend(merged, extend, measureExpr, 'month'),
        this.fq(merged, extend)
          .select(['p.status AS label', `COALESCE(${measureExpr},0) AS value`, 'COUNT(DISTINCT p.id) AS count'])
          .groupBy('p.status').getRawMany().then((rs) => rs.map(this.mapPoint)),
        this.breakdown(merged, extend, measureExpr, { by: 't.id, t.name', key: 't.id', label: 't.name' }),
        this.breakdown(merged, extend, measureExpr, { by: 'b.id, b.name', key: 'b.id', label: 'b.name' }),
        this.breakdown(merged, extend, measureExpr, { by: 'p.gateway', key: 'p.gateway', label: 'p.gateway' }),
        this.breakdown(merged, extend, measureExpr, { by: 'p.payment_method', key: 'p.payment_method', label: 'p.payment_method' }),
        this.serviceBreakdown(merged, extend),
        this.listTransactions(merged, extend),
      ]);

    return {
      metric,
      label: def.label,
      kind: 'payments' as const,
      summary: {
        primary: round2(n(totals?.measure)),
        primaryLabel: def.label,
        count: n(totals?.cnt),
      },
      totals: {
        gross: round2(n(totals?.gross)),
        gatewayFee: round2(n(totals?.gateway_fee)),
        platformFee: round2(n(totals?.platform_fee)),
        net: round2(n(totals?.net)),
        refunded: round2(n(totals?.refunded)),
        count: n(totals?.cnt),
      },
      statistics: {
        average: round2(n(totals?.avg)),
        min: round2(n(totals?.min)),
        max: round2(n(totals?.max)),
      },
      charts: { daily, monthly, byStatus },
      breakdowns: { byClinic, byBranch, byGateway, byMethod, byService },
      transactions,
      appliedFilters: { ...merged, refundedOnly: !!def.base?.refunded },
    };
  }

  private async settlementsDrilldown(
    metric: string,
    def: MetricDef,
    q: QueryMarketplaceTransactionsDto,
  ) {
    const statuses = def.settlementStatuses ?? [];
    const params: unknown[] = [statuses];
    const where: string[] = [`st.status = ANY($1)`];
    if (q.tenantId) { params.push(q.tenantId); where.push(`st."tenantId" = $${params.length}`); }
    if (q.settlementFrom) { params.push(new Date(q.settlementFrom)); where.push(`st.paid_at >= $${params.length}`); }
    if (q.settlementTo) { params.push(new Date(q.settlementTo)); where.push(`st.paid_at <= $${params.length}`); }
    const whereSql = where.join(' AND ');

    const [summary] = await this.dataSource.query(
      `SELECT COALESCE(SUM(st.net_amount),0) AS net, COALESCE(SUM(st.gross_amount),0) AS gross,
              COALESCE(SUM(st.fee_amount),0) AS fee, COUNT(*)::int AS count
         FROM settlements st WHERE ${whereSql}`, params);
    const byStatus = await this.dataSource.query(
      `SELECT st.status AS label, COALESCE(SUM(st.net_amount),0) AS value, COUNT(*)::int AS count
         FROM settlements st WHERE ${whereSql} GROUP BY st.status`, params);
    const monthly = await this.dataSource.query(
      `SELECT to_char(date_trunc('month', COALESCE(st.paid_at, st.created_at)),'YYYY-MM') AS label,
              COALESCE(SUM(st.net_amount),0) AS value, COUNT(*)::int AS count
         FROM settlements st WHERE ${whereSql} GROUP BY 1 ORDER BY 1 LIMIT 24`, params);

    const limit = Math.min(q.limit ?? 20, 100);
    const offset = ((q.page ?? 1) - 1) * limit;
    const rows = await this.dataSource.query(
      `SELECT st.id, t.name AS clinic_name, st.status, st.gross_amount, st.fee_amount, st.net_amount,
              st.currency, st.paid_at, st.created_at, st.period_start, st.period_end
         FROM settlements st LEFT JOIN tenants t ON t.id = st."tenantId"
        WHERE ${whereSql} ORDER BY st.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);

    return {
      metric, label: def.label, kind: 'settlements' as const,
      summary: { primary: round2(n(summary.net)), primaryLabel: def.label, count: n(summary.count) },
      totals: { net: round2(n(summary.net)), gross: round2(n(summary.gross)), fee: round2(n(summary.fee)), count: n(summary.count) },
      charts: { monthly: monthly.map(this.mapPoint), byStatus: byStatus.map(this.mapPoint) },
      rows: { data: rows.map((r: Record<string, unknown>) => ({
        id: r.id, clinicName: r.clinic_name ?? null, status: r.status,
        grossAmount: round2(n(r.gross_amount)), feeAmount: round2(n(r.fee_amount)), netAmount: round2(n(r.net_amount)),
        currency: r.currency, paidAt: r.paid_at ? new Date(r.paid_at as string).toISOString() : null,
        createdAt: new Date(r.created_at as string).toISOString(),
        periodStart: r.period_start, periodEnd: r.period_end,
      })), total: n(summary.count), page: q.page ?? 1, limit },
      appliedFilters: { tenantId: q.tenantId, settlementStatuses: statuses },
    };
  }

  private async subscriptionsDrilldown(
    metric: string,
    def: MetricDef,
    q: QueryMarketplaceTransactionsDto,
  ) {
    const scope = def.subscriptionScope ?? 'active';
    const cond =
      scope === 'active'
        ? `s.status = 'ACTIVE' AND s.ends_at > now()`
        : `(s.ends_at < now() OR s.status IN ('CANCELLED','SUSPENDED'))`;
    const tail = `s.deleted_at IS NULL AND ${cond}${q.tenantId ? ` AND s."tenantId" = $1` : ''}`;
    const params = q.tenantId ? [q.tenantId] : [];

    const [summary] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(CASE sp.billing_cycle WHEN 'MONTHLY' THEN sp.price WHEN 'YEARLY' THEN sp.price/12 ELSE 0 END),0) AS mrr
         FROM subscriptions s JOIN subscription_plans sp ON sp.id = s."planId" WHERE ${tail}`, params);
    const byStatus = await this.dataSource.query(
      `SELECT s.status AS label, COUNT(*)::int AS value, COUNT(*)::int AS count
         FROM subscriptions s WHERE s.deleted_at IS NULL${q.tenantId ? ` AND s."tenantId" = $1` : ''} GROUP BY s.status`, params);

    const limit = Math.min(q.limit ?? 20, 100);
    const offset = ((q.page ?? 1) - 1) * limit;
    const rows = await this.dataSource.query(
      `SELECT s.id, t.name AS clinic_name, sp.name AS plan_name, sp.price, sp.billing_cycle,
              s.status, s.starts_at, s.ends_at
         FROM subscriptions s
         LEFT JOIN tenants t ON t.id = s."tenantId"
         JOIN subscription_plans sp ON sp.id = s."planId"
        WHERE ${tail} ORDER BY s.ends_at DESC LIMIT ${limit} OFFSET ${offset}`, params);

    const isMrr = metric === 'monthlyRecurringRevenue';
    return {
      metric, label: def.label, kind: 'subscriptions' as const,
      summary: {
        primary: isMrr ? round2(n(summary.mrr)) : n(summary.count),
        primaryLabel: def.label, count: n(summary.count),
        extra: { mrr: round2(n(summary.mrr)) },
      },
      charts: { byStatus: byStatus.map(this.mapPoint) },
      rows: { data: rows.map((r: Record<string, unknown>) => ({
        id: r.id, clinicName: r.clinic_name ?? null, planName: r.plan_name,
        price: round2(n(r.price)), billingCycle: r.billing_cycle, status: r.status,
        startsAt: new Date(r.starts_at as string).toISOString(),
        endsAt: new Date(r.ends_at as string).toISOString(),
      })), total: n(summary.count), page: q.page ?? 1, limit },
      appliedFilters: { tenantId: q.tenantId, scope },
    };
  }

  private async clinicsDrilldown(
    metric: string,
    def: MetricDef,
    q: QueryMarketplaceTransactionsDto,
  ) {
    // Revenue-by-clinic over PAID payments (reuses the payments aggregation path).
    const merged: QueryMarketplaceTransactionsDto = {
      ...q,
      status: q.status ?? 'PAID',
      purpose: q.purpose ?? 'CLINIC_MONEY',
    };
    const byClinic = await this.breakdown(merged, undefined, MEASURE_SQL.net, {
      by: 't.id, t.name', key: 't.id', label: 't.name',
    });
    const [tot] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM tenants WHERE deleted_at IS NULL`);
    const totalClinics = n(tot.total);
    const revenueSum = byClinic.reduce((s, r) => s + r.value, 0);

    return {
      metric, label: def.label, kind: 'clinics' as const,
      summary: {
        primary: metric === 'averageClinicRevenue'
          ? (byClinic.length ? round2(revenueSum / byClinic.length) : 0)
          : totalClinics,
        primaryLabel: def.label,
        count: totalClinics,
      },
      charts: { byClinic: byClinic.slice(0, 12).map((r) => ({ label: r.label ?? '—', value: r.value, count: r.count })) },
      breakdowns: { byClinic },
      appliedFilters: { status: merged.status },
    };
  }

  // ─────────────────────── Per-clinic financial summary ─────────────────── //

  async clinicSummary(tenantId: string) {
    const tenant = await this.dataSource.query(
      `SELECT id, name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (!tenant[0]) {
      throw new AppError(ErrorCode.TENANT_NOT_FOUND);
    }

    const [t] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED')), 0) AS total_revenue,
         COALESCE(SUM(COALESCE(net_amount, amount)) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED')), 0) AS net_revenue,
         COALESCE(SUM(gateway_fee) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED')), 0) AS gateway_fees,
         COALESCE(SUM(platform_fee) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED')), 0) AS platform_fees,
         COALESCE(SUM(refunded_amount), 0) AS refunds,
         COALESCE(COUNT(*) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED')), 0) AS successful_payments,
         COALESCE(COUNT(*) FILTER (WHERE status = 'FAILED'), 0) AS failed_payments,
         COALESCE(AVG(amount) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED')), 0) AS avg_booking,
         COALESCE(MAX(amount) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED')), 0) AS highest_booking,
         COALESCE(MIN(amount) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED')), 0) AS lowest_booking,
         COALESCE(SUM(amount) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= date_trunc('month', now())), 0) AS this_month,
         COALESCE(SUM(amount) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= date_trunc('month', now()) - interval '1 month' AND paid_at < date_trunc('month', now())), 0) AS last_month
       FROM payments WHERE "tenantId" = $1 AND purpose = ANY($2)`,
      [tenantId, [...CLINIC_REVENUE_PURPOSES]],
    );

    // PAY-005: revenue figures above are in one currency each; report the set so the UI
    // never stamps one symbol on a mixed total.
    const currencies: Array<{ currency: string }> = await this.dataSource.query(
      `SELECT DISTINCT currency FROM payments
        WHERE "tenantId" = $1 AND purpose = ANY($2) AND currency IS NOT NULL
          AND status IN ('PAID', 'PARTIALLY_REFUNDED') ORDER BY currency`,
      [tenantId, [...CLINIC_REVENUE_PURPOSES]],
    );

    const daily = await this.dataSource.query(
      `SELECT to_char(date_trunc('day', paid_at), 'YYYY-MM-DD') AS day,
              COALESCE(SUM(amount), 0) AS revenue, COUNT(*) AS count
         FROM payments
        WHERE "tenantId" = $1 AND purpose = ANY($2) AND status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
      [tenantId, [...CLINIC_REVENUE_PURPOSES]],
    );
    const monthly = await this.dataSource.query(
      `SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month,
              COALESCE(SUM(amount), 0) AS revenue, COUNT(*) AS count
         FROM payments
        WHERE "tenantId" = $1 AND purpose = ANY($2) AND status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= now() - interval '12 months'
        GROUP BY 1 ORDER BY 1`,
      [tenantId, [...CLINIC_REVENUE_PURPOSES]],
    );

    const thisMonth = n(t.this_month);
    const lastMonth = n(t.last_month);
    const growth = lastMonth > 0 ? round2(((thisMonth - lastMonth) / lastMonth) * 100) : null;

    return {
      tenant: { id: tenant[0].id, name: tenant[0].name },
      totals: {
        totalRevenue: round2(n(t.total_revenue)),
        netRevenue: round2(n(t.net_revenue)),
        gatewayFees: round2(n(t.gateway_fees)),
        platformFees: round2(n(t.platform_fees)),
        refunds: round2(n(t.refunds)),
        successfulPayments: n(t.successful_payments),
        failedPayments: n(t.failed_payments),
        currencies: currencies.map((x) => x.currency),
        averageBooking: round2(n(t.avg_booking)),
        highestBooking: round2(n(t.highest_booking)),
        lowestBooking: round2(n(t.lowest_booking)),
        revenueGrowthPercent: growth,
      },
      daily: daily.map((d: Record<string, unknown>) => ({
        day: d.day as string,
        revenue: round2(n(d.revenue)),
        count: n(d.count),
      })),
      monthly: monthly.map((m: Record<string, unknown>) => ({
        month: m.month as string,
        revenue: round2(n(m.revenue)),
        count: n(m.count),
      })),
    };
  }

  // ─────────────────────────────── Export ──────────────────────────────── //

  /** Builds a CSV (Excel-native) of the filtered result set, capped for safety. */
  async exportCsv(q: QueryMarketplaceTransactionsDto): Promise<{ filename: string; content: string }> {
    const rows = await this.listTransactions({ ...q, page: 1, limit: 5000 });
    const headers = [
      'Transaction', 'Booking', 'Clinic', 'Branch', 'Patient', 'Service',
      'Gateway', 'Method', 'Gross', 'Gateway Fee', 'Platform Fee', 'Net',
      'Currency', 'Payment Status', 'Split Status', 'Payout Status',
      'Refund Status', 'Settlement Date', 'Paid At', 'Created At',
      'Purpose', 'Settlement Mode', 'Fee Status', 'Provider Payout',
      'Provider Charge', 'Open Exceptions',
    ];
    const esc = (v: unknown): string => {
      // SEC-05: patient/clinic names are user-controlled — neutralise formulas.
      // Only string values are escaped, so numeric amounts stay numeric.
      const s = v == null ? '' : String(escapeSpreadsheetCell(v));
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.data.map((r) =>
      [
        r.id, r.bookingId, r.clinicName, r.branchName, r.patientName, r.serviceName,
        r.gateway, r.paymentMethod, r.grossAmount, r.gatewayFee, r.platformFee, r.netAmount,
        r.currency, r.paymentStatus, r.splitStatus, r.payoutStatus, r.refundStatus,
        r.settlementDate, r.paidAt, r.createdAt,
        r.purpose, r.settlementMode, r.feeStatus, r.providerPayoutId,
        r.gatewayPaymentId, r.openExceptions,
      ].map(esc).join(','),
    );
    const content = [headers.join(','), ...lines].join('\n');
    return {
      filename: `marketplace-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
      content,
    };
  }
}
