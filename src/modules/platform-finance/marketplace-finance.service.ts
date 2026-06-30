import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Transaction } from '../../entities/Payments/Transaction';
import { Refund } from '../../entities/Payments/Refund';
import { AppError, ErrorCode } from '../../common/errors';
import { round2 } from '../payments/payments.constants';
import { QueryMarketplaceTransactionsDto } from './dto/query-marketplace-transactions.dto';

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
}

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

  async listTransactions(q: QueryMarketplaceTransactionsDto): Promise<{
    data: MarketplaceTransactionRow[];
    total: number;
    page: number;
    limit: number;
  }> {
    const countQb = this.base();
    this.applyFilters(countQb, q);
    const totalRow = await countQb
      .select('COUNT(DISTINCT p.id)', 'cnt')
      .getRawOne<{ cnt: string }>();
    const total = n(totalRow?.cnt);

    const dataQb = this.base();
    this.applyFilters(dataQb, q);
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
    };
  }

  // ───────────────────────────── Detail ────────────────────────────────── //

  async getTransaction(id: string) {
    const payment = await this.payments.findOne({
      where: { id },
      relations: { tenant: true, branch: true, customer: true, appointment: true },
    });
    if (!payment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Transaction not found' });
    }

    const events = await this.transactions.find({
      where: { payment: { id } },
      order: { created_at: 'ASC' },
    });
    const refunds = await this.refunds.find({
      where: { payment: { id } },
      order: { created_at: 'ASC' },
    });
    const settlement = await this.dataSource.query(
      `SELECT st.id, st.status, st.paid_at, st.period_start, st.period_end,
              st.gross_amount, st.fee_amount, st.net_amount, st.currency
         FROM settlement_items si JOIN settlements st ON st.id = si.settlement_id
        WHERE si.payment_id = $1 LIMIT 1`,
      [id],
    );
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
        createdAt: r.created_at.toISOString(),
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
    const [r] = await this.dataSource.query(`
      WITH paid AS (SELECT * FROM payments WHERE status = 'PAID')
      SELECT
        COALESCE((SELECT SUM(amount) FROM paid WHERE paid_at >= date_trunc('day', now())), 0) AS today_revenue,
        COALESCE((SELECT COUNT(*) FROM paid WHERE paid_at >= date_trunc('day', now())), 0) AS today_transactions,
        COALESCE((SELECT SUM(amount) FROM paid WHERE paid_at >= date_trunc('month', now())), 0) AS month_revenue,
        COALESCE((SELECT SUM(COALESCE(net_amount, amount)) FROM payments WHERE status = 'PAID' AND settlement_status = 'UNSETTLED'), 0) AS waiting_split,
        COALESCE((SELECT SUM(net_amount) FROM settlements WHERE status IN ('PENDING','PROCESSING')), 0) AS waiting_payout,
        COALESCE((SELECT SUM(net_amount) FROM settlements WHERE status = 'PAID'), 0) AS completed_payouts,
        COALESCE((SELECT COUNT(*) FROM payments WHERE status = 'FAILED'), 0) AS failed_payments,
        COALESCE((SELECT SUM(amount) FROM refunds WHERE status = 'SUCCEEDED'), 0) AS refunds_total,
        COALESCE((SELECT AVG(amount) FROM paid), 0) AS avg_booking_value,
        COALESCE((SELECT COUNT(DISTINCT "tenantId") FROM paid), 0) AS clinic_count,
        COALESCE((SELECT SUM(COALESCE(net_amount, amount)) FROM paid), 0) AS net_total
    `);
    const clinicCount = n(r.clinic_count);
    return {
      todayRevenue: round2(n(r.today_revenue)),
      todayTransactions: n(r.today_transactions),
      monthlyRevenue: round2(n(r.month_revenue)),
      moneyWaitingSplit: round2(n(r.waiting_split)),
      moneyWaitingPayout: round2(n(r.waiting_payout)),
      completedPayouts: round2(n(r.completed_payouts)),
      failedPayments: n(r.failed_payments),
      refunds: round2(n(r.refunds_total)),
      averageBookingValue: round2(n(r.avg_booking_value)),
      averageClinicRevenue: clinicCount ? round2(n(r.net_total) / clinicCount) : 0,
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
         COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS total_revenue,
         COALESCE(SUM(COALESCE(net_amount, amount)) FILTER (WHERE status = 'PAID'), 0) AS net_revenue,
         COALESCE(SUM(gateway_fee) FILTER (WHERE status = 'PAID'), 0) AS gateway_fees,
         COALESCE(SUM(platform_fee) FILTER (WHERE status = 'PAID'), 0) AS platform_fees,
         COALESCE(SUM(refunded_amount), 0) AS refunds,
         COALESCE(COUNT(*) FILTER (WHERE status = 'PAID'), 0) AS successful_payments,
         COALESCE(COUNT(*) FILTER (WHERE status = 'FAILED'), 0) AS failed_payments,
         COALESCE(AVG(amount) FILTER (WHERE status = 'PAID'), 0) AS avg_booking,
         COALESCE(MAX(amount) FILTER (WHERE status = 'PAID'), 0) AS highest_booking,
         COALESCE(MIN(amount) FILTER (WHERE status = 'PAID'), 0) AS lowest_booking,
         COALESCE(SUM(amount) FILTER (WHERE status = 'PAID' AND paid_at >= date_trunc('month', now())), 0) AS this_month,
         COALESCE(SUM(amount) FILTER (WHERE status = 'PAID' AND paid_at >= date_trunc('month', now()) - interval '1 month' AND paid_at < date_trunc('month', now())), 0) AS last_month
       FROM payments WHERE "tenantId" = $1`,
      [tenantId],
    );

    const daily = await this.dataSource.query(
      `SELECT to_char(date_trunc('day', paid_at), 'YYYY-MM-DD') AS day,
              COALESCE(SUM(amount), 0) AS revenue, COUNT(*) AS count
         FROM payments
        WHERE "tenantId" = $1 AND status = 'PAID' AND paid_at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
      [tenantId],
    );
    const monthly = await this.dataSource.query(
      `SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month,
              COALESCE(SUM(amount), 0) AS revenue, COUNT(*) AS count
         FROM payments
        WHERE "tenantId" = $1 AND status = 'PAID' AND paid_at >= now() - interval '12 months'
        GROUP BY 1 ORDER BY 1`,
      [tenantId],
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
    ];
    const esc = (v: unknown): string => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.data.map((r) =>
      [
        r.id, r.bookingId, r.clinicName, r.branchName, r.patientName, r.serviceName,
        r.gateway, r.paymentMethod, r.grossAmount, r.gatewayFee, r.platformFee, r.netAmount,
        r.currency, r.paymentStatus, r.splitStatus, r.payoutStatus, r.refundStatus,
        r.settlementDate, r.paidAt, r.createdAt,
      ].map(esc).join(','),
    );
    const content = [headers.join(','), ...lines].join('\n');
    return {
      filename: `marketplace-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
      content,
    };
  }
}
