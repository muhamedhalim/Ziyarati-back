import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { escapeSpreadsheetCell } from '../../common/import/spreadsheet-escape';
import { round2 } from '../payments/payments.constants';
import { QuerySubscriptionInvoicesDto } from './dto/query-subscription-invoices.dto';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** The `failure_class` a renewal records when the clinic has no usable saved card. */
const TOKENIZATION_UNAVAILABLE = 'TOKENIZATION_UNAVAILABLE';

export type InvoiceRefundState = 'NONE' | 'IN_FLIGHT' | 'REFUNDED';

/** One subscription invoice as the platform finance ledger shows it. */
export interface SubscriptionInvoiceRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  /** The plan this invoice bills for (the target plan of an upgrade, else the subscription's plan). */
  planName: string | null;
  /** INITIAL / UPGRADE / RENEWAL / REACTIVATION; null on invoices issued before kinds existed. */
  kind: string | null;
  status: string;
  amount: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  issuedAt: string | null;
  paidAt: string | null;
  provider: string | null;
  /** The provider's charge id (never a card detail). */
  providerReference: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  /** Why the last renewal charge did not go through (a class, never raw provider text). */
  failureClass: string | null;
  refundState: InvoiceRefundState;
  refundRequestedAt: string | null;
  refundedAt: string | null;
  refundAttempts: number;
  /** A refund can be started: PAID, none in flight, and a provider charge to refund. */
  canRefund: boolean;
}

export interface SubscriptionFinanceSummary {
  /** Per currency — amounts in different currencies are never added together. */
  byCurrency: Array<{
    currency: string;
    collected: number;
    refunded: number;
    outstanding: number;
  }>;
  counts: Record<string, number>;
  /** OPEN invoices a charge has failed on (a retry is scheduled or the clinic must act). */
  failedRenewals: number;
  /** OPEN invoices waiting on the clinic to add a card (the renewal could not be charged). */
  tokenizationDeclines: number;
  /** Refunds the provider accepted but has not completed yet. */
  refundsInFlight: number;
}

const SORTABLE: Record<string, string> = {
  issued_at: 'si.issued_at',
  paid_at: 'si.paid_at',
  amount: 'si.amount',
  status: 'si.status',
};

const iso = (v: unknown): string | null =>
  v ? new Date(v as string).toISOString() : null;

/**
 * Read-only ledger of SUBSCRIPTION revenue for the platform owner — what clinics paid
 * ZiyaraTech for their plans. Deliberately separate from the marketplace ledger (what
 * patients paid clinics): the two are different money with different owners.
 *
 * It only reads. The one write the screen offers (a full refund) goes through the
 * existing platform endpoint, which owns the claim / provider / apply protocol.
 */
@Injectable()
export class SubscriptionFinanceService {
  constructor(
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
  ) {}

  private base(): SelectQueryBuilder<SubscriptionInvoice> {
    return (
      this.invoices
        .createQueryBuilder('si')
        // `subscription_invoices.tenant_id` / `subscription_id` are varchar while the tables they
        // point at key on uuid, so the joins compare as text (which can never throw on odd data).
        .leftJoin('tenants', 't', 't.id::text = si.tenant_id')
        .leftJoin('subscriptions', 's', 's.id::text = si.subscription_id')
        .leftJoin(
          'subscription_plans',
          'sp',
          'sp.id = COALESCE(si.target_plan_id, s."planId")',
        )
    );
  }

