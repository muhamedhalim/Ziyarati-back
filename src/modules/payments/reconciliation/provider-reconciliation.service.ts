import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { MerchantAccount } from '../../../entities/Payments/MerchantAccount';
import { AppError, ErrorCode } from '../../../common/errors';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../../platform/platform-admin-audit.service';

import { PaymentsConfig } from '../payments.config';
import {
  CLINIC_REVENUE_PURPOSES,
  PLATFORM_REVENUE_PURPOSES,
  PROVIDER_RECONCILIATION,
  RECONCILIATION_KIND,
  SETTLEMENT_MODE,
} from '../payments.constants';
import { TapApiClient } from '../providers/tap/tap-api.client';
import {
  parseChargeReport,
  TapChargeReportRow,
  TapReportParseError,
} from '../providers/tap/tap-report.parser';
import type { TapPayout } from '../providers/tap/tap.types';
import { SettlementItemService } from '../settlement-item.service';
import {
  RaiseExceptionInput,
  ReconciliationExceptionService,
} from './reconciliation-exception.service';
import {
  checkCharge,
  evaluateFee,
  evaluatePayout,
  groupCapturedByReference,
  mapPayoutStatus,
  toCents,
} from './reconciliation-math';

const DAY_MS = 86_400_000;
const PROVIDER = 'tap';
const PAYMENT_PAID_LIKE = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const INVOICE_PAID_LIKE = new Set(['PAID', 'REFUNDED']);
const PAYOUT_ID = /^[A-Za-z0-9_-]{3,64}$/;

/** One Tap merchant the sweep reads reports for. */
export interface MerchantContext {
  /** `platform` = ZiyaraTech's own merchant; `clinic` = a clinic's; `import` = a manual report. */
  scope: 'platform' | 'clinic' | 'import';
  merchantId?: string;
  tenantId?: string;
}

export interface MerchantReconcileSummary {
  scope: MerchantContext['scope'];
  merchantId?: string;
  /** `ok` = the report answered; `unreachable` = Tap refused it for our credentials; `unavailable` = Tap did not answer (try again later). */
  reports: 'ok' | 'unreachable' | 'unavailable' | 'skipped';
  rows: number;
  skippedRows: number;
  matched: number;
  feesApplied: number;
  feesChanged: number;
  payoutLinks: number;
  payoutsMirrored: number;
  payoutsTruncated: boolean;
  /** Exceptions NEWLY raised or reopened by this run. */
  exceptions: number;
  error?: string;
}

export interface ProviderReconcileSummary {
  skipped?: string;
  windowFrom?: string;
  windowTo?: string;
  merchants: MerchantReconcileSummary[];
  exceptions: number;
}

interface ReportWindow {
  from: Date;
  to: Date;
}

type FetchedReport =
  | { ok: true; rows: TapChargeReportRow[]; skipped: number; complete: boolean }
  | {
      ok: false;
      transient: boolean;
      httpStatus: number;
      code?: string;
      parseError?: boolean;
    };

interface PaymentRow {
  id: string;
  tenant_id: string;
  amount: string;
  currency: string;
  status: string;
  gateway_payment_id: string;
  gateway_fee: string;
  platform_fee: string;
  fees_reconciled_at: Date | null;
  purpose: string;
  settlement_mode: string;
  refunded_amount: string;
  provider_payout_id: string | null;
  payment_method: string | null;
}

interface InvoiceRow {
  id: string;
  tenant_id: string;
  amount: string;
  currency: string;
  status: string;
  provider_reference: string | null;
  checkout_charge_id: string | null;
}

const emptySummary = (ctx: MerchantContext): MerchantReconcileSummary => ({
  scope: ctx.scope,
  merchantId: ctx.merchantId,
  reports: 'skipped',
  rows: 0,
  skippedRows: 0,
  matched: 0,
  feesApplied: 0,
  feesChanged: 0,
  payoutLinks: 0,
  payoutsMirrored: 0,
  payoutsTruncated: false,
  exceptions: 0,
});

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * Daily reconciliation against what the GATEWAY says (Tap).
 *
 * Webhooks, the return page and the 10-minute sweep keep our records right in
 * real time; this is the independent second opinion, run from Tap's own reports:
 *
 *  - FEES: Tap reports a charge's fee only in the charges report, never on the
 *    charge or its webhook. Each captured charge's fee + VAT is written to the
 *    payment once (`fees_reconciled_at` stamps it final); a fee that later
 *    CHANGES is raised, never overwritten.
 *  - PAYOUTS: the payouts Tap made to each clinic's merchant are mirrored as
 *    read-only `settlements` (source PROVIDER), linked to the payments they paid
 *    out, and checked against the net of those charges.
 *  - DISCREPANCIES — duplicate captures, amount / status mismatches, captures we do
 *    not know, payments the gateway does not report — are RECORDED for a human in
 *    `payment_reconciliation_exceptions`. Nothing here ever moves money.
 *
 * Tap documents that a sub-merchant reports with its OWN credentials, so whether
 * our platform key may read a clinic's report is a per-merchant FACT, recorded on
 * the merchant account and surfaced once — never an error per charge, and never
 * a reason to fail the other merchants. A merchant that cannot be read simply keeps
 * its provisional fees until its report is reachable or an operator imports it.
 */