  private applyFilters(
    qb: SelectQueryBuilder<SubscriptionInvoice>,
    q: QuerySubscriptionInvoicesDto,
  ): void {
    if (q.tenantId)
      qb.andWhere('si.tenant_id = :tenantId', { tenantId: q.tenantId });
    if (q.status) qb.andWhere('si.status = :status', { status: q.status });
    if (q.kind) {
      if (q.kind === 'LEGACY') qb.andWhere('si.kind IS NULL');
      else qb.andWhere('si.kind = :kind', { kind: q.kind });
    }
    if (q.provider)
      qb.andWhere('si.provider = :provider', { provider: q.provider });
    if (q.refund === 'IN_FLIGHT') {
      qb.andWhere(
        'si.refund_requested_at IS NOT NULL AND si.refunded_at IS NULL',
      );
    } else if (q.refund === 'REFUNDED') {
      qb.andWhere('si.refunded_at IS NOT NULL');
    }
    if (q.attention === 'true') {
      qb.andWhere(
        `si.status = 'OPEN' AND (si.failure_class IS NOT NULL OR si.retry_count > 0)`,
      );
    }
    if (q.issuedFrom)
      qb.andWhere('si.issued_at >= :issuedFrom', {
        issuedFrom: new Date(q.issuedFrom),
      });
    if (q.issuedTo)
      qb.andWhere('si.issued_at <= :issuedTo', {
        issuedTo: new Date(q.issuedTo),
      });
    if (q.search?.trim()) {
      qb.andWhere(
        `(t.name ILIKE :term OR si.provider_reference ILIKE :term OR CAST(si.id AS text) ILIKE :term)`,
        { term: `%${q.search.trim()}%` },
      );
    }
  }

  async list(q: QuerySubscriptionInvoicesDto) {
    const countQb = this.base();
    this.applyFilters(countQb, q);
    const totalRow = await countQb
      .select('COUNT(*)', 'cnt')
      .getRawOne<{ cnt: string }>();

    const dataQb = this.base();
    this.applyFilters(dataQb, q);
    const rows = await dataQb
      .select([
        'si.id AS id',
        'si.tenant_id AS tenant_id',
        't.name AS tenant_name',
        'sp.name AS plan_name',
        'si.kind AS kind',
        'si.status AS status',
        'si.amount AS amount',
        'si.currency AS currency',
        'si.period_start AS period_start',
        'si.period_end AS period_end',
        'si.issued_at AS issued_at',
        'si.paid_at AS paid_at',
        'si.provider AS provider',
        'si.provider_reference AS provider_reference',
        'si.retry_count AS retry_count',
        'si.next_retry_at AS next_retry_at',
        'si.failure_class AS failure_class',
        'si.refund_requested_at AS refund_requested_at',
        'si.refunded_at AS refunded_at',
        'si.refund_attempts AS refund_attempts',
      ])
      .orderBy(
        SORTABLE[q.sortBy] ?? SORTABLE.issued_at,
        q.sortDir,
        'NULLS LAST',
      )
      .addOrderBy('si.id', 'DESC')
      .offset((q.page - 1) * q.limit)
      .limit(q.limit)
      .getRawMany();

    return {
      data: rows.map((r) => this.mapRow(r)),
      total: n(totalRow?.cnt),
      page: q.page,
      limit: q.limit,
      summary: await this.summary(q),
    };
  }