@Injectable()
export class ProviderReconciliationService {
  private readonly logger = new Logger('ProviderReconciliationService');

  constructor(
    @InjectRepository(MerchantAccount)
    private readonly merchants: Repository<MerchantAccount>,
    private readonly dataSource: DataSource,
    private readonly client: TapApiClient,
    private readonly config: PaymentsConfig,
    private readonly exceptions: ReconciliationExceptionService,
    private readonly settlementItems: SettlementItemService,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  /** The sweep only exists while Tap is the configured provider and has a key. */
  get enabled(): boolean {
    return this.config.providerName === PROVIDER && this.client.isConfigured;
  }

  // ───────────────────────────────── the sweep ───────────────────────────────── //

  async run(opts: {
    lookbackDays: number;
    now?: Date;
  }): Promise<ProviderReconcileSummary> {
    if (!this.enabled) {
      return { skipped: 'tap_not_active', merchants: [], exceptions: 0 };
    }
    const to = opts.now ?? new Date();
    const days = Math.min(
      Math.max(Math.floor(opts.lookbackDays) || 1, 1),
      PROVIDER_RECONCILIATION.MAX_WINDOW_DAYS,
    );
    const window: ReportWindow = {
      from: new Date(to.getTime() - days * DAY_MS),
      to,
    };

    const summary: ProviderReconcileSummary = {
      windowFrom: window.from.toISOString(),
      windowTo: window.to.toISOString(),
      merchants: [],
      exceptions: 0,
    };
    for (const ctx of await this.merchantContexts()) {
      let result: MerchantReconcileSummary;
      try {
        result = await this.reconcileMerchant(ctx, window);
      } catch (err) {
        // One merchant's failure must never stop the others.
        this.logger.error(
          `Reconciliation failed for ${ctx.scope} merchant ${ctx.merchantId}: ${(err as Error).message}`,
        );
        result = { ...emptySummary(ctx), error: (err as Error).message };
      }
      summary.merchants.push(result);
      summary.exceptions += result.exceptions;
    }
    this.logger.warn(
      `provider reconcile (${days}d): merchants=${summary.merchants.length} exceptions=${summary.exceptions}`,
    );
    return summary;
  }

  /** ZiyaraTech's own merchant, then every clinic that has a Tap merchant id (whatever its status today). */
  private async merchantContexts(): Promise<MerchantContext[]> {
    const out: MerchantContext[] = [];
    if (this.config.tapMerchantId) {
      out.push({ scope: 'platform', merchantId: this.config.tapMerchantId });
    }
    const rows = await this.dataSource.query(
      `SELECT provider_recipient_id AS merchant_id, "tenantId" AS tenant_id
         FROM merchant_accounts
        WHERE provider = $1 AND provider_recipient_id IS NOT NULL
        ORDER BY created_at ASC`,
      [PROVIDER],
    );
    for (const r of rows as Array<{ merchant_id: string; tenant_id: string }>) {
      if (r.merchant_id === this.config.tapMerchantId) continue;
      out.push({
        scope: 'clinic',
        merchantId: r.merchant_id,
        tenantId: r.tenant_id,
      });
    }
    return out;
  }

  private async reconcileMerchant(
    ctx: MerchantContext,
    window: ReportWindow,
  ): Promise<MerchantReconcileSummary> {
    const summary = emptySummary(ctx);
    const report = await this.fetchReport(ctx.merchantId!, window);

    if (!report.ok) {
      if (report.transient) {
        // Tap did not answer: say nothing about this merchant, and try again next run.
        summary.reports = 'unavailable';
        return summary;
      }
      summary.reports = 'unreachable';
      await this.markReports(ctx, 'UNREACHABLE');
      await this.raise(summary, {
        kind: RECONCILIATION_KIND.REPORTS_UNREACHABLE,
        provider: PROVIDER,
        objectId: ctx.merchantId!,
        tenantId: ctx.tenantId,
        merchantId: ctx.merchantId,
        details: {
          scope: ctx.scope,
          reason: report.parseError ? 'unparsable_report' : 'rejected',
          httpStatus: report.httpStatus,
          code: report.code ?? null,
        },
      });
      return summary;
    }

    summary.reports = 'ok';
    await this.markReports(ctx, 'OK');
    await this.exceptions.autoResolve(
      RECONCILIATION_KIND.REPORTS_UNREACHABLE,
      ctx.merchantId!,
      'The merchant report is reachable again',
    );
    await this.applyReport(
      ctx,
      report.rows,
      report.skipped,
      { window, complete: report.complete },
      summary,
    );
    if (ctx.scope === 'clinic') {
      await this.importPayouts(ctx, window, summary);
    }
    return summary;
  }

  // ─────────────────────────────── report fetching ─────────────────────────────── //

  /**
   * One merchant's charges report over a window, every page. Complete only when the
   * last page said there is no more — an incomplete report is never used to decide
   * that something is MISSING.
   */
  private async fetchReport(
    merchantId: string,
    window: ReportWindow,
    extra: {
      periodType?: 'CHARGE' | 'PAID_OUT';
      payoutId?: string;
    } = {},
  ): Promise<FetchedReport> {
    const rows: TapChargeReportRow[] = [];
    let skipped = 0;
    let startingAfter = '';

    for (
      let page = 1;
      page <= PROVIDER_RECONCILIATION.MAX_REPORT_PAGES;
      page += 1
    ) {
      const res = await this.client.downloadCharges({
        period: {
          date: {
            from: String(window.from.getTime()),
            to: String(window.to.getTime()),
          },
          type: extra.periodType ?? 'CHARGE',
        },
        merchants: [merchantId],
        limit: PROVIDER_RECONCILIATION.REPORT_PAGE_SIZE,
        starting_after: startingAfter,
        ...(extra.payoutId ? { payouts: { payout_id: [extra.payoutId] } } : {}),
      });
      if (!res.ok) {
        return {
          ok: false,
          transient: res.transient,
          httpStatus: res.status,
          code: res.errorCode,
        };
      }
      let parsed;
      try {
        parsed = parseChargeReport(res.json);
      } catch (err) {
        if (err instanceof TapReportParseError) {
          return {
            ok: false,
            transient: false,
            httpStatus: res.status,
            parseError: true,
          };
        }
        throw err;
      }
      rows.push(...parsed.rows);
      skipped += parsed.skipped;

      const hasMore = res.headers?.has_more === 'true';
      const last = res.headers?.last_charge_id;
      if (!hasMore) return { ok: true, rows, skipped, complete: true };
      if (!last || last === startingAfter) break; // no cursor to follow: stop, incomplete
      startingAfter = last;
    }
    return { ok: true, rows, skipped, complete: false };
  }

  private async markReports(
    ctx: MerchantContext,
    status: 'OK' | 'UNREACHABLE',
  ): Promise<void> {
    if (ctx.scope !== 'clinic' || !ctx.tenantId) return;
    await this.merchants
      .createQueryBuilder()
      .update(MerchantAccount)
      .set({
        provider_reports_status: status,
        provider_reports_checked_at: () => 'now()',
      })
      .where('"tenantId" = :t AND provider = :p', {
        t: ctx.tenantId,
        p: PROVIDER,
      })
      .execute();
  }

  // ─────────────────────────── report vs our records ─────────────────────────── //

  /**
   * Compare a charges report with what we recorded. Shared by the daily sweep and
   * the manual CSV import (`ctx.scope === 'import'`: no merchant, nothing "missing").
   */
  private async applyReport(
    ctx: MerchantContext,
    allRows: TapChargeReportRow[],
    skippedRows: number,
    opts: { window?: ReportWindow; complete: boolean },
    summary: MerchantReconcileSummary,
  ): Promise<void> {
    summary.skippedRows += skippedRows;
    // A row for another merchant is not ours to judge (and never touches our records).
    const rows = this.ownRows(allRows, ctx.merchantId);
    summary.rows += rows.length;
    const now = Date.now();

    const ids = [...new Set(rows.map((r) => r.chargeId))];
    const payments = await this.loadPayments(ids);
    const invoices = await this.loadInvoices(ids);

    for (const row of rows) {
      const payment = payments.get(row.chargeId);
      if (payment) {
        await this.checkPaymentRow(ctx, row, payment, now, summary);
        continue;
      }
      const invoice = invoices.get(row.chargeId);
      if (invoice) {
        await this.checkInvoiceRow(ctx, row, invoice, now, summary);
        continue;
      }
      if (
        row.status === 'CAPTURED' &&
        !(
          row.chargeDate &&
          now - row.chargeDate.getTime() <
            PROVIDER_RECONCILIATION.SETTLE_GRACE_MS
        )
      ) {
        await this.raise(summary, {
          kind: RECONCILIATION_KIND.UNKNOWN_CHARGE,
          provider: PROVIDER,
          objectId: row.chargeId,
          tenantId: ctx.tenantId,
          merchantId: ctx.merchantId ?? row.merchantId,
          details: {
            amount: row.amount,
            currency: row.currency,
            referenceTransaction: row.referenceTransaction ?? null,
            referenceOrder: row.referenceOrder ?? null,
          },
        });
      }
    }

    await this.checkDuplicates(ctx, rows, payments, invoices, summary);
    if (opts.complete && opts.window && ctx.scope !== 'import') {
      await this.checkMissing(ctx, rows, opts.window, summary);
    }
  }

  private async loadPayments(ids: string[]): Promise<Map<string, PaymentRow>> {
    const out = new Map<string, PaymentRow>();
    for (const part of chunk(ids, 500)) {
      const rows: PaymentRow[] = await this.dataSource.query(
        `SELECT id, "tenantId" AS tenant_id, amount, currency, status, gateway_payment_id,
                gateway_fee, platform_fee, fees_reconciled_at, purpose, settlement_mode,
                refunded_amount, provider_payout_id, payment_method
           FROM payments
          WHERE gateway = $1 AND gateway_payment_id = ANY($2)`,
        [PROVIDER, part],
      );
      for (const r of rows) out.set(r.gateway_payment_id, r);
    }
    return out;
  }

  private async loadInvoices(ids: string[]): Promise<Map<string, InvoiceRow>> {
    const out = new Map<string, InvoiceRow>();
    for (const part of chunk(ids, 500)) {
      const rows: InvoiceRow[] = await this.dataSource.query(
        `SELECT id, tenant_id, amount, currency, status, provider_reference, checkout_charge_id
           FROM subscription_invoices
          WHERE provider_reference = ANY($1) OR checkout_charge_id = ANY($1)`,
        [part],
      );
      for (const r of rows) {
        if (r.provider_reference && part.includes(r.provider_reference)) {
          out.set(r.provider_reference, r);
        }
        if (r.checkout_charge_id && part.includes(r.checkout_charge_id)) {
          out.set(r.checkout_charge_id, r);
        }
      }
    }
    return out;
  }

  private async checkPaymentRow(
    ctx: MerchantContext,
    row: TapChargeReportRow,
    p: PaymentRow,
    now: number,
    summary: MerchantReconcileSummary,
  ): Promise<void> {
    const verdict = checkCharge(
      row,
      {
        amountCents: toCents(p.amount),
        currency: p.currency,
        paid: PAYMENT_PAID_LIKE.has(p.status),
      },
      now,
    );
    const base = {
      provider: PROVIDER,
      objectId: row.chargeId,
      tenantId: p.tenant_id,
      paymentId: p.id,
      merchantId: ctx.merchantId ?? row.merchantId,
    };
    switch (verdict.verdict) {
      case 'amount_mismatch':
        await this.raise(summary, {
          ...base,
          kind: RECONCILIATION_KIND.AMOUNT_MISMATCH,
          details: {
            reportAmountCents: verdict.reportAmountCents,
            recordAmountCents: verdict.recordAmountCents,
            reportCurrency: verdict.reportCurrency,
            recordCurrency: verdict.recordCurrency,
            reportStatus: row.status,
            paymentStatus: p.status,
          },
        });
        return;
      case 'unpaid_but_captured':
        await this.raise(summary, {
          ...base,
          kind: RECONCILIATION_KIND.STATUS_MISMATCH,
          details: {
            direction: 'CAPTURED_BUT_NOT_PAID',
            reportStatus: row.status,
            paymentStatus: p.status,
            amount: row.amount,
            currency: row.currency,
          },
        });
        return;
      case 'paid_but_not_captured':
        await this.raise(summary, {
          ...base,
          kind: RECONCILIATION_KIND.STATUS_MISMATCH,
          details: {
            direction: 'PAID_BUT_NOT_CAPTURED',
            reportStatus: verdict.reportStatus,
            paymentStatus: p.status,
            amount: row.amount,
            currency: row.currency,
          },
        });
        return;
      case 'ok':
        break;
      default:
        return; // in_flight / too_recent
    }

    summary.matched += 1;
    if (row.status !== 'CAPTURED') return;
    await this.reconcileFee(ctx, row, p, summary);
    if (row.payoutId && p.provider_payout_id !== row.payoutId) {
      const res = await this.dataSource.query(
        `UPDATE payments SET provider_payout_id = $2 WHERE id = $1 AND provider_payout_id IS DISTINCT FROM $2`,
        [p.id, row.payoutId],
      );
      if (this.affected(res) > 0) summary.payoutLinks += 1;
    }
  }

  private async reconcileFee(
    ctx: MerchantContext,
    row: TapChargeReportRow,
    p: PaymentRow,
    summary: MerchantReconcileSummary,
  ): Promise<void> {
    const evaluation = evaluateFee(row, {
      amount: Number(p.amount),
      gateway_fee: Number(p.gateway_fee),
      platform_fee: Number(p.platform_fee),
      fees_reconciled: p.fees_reconciled_at != null,
    });

    if (evaluation.kind === 'changed') {
      summary.feesChanged += 1;
      await this.raise(summary, {
        kind: RECONCILIATION_KIND.FEE_MISMATCH,
        provider: PROVIDER,
        objectId: row.chargeId,
        tenantId: p.tenant_id,
        paymentId: p.id,
        merchantId: ctx.merchantId ?? row.merchantId,
        details: {
          reason: 'CHANGED_AFTER_RECONCILED',
          recordedFee: evaluation.recordedFee,
          reportedFee: evaluation.reportedFee,
          amount: Number(p.amount),
          currency: p.currency,
        },
      });
      return;
    }
    if (evaluation.kind !== 'apply') return;

    // One conditional UPDATE: a fee is written ONCE, and only to money that was
    // really received — so a webhook flipping the payment at the same moment cannot
    // race it, and a re-run (or a second report) cannot overwrite a final figure.
    const res = await this.dataSource.query(
      `UPDATE payments
          SET gateway_fee = $2,
              net_amount = $3,
              fees_reconciled_at = now(),
              payment_method = COALESCE(payment_method, $4),
              metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
        WHERE id = $1
          AND fees_reconciled_at IS NULL
          AND status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')`,
      [
        p.id,
        evaluation.gatewayFee,
        evaluation.netAmount,
        row.paymentMethod ?? null,
        JSON.stringify({
          fee_breakdown: {
            source: 'tap_charges_report',
            fee: row.fee,
            fee_vat: row.feeVat ?? 0,
            net_amount: row.netAmount ?? null,
          },
        }),
      ],
    );
    if (this.affected(res) > 0) summary.feesApplied += 1;

    if (evaluation.netInconsistent) {
      await this.raise(summary, {
        kind: RECONCILIATION_KIND.FEE_MISMATCH,
        provider: PROVIDER,
        objectId: row.chargeId,
        tenantId: p.tenant_id,
        paymentId: p.id,
        merchantId: ctx.merchantId ?? row.merchantId,
        details: {
          reason: 'NET_DOES_NOT_MATCH_AMOUNT_MINUS_FEE',
          amount: Number(p.amount),
          fee: row.fee,
          feeVat: row.feeVat ?? 0,
          reportedNet: evaluation.reportedNet,
          currency: p.currency,
        },
      });
    }
  }

  private async checkInvoiceRow(
    ctx: MerchantContext,
    row: TapChargeReportRow,
    inv: InvoiceRow,
    now: number,
    summary: MerchantReconcileSummary,
  ): Promise<void> {
    const verdict = checkCharge(
      row,
      {
        amountCents: toCents(inv.amount),
        currency: inv.currency,
        paid: INVOICE_PAID_LIKE.has(inv.status),
      },
      now,
    );
    if (verdict.verdict === 'ok') {
      summary.matched += 1;
      return;
    }
    const base = {
      provider: PROVIDER,
      objectId: row.chargeId,
      tenantId: inv.tenant_id,
      merchantId: ctx.merchantId ?? row.merchantId,
    };
    if (verdict.verdict === 'amount_mismatch') {
      await this.raise(summary, {
        ...base,
        kind: RECONCILIATION_KIND.AMOUNT_MISMATCH,
        details: { subscriptionInvoiceId: inv.id, ...verdict },
      });
    } else if (verdict.verdict === 'unpaid_but_captured') {
      await this.raise(summary, {
        ...base,
        kind: RECONCILIATION_KIND.STATUS_MISMATCH,
        details: {
          direction: 'CAPTURED_BUT_NOT_PAID',
          subscriptionInvoiceId: inv.id,
          invoiceStatus: inv.status,
          reportStatus: row.status,
          amount: row.amount,
          currency: row.currency,
        },
      });
    } else if (verdict.verdict === 'paid_but_not_captured') {
      await this.raise(summary, {
        ...base,
        kind: RECONCILIATION_KIND.STATUS_MISMATCH,
        details: {
          direction: 'PAID_BUT_NOT_CAPTURED',
          subscriptionInvoiceId: inv.id,
          invoiceStatus: inv.status,
          reportStatus: verdict.reportStatus,
        },
      });
    }
  }

  /**
   * Two LIVE captures for one booking / invoice: the payer was charged twice. A
   * booking paid, fully refunded and paid again legitimately has two captures too,
   * so a charge we hold as fully refunded (or a void invoice) does not count.
   */
  private async checkDuplicates(
    ctx: MerchantContext,
    rows: TapChargeReportRow[],
    payments: Map<string, PaymentRow>,
    invoices: Map<string, InvoiceRow>,
    summary: MerchantReconcileSummary,
  ): Promise<void> {
    for (const group of groupCapturedByReference(rows)) {
      const live = group.chargeIds.filter((id) => {
        const p = payments.get(id);
        if (p) return p.status !== 'REFUNDED' && p.status !== 'FAILED';
        const inv = invoices.get(id);
        if (inv) return inv.status !== 'REFUNDED' && inv.status !== 'VOID';
        return true; // a capture we know nothing about still moved money
      });
      if (live.length < 2) continue;
      const [first, ...extras] = live;
      for (const extra of extras) {
        const p = payments.get(extra);
        const inv = invoices.get(extra);
        await this.raise(summary, {
          kind: RECONCILIATION_KIND.DUPLICATE_CAPTURE,
          provider: PROVIDER,
          objectId: extra,
          tenantId: p?.tenant_id ?? inv?.tenant_id ?? ctx.tenantId,
          paymentId: p?.id,
          merchantId: ctx.merchantId ?? group.merchantId,
          details: {
            reference: group.key,
            firstChargeId: first,
            liveChargeIds: live,
            paymentId: p?.id ?? null,
            subscriptionInvoiceId: inv?.id ?? null,
          },
        });
      }
    }
  }

  /** Money we booked as received that the gateway's COMPLETE report does not contain. */
  private async checkMissing(
    ctx: MerchantContext,
    rows: TapChargeReportRow[],
    window: ReportWindow,
    summary: MerchantReconcileSummary,
  ): Promise<void> {
    const reported = new Set(rows.map((r) => r.chargeId));
    // A hosted session can open up to an hour before it is paid, so a payment paid
    // right after the window starts may belong to a charge created just before it.
    const from = new Date(window.from.getTime() + 60 * 60_000);
    const to = new Date(
      window.to.getTime() - PROVIDER_RECONCILIATION.SETTLE_GRACE_MS,
    );
    if (from >= to) return;

    const payments: Array<{
      id: string;
      tenant_id: string;
      gateway_payment_id: string;
      amount: string;
      paid_at: Date;
    }> =
      ctx.scope === 'platform'
        ? await this.dataSource.query(
            `SELECT id, "tenantId" AS tenant_id, gateway_payment_id, amount, paid_at FROM payments
              WHERE gateway = $1 AND gateway_payment_id IS NOT NULL
                AND purpose = ANY($2) AND status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')
                AND paid_at >= $3 AND paid_at < $4`,
            [PROVIDER, [...PLATFORM_REVENUE_PURPOSES], from, to],
          )
        : await this.dataSource.query(
            `SELECT id, "tenantId" AS tenant_id, gateway_payment_id, amount, paid_at FROM payments
              WHERE gateway = $1 AND gateway_payment_id IS NOT NULL AND "tenantId" = $5
                AND purpose = ANY($2) AND status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')
                AND paid_at >= $3 AND paid_at < $4`,
            [PROVIDER, [...CLINIC_REVENUE_PURPOSES], from, to, ctx.tenantId],
          );
    for (const p of payments) {
      if (reported.has(p.gateway_payment_id)) continue;
      await this.raise(summary, {
        kind: RECONCILIATION_KIND.MISSING_AT_PROVIDER,
        provider: PROVIDER,
        objectId: p.gateway_payment_id,
        tenantId: p.tenant_id,
        paymentId: p.id,
        merchantId: ctx.merchantId,
        details: { amount: Number(p.amount), paidAt: p.paid_at },
      });
    }

    if (ctx.scope === 'platform') {
      const invoices: Array<{
        id: string;
        tenant_id: string;
        provider_reference: string;
        paid_at: Date;
      }> = await this.dataSource.query(
        `SELECT id, tenant_id, provider_reference, paid_at FROM subscription_invoices
            WHERE provider = $1 AND status = 'PAID' AND provider_reference LIKE 'chg\\_%'
              AND paid_at >= $2 AND paid_at < $3`,
        [PROVIDER, from, to],
      );
      for (const inv of invoices) {
        if (reported.has(inv.provider_reference)) continue;
        await this.raise(summary, {
          kind: RECONCILIATION_KIND.MISSING_AT_PROVIDER,
          provider: PROVIDER,
          objectId: inv.provider_reference,
          tenantId: inv.tenant_id,
          merchantId: ctx.merchantId,
          details: { subscriptionInvoiceId: inv.id, paidAt: inv.paid_at },
        });
      }
    }
  }

  // ───────────────────────────────── payouts ───────────────────────────────── //

  private async importPayouts(
    ctx: MerchantContext,
    window: ReportWindow,
    summary: MerchantReconcileSummary,
  ): Promise<void> {
    const res = await this.client.listPayouts({
      period: {
        date: {
          from: String(window.from.getTime()),
          to: String(window.to.getTime()),
        },
      },
      merchants: [ctx.merchantId],
      limit: 50,
    });
    if (!res.ok) return; // payouts unavailable now: the next run tries again
    if (res.json?.has_more) {
      summary.payoutsTruncated = true;
      this.logger.warn(
        `Payout list for merchant ${ctx.merchantId} has more than one page; the remainder is picked up as the window moves`,
      );
    }
    for (const payout of res.json?.payouts ?? []) {
      try {
        await this.mirrorPayout(ctx, payout, window, summary);
      } catch (err) {
        this.logger.error(
          `Payout ${String(payout?.id).slice(0, 40)} could not be mirrored: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Mirror ONE payout Tap made to a clinic as a read-only settlement, link it to the
   * payments it paid out, and check it adds up. Idempotent: the same payout seen
   * again updates the same settlement and re-links the same payments.
   */
  private async mirrorPayout(
    ctx: MerchantContext,
    payout: TapPayout,
    window: ReportWindow,
    summary: MerchantReconcileSummary,
  ): Promise<void> {
    const amount = Number(payout.amount);
    const currency = String(payout.currency ?? '').toUpperCase();
    if (
      !payout.id ||
      !PAYOUT_ID.test(payout.id) ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      !/^[A-Z]{3}$/.test(currency)
    ) {
      return; // not something we can mirror honestly
    }
    const status = mapPayoutStatus(payout.status);
    const paidAt =
      status === 'PAID' &&
      payout.date != null &&
      Number.isFinite(Number(payout.date))
        ? new Date(Number(payout.date))
        : null;
    const bankReference = payout.bank_reference
      ? String(payout.bank_reference).slice(0, 64)
      : null;

    // The charges this payout paid out, with their fees. If the report is not
    // available the payout is still mirrored; linking and the check wait for next run.
    const charges = await this.fetchReport(ctx.merchantId!, window, {
      periodType: 'PAID_OUT',
      payoutId: payout.id,
    });
    const rows = charges.ok
      ? this.ownRows(charges.rows, ctx.merchantId).filter(
          (r) => r.status === 'CAPTURED',
        )
      : [];
    const payments = await this.loadPayments(rows.map((r) => r.chargeId));
    // Only this clinic's own provider-settled payments are ever linked to its payout.
    const linked = rows
      .map((r) => ({ row: r, payment: payments.get(r.chargeId) }))
      .filter(
        (x): x is { row: TapChargeReportRow; payment: PaymentRow } =>
          !!x.payment &&
          x.payment.tenant_id === ctx.tenantId &&
          x.payment.settlement_mode === SETTLEMENT_MODE.PROVIDER,
      );

    const grossC = linked.reduce((c, x) => c + toCents(x.payment.amount), 0);
    const feeC = linked.reduce(
      (c, x) => c + toCents(x.row.fee ?? 0) + toCents(x.row.feeVat ?? 0),
      0,
    );

    await this.dataSource.transaction(async (m) => {
      const settlementId = await this.upsertSettlement(m, {
        tenantId: ctx.tenantId!,
        payoutId: payout.id,
        amount,
        currency,
        status,
        paidAt,
        bankReference,
        grossC: charges.ok && linked.length > 0 ? grossC : undefined,
        feeC: charges.ok && linked.length > 0 ? feeC : undefined,
      });
      if (!settlementId || linked.length === 0 || status === 'FAILED') return;

      const ids = linked.map((x) => x.payment.id);
      await this.settlementItems.mapPayments(settlementId, ids, m);
      // PAID out ⇒ SETTLED; on its way ⇒ IN_BATCH (never walked back from SETTLED).
      await m.query(
        `UPDATE payments
            SET provider_payout_id = $2,
                settlement_status = $3::payments_settlement_status_enum
          WHERE id = ANY($1) AND settlement_mode = 'PROVIDER'
            AND (provider_payout_id IS DISTINCT FROM $2
                 OR settlement_status::text <> $4)
            AND settlement_status::text <> 'SETTLED'`,
        [
          ids,
          payout.id,
          status === 'PAID' ? 'SETTLED' : 'IN_BATCH',
          status === 'PAID' ? 'SETTLED' : 'IN_BATCH',
        ],
      );
    });
    summary.payoutsMirrored += 1;

    // Does it add up? Only judged when every charge in it is known with its net.
    if (
      status !== 'PAID' ||
      !charges.ok ||
      !charges.complete ||
      rows.length === 0 ||
      rows.some((r) => r.netAmount === undefined) ||
      linked.length !== rows.length
    ) {
      return;
    }
    const refunds = linked.reduce(
      (c, x) => c + toCents(x.payment.refunded_amount),
      0,
    );
    const evaluation = evaluatePayout(
      amount,
      rows.reduce((c, r) => c + toCents(r.netAmount!), 0),
      refunds,
    );
    if (evaluation.matches) {
      await this.exceptions.autoResolve(
        RECONCILIATION_KIND.SETTLEMENT_MISMATCH,
        payout.id,
        'The payout now equals the net of its charges',
      );
      return;
    }
    await this.raise(summary, {
      kind: RECONCILIATION_KIND.SETTLEMENT_MISMATCH,
      provider: PROVIDER,
      objectId: payout.id,
      tenantId: ctx.tenantId,
      merchantId: ctx.merchantId,
      details: {
        currency,
        payoutCents: evaluation.payoutCents,
        chargesNetCents: evaluation.chargesNetCents,
        refundsRecordedCents: evaluation.refundsCents,
        differenceCents: evaluation.differenceCents,
        chargeCount: rows.length,
      },
    });
  }

  private async upsertSettlement(
    m: EntityManager,
    s: {
      tenantId: string;
      payoutId: string;
      amount: number;
      currency: string;
      status: string;
      paidAt: Date | null;
      bankReference: string | null;
      grossC?: number;
      feeC?: number;
    },
  ): Promise<string | undefined> {
    // `PAID` is final: a stale or reordered answer never walks a paid payout back.
    const rows = await m.query(
      `INSERT INTO settlements
         ("tenantId", gross_amount, fee_amount, net_amount, currency, status, paid_at,
          source, provider, provider_payout_id, bank_reference)
       VALUES ($1, $2, $3, $4, $5, $6::settlements_status_enum, $7, 'PROVIDER', 'tap', $8, $9)
       ON CONFLICT (provider, provider_payout_id) WHERE provider_payout_id IS NOT NULL
       DO UPDATE SET
         status = EXCLUDED.status,
         net_amount = EXCLUDED.net_amount,
         currency = EXCLUDED.currency,
         paid_at = EXCLUDED.paid_at,
         bank_reference = COALESCE(EXCLUDED.bank_reference, settlements.bank_reference),
         gross_amount = CASE WHEN $10::boolean THEN EXCLUDED.gross_amount ELSE settlements.gross_amount END,
         fee_amount = CASE WHEN $10::boolean THEN EXCLUDED.fee_amount ELSE settlements.fee_amount END,
         updated_at = now()
       WHERE settlements.status::text <> 'PAID'
       RETURNING id`,
      [
        s.tenantId,
        (s.grossC ?? toCents(s.amount)) / 100,
        (s.feeC ?? 0) / 100,
        s.amount,
        s.currency,
        s.status,
        s.paidAt,
        s.payoutId,
        s.bankReference,
        s.grossC !== undefined,
      ],
    );
    if (rows[0]?.id) return rows[0].id as string;
    // already PAID: nothing to update, but linking may still be due
    const existing = await m.query(
      `SELECT id FROM settlements WHERE provider = 'tap' AND provider_payout_id = $1`,
      [s.payoutId],
    );
    return existing[0]?.id as string | undefined;
  }

  // ───────────────────────────── manual report import ───────────────────────────── //

  /**
   * The fallback for a merchant whose report the API will not give us: an operator
   * exports the charges report from Tap's dashboard and imports it here. Same
   * parser, same checks, same one-time fee write — and it can only ever APPLY fees
   * and payout ids to charges we already hold and raise discrepancies: it cannot
   * create a payment, change a status, or move money.
   */
  async importChargesReport(
    csv: string,
    actorId: string | undefined,
  ): Promise<MerchantReconcileSummary> {
    if (typeof csv !== 'string' || csv.trim() === '') {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The report is empty',
      });
    }
    if (csv.length > PROVIDER_RECONCILIATION.MAX_IMPORT_CHARS) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The report is too large; import it in smaller date ranges',
      });
    }
    let parsed;
    try {
      parsed = parseChargeReport(csv);
    } catch (err) {
      if (err instanceof TapReportParseError) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'This is not a Tap charges report',
        });
      }
      throw err;
    }

    const ctx: MerchantContext = { scope: 'import' };
    const summary = emptySummary(ctx);
    summary.reports = 'ok';
    await this.applyReport(
      ctx,
      parsed.rows,
      parsed.skipped,
      { complete: false },
      summary,
    );
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.RECONCILIATION_REPORT_IMPORTED,
      userId: actorId,
      entityType: 'tap_charges_report',
      after: {
        rows: summary.rows,
        skippedRows: summary.skippedRows,
        matched: summary.matched,
        feesApplied: summary.feesApplied,
        exceptions: summary.exceptions,
      },
    });
    return summary;
  }

  // ───────────────────────────────── helpers ───────────────────────────────── //

  private async raise(
    summary: MerchantReconcileSummary,
    input: RaiseExceptionInput,
  ): Promise<void> {
    const res = await this.exceptions.raise(input);
    if (res.created || res.reopened) summary.exceptions += 1;
  }

  /**
   * The rows of a report that are THIS merchant's.
   *
   * Tap already filters a report by `merchants[]`, so every row is the merchant we
   * asked for; the row's own `merchant_id` is only a sanity check — and its FORMAT is
   * not documented (the payout docs show numeric ids like "599242", Connect speaks
   * `merchant_…`). So a row naming a DIFFERENT merchant is dropped, except in one
   * case: when EVERY row carries the SAME single id and none matches ours, the column
   * simply uses another id format than the filter, and the report is trusted as asked.
   * (Dropping them all would read as "Tap reports nothing" and flag every payment of
   * the merchant as missing.)
   */
  private ownRows(
    rows: TapChargeReportRow[],
    merchantId: string | undefined,
  ): TapChargeReportRow[] {
    if (!merchantId) return rows;
    const ours = rows.filter(
      (r) => !r.merchantId || r.merchantId === merchantId,
    );
    if (ours.length === rows.length) return rows;
    const named = new Set(rows.map((r) => r.merchantId));
    if (ours.length === 0 && named.size === 1) {
      this.logger.warn(
        'Every row of a merchant report carries one merchant id that is not the id we asked for — treating the column as another id format and trusting the report',
      );
      return rows;
    }
    return ours;
  }

  /** Row count of an `UPDATE` through `dataSource.query` (a `[rows, count]` tuple on Postgres). */
  private affected(res: unknown): number {
    if (Array.isArray(res) && typeof res[1] === 'number') return res[1];
    return 0;
  }
}