  private mapRow(r: Record<string, unknown>): SubscriptionInvoiceRow {
    const refundRequestedAt = iso(r.refund_requested_at);
    const refundedAt = iso(r.refunded_at);
    const refundState: InvoiceRefundState = refundedAt
      ? 'REFUNDED'
      : refundRequestedAt
        ? 'IN_FLIGHT'
        : 'NONE';
    const status = r.status as string;
    const providerReference = (r.provider_reference as string) ?? null;
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      tenantName: (r.tenant_name as string) ?? null,
      planName: (r.plan_name as string) ?? null,
      kind: (r.kind as string) ?? null,
      status,
      amount: round2(n(r.amount)),
      currency: (r.currency as string) ?? 'SAR',
      periodStart: new Date(r.period_start as string).toISOString(),
      periodEnd: new Date(r.period_end as string).toISOString(),
      issuedAt: iso(r.issued_at),
      paidAt: iso(r.paid_at),
      provider: (r.provider as string) ?? null,
      providerReference,
      retryCount: n(r.retry_count),
      nextRetryAt: iso(r.next_retry_at),
      failureClass: (r.failure_class as string) ?? null,
      refundState,
      refundRequestedAt,
      refundedAt,
      refundAttempts: n(r.refund_attempts),
      canRefund:
        status === 'PAID' && refundState === 'NONE' && !!providerReference,
    };
  }

  /** Totals over the SAME filter as the list (not just the page), per currency. */
  async summary(
    q: QuerySubscriptionInvoicesDto,
  ): Promise<SubscriptionFinanceSummary> {
    const money = this.base();
    this.applyFilters(money, q);
    const byCurrency = await money
      .select([
        'si.currency AS currency',
        `COALESCE(SUM(si.amount) FILTER (WHERE si.status = 'PAID'), 0) AS collected`,
        `COALESCE(SUM(si.amount) FILTER (WHERE si.status = 'REFUNDED'), 0) AS refunded`,
        `COALESCE(SUM(si.amount) FILTER (WHERE si.status = 'OPEN'), 0) AS outstanding`,
      ])
      .groupBy('si.currency')
      .orderBy('si.currency', 'ASC')
      .getRawMany();

    const countQb = this.base();
    this.applyFilters(countQb, q);
    const counted = await countQb
      .select([
        'si.status AS status',
        'COUNT(*)::int AS count',
        `COUNT(*) FILTER (WHERE si.status = 'OPEN' AND (si.failure_class IS NOT NULL OR si.retry_count > 0))::int AS failed_renewals`,
        `COUNT(*) FILTER (WHERE si.status = 'OPEN' AND si.failure_class = :tokenization)::int AS tokenization`,
        `COUNT(*) FILTER (WHERE si.refund_requested_at IS NOT NULL AND si.refunded_at IS NULL)::int AS refunds_in_flight`,
      ])
      .setParameter('tokenization', TOKENIZATION_UNAVAILABLE)
      .groupBy('si.status')
      .getRawMany();

    const counts: Record<string, number> = {};
    let failedRenewals = 0;
    let tokenizationDeclines = 0;
    let refundsInFlight = 0;
    for (const c of counted) {
      counts[c.status as string] = n(c.count);
      failedRenewals += n(c.failed_renewals);
      tokenizationDeclines += n(c.tokenization);
      refundsInFlight += n(c.refunds_in_flight);
    }

    return {
      byCurrency: byCurrency.map((r) => ({
        currency: r.currency as string,
        collected: round2(n(r.collected)),
        refunded: round2(n(r.refunded)),
        outstanding: round2(n(r.outstanding)),
      })),
      counts,
      failedRenewals,
      tokenizationDeclines,
      refundsInFlight,
    };
  }

  /** CSV (Excel-native) of the filtered ledger, capped for safety. */
  async exportCsv(
    q: QuerySubscriptionInvoicesDto,
  ): Promise<{ filename: string; content: string }> {
    const rows = await this.list({ ...q, page: 1, limit: 5000 });
    const headers = [
      'Invoice',
      'Clinic',
      'Plan',
      'Kind',
      'Status',
      'Amount',
      'Currency',
      'Period Start',
      'Period End',
      'Issued At',
      'Paid At',
      'Provider',
      'Provider Charge',
      'Retries',
      'Next Retry',
      'Failure',
      'Refund',
      'Refunded At',
    ];
    const esc = (v: unknown): string => {
      // SEC-05: clinic and plan names are user-controlled — neutralise formulas.
      // Only string values are escaped, so numeric amounts stay numeric.
      const s = v == null ? '' : String(escapeSpreadsheetCell(v));
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.data.map((r) =>
      [
        r.id,
        r.tenantName,
        r.planName,
        r.kind,
        r.status,
        r.amount,
        r.currency,
        r.periodStart,
        r.periodEnd,
        r.issuedAt,
        r.paidAt,
        r.provider,
        r.providerReference,
        r.retryCount,
        r.nextRetryAt,
        r.failureClass,
        r.refundState,
        r.refundedAt,
      ]
        .map(esc)
        .join(','),
    );
    return {
      filename: `subscription-invoices-${new Date().toISOString().slice(0, 10)}.csv`,
      content: [headers.join(','), ...lines].join('\n'),
    };
  }
}
