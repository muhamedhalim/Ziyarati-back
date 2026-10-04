import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';

import { PaymentReconciliationException } from '../../../entities/Payments/PaymentReconciliationException';
import { AppError, ErrorCode } from '../../../common/errors';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../../platform/platform-admin-audit.service';
import {
  RECONCILIATION_EXCEPTION_STATUS,
  RECONCILIATION_KIND,
  ReconciliationKind,
} from '../payments.constants';

export interface RaiseExceptionInput {
  kind: ReconciliationKind;
  provider: string;
  /** The gateway object the discrepancy is about (charge / refund / payout / merchant id). */
  objectId: string;
  tenantId?: string | null;
  paymentId?: string | null;
  merchantId?: string | null;
  /** Facts for the operator — amounts, statuses, ids. NEVER a credential or card data. */
  details: Record<string, unknown>;
}

export interface RaiseResult {
  created: boolean;
  reopened: boolean;
}

export interface QueryExceptionsInput {
  status?: string;
  kind?: string;
  tenantId?: string;
  page: number;
  limit: number;
}

/** Stable hash of the discrepancy itself: key order and volatile timestamps do not change it. */
export function detailsHash(details: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = canonical((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(details)))
    .digest('hex');
}

/**
 * The reconciliation queue: discrepancies a HUMAN must look at.
 *
 * Nothing here moves money. A duplicate capture, a fee that changed, a payout that
 * does not add up — each is recorded once (UNIQUE kind + object), re-found by every
 * later sweep (`occurrences`, `last_seen_at`), and closed by an operator with a note.
 *
 * A row an operator closed stays closed while the discrepancy is the SAME (its
 * `details_hash`); if the facts change it is reopened, so a settled question is not
 * asked every night but a new one is never swallowed.
 */
@Injectable()
export class ReconciliationExceptionService {
  private readonly logger = new Logger('ReconciliationExceptionService');

  constructor(
    @InjectRepository(PaymentReconciliationException)
    private readonly repo: Repository<PaymentReconciliationException>,
    private readonly dataSource: DataSource,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  /** Record (or re-find) one discrepancy. Idempotent and race-safe. */
  async raise(input: RaiseExceptionInput): Promise<RaiseResult> {
    const hash = detailsHash(input.details);
    const params = [
      input.kind,
      input.provider,
      input.objectId,
      input.tenantId ?? null,
      input.paymentId ?? null,
      input.merchantId ?? null,
      JSON.stringify(input.details),
      hash,
    ];

    const result = await this.dataSource.transaction(async (m) => {
      const inserted = await m.query(
        `INSERT INTO payment_reconciliation_exceptions
           (kind, provider, provider_object_id, tenant_id, payment_id, merchant_id, details, details_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (kind, provider_object_id) DO NOTHING
         RETURNING id`,
        params,
      );
      if (inserted.length > 0) return { created: true, reopened: false };

      const rows = await m.query(
        `SELECT id, status, details_hash FROM payment_reconciliation_exceptions
          WHERE kind = $1 AND provider_object_id = $2 FOR UPDATE`,
        [input.kind, input.objectId],
      );
      const row = rows[0];
      if (!row) return { created: false, reopened: false }; // deleted between the two statements
      const reopen =
        row.status !== RECONCILIATION_EXCEPTION_STATUS.OPEN &&
        row.details_hash !== hash;
      await m.query(
        `UPDATE payment_reconciliation_exceptions
            SET occurrences = occurrences + 1,
                last_seen_at = now(),
                details = $2::jsonb,
                details_hash = $3,
                tenant_id = COALESCE($4, tenant_id),
                payment_id = COALESCE($5, payment_id),
                merchant_id = COALESCE($6, merchant_id),
                status = CASE WHEN $7::boolean THEN 'OPEN' ELSE status END,
                resolved_at = CASE WHEN $7::boolean THEN NULL ELSE resolved_at END,
                resolved_by = CASE WHEN $7::boolean THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN $7::boolean THEN NULL ELSE resolution_note END
          WHERE id = $1`,
        [
          row.id,
          JSON.stringify(input.details),
          hash,
          input.tenantId ?? null,
          input.paymentId ?? null,
          input.merchantId ?? null,
          reopen,
        ],
      );
      return { created: false, reopened: reopen };
    });

    if (result.created || result.reopened) {
      // Only a NEW (or changed) discrepancy is page-worthy; a re-found one is not news.
      this.logger.error(
        `ALERT: reconciliation exception ${input.kind} on ${input.provider} object ${input.objectId}${result.reopened ? ' (reopened — the facts changed)' : ''} — manual review required`,
      );
    }
    return result;
  }

  /**
   * `raise`, for callers that are in the middle of something that matters more
   * (a webhook, the 10-minute sweep, the outcome consumer): recording the
   * discrepancy is bookkeeping and must never be the reason that work fails.
   */
  async raiseQuietly(input: RaiseExceptionInput): Promise<void> {
    try {
      await this.raise(input);
    } catch (err) {
      this.logger.warn(
        `Could not record reconciliation exception ${input.kind} for ${input.objectId}: ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * Two LIVE captures for one booking: the payer was charged twice. Called by the
   * durable outcome consumer right after a booking payment is applied, so it is
   * noticed within seconds rather than at the next daily report. "Live" = PAID or
   * PARTIALLY_REFUNDED — a booking that was paid, fully refunded and paid again
   * legitimately has two payments but only one live. The EARLIEST stays the
   * reference; every later one is raised (idempotently — the daily report raises
   * the same row, keyed by the charge id). Nothing is refunded or changed here.
   */
  async checkDuplicateBookingCapture(paymentId: string): Promise<number> {
    const rows: Array<{
      id: string;
      tenant_id: string;
      gateway: string | null;
      gateway_payment_id: string | null;
      amount: string;
      appointment_id: string;
    }> = await this.dataSource.query(
      `SELECT p.id, p."tenantId" AS tenant_id, p.gateway, p.gateway_payment_id, p.amount,
              p."appointmentId" AS appointment_id
         FROM payments p
        WHERE p."appointmentId" = (SELECT "appointmentId" FROM payments WHERE id = $1)
          AND p."appointmentId" IS NOT NULL
          AND p.status IN ('PAID', 'PARTIALLY_REFUNDED')
          AND p.purpose IN ('BOOKING', 'MANUAL')
        ORDER BY p.paid_at ASC NULLS LAST, p.id ASC`,
      [paymentId],
    );
    if (rows.length < 2) return 0;

    const [first, ...extras] = rows;
    for (const extra of extras) {
      await this.raiseQuietly({
        kind: RECONCILIATION_KIND.DUPLICATE_CAPTURE,
        provider: extra.gateway ?? 'unknown',
        // The gateway charge id, so the daily report finds the SAME row.
        objectId: extra.gateway_payment_id ?? extra.id,
        tenantId: extra.tenant_id,
        paymentId: extra.id,
        details: {
          reference: extra.appointment_id,
          firstChargeId: first.gateway_payment_id ?? first.id,
          livePaymentIds: rows.map((r) => r.id),
          paymentId: extra.id,
          subscriptionInvoiceId: null,
        },
      });
    }
    return extras.length;
  }

  /**
   * Close a row because the evidence now shows the discrepancy is gone (e.g. a
   * payout that now adds up). A system action: no actor, and only ever from OPEN.
   */
  async autoResolve(
    kind: ReconciliationKind,
    objectId: string,
    note: string,
  ): Promise<boolean> {
    const res = await this.dataSource.query(
      `UPDATE payment_reconciliation_exceptions
          SET status = 'RESOLVED', resolved_at = now(), resolution_note = $3
        WHERE kind = $1 AND provider_object_id = $2 AND status = 'OPEN'
        RETURNING id`,
      [kind, objectId, note],
    );
    return (res?.[0]?.length ?? res?.length ?? 0) > 0;
  }

  async list(query: QueryExceptionsInput) {
    const where: FindOptionsWhere<PaymentReconciliationException> = {};
    if (query.status) where.status = query.status;
    if (query.kind) where.kind = query.kind;
    if (query.tenantId) where.tenant_id = query.tenantId;

    const [data, total] = await this.repo.findAndCount({
      where,
      order: { last_seen_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const counts = await this.repo
      .createQueryBuilder('e')
      .select('e.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('e.status')
      .getRawMany<{ status: string; count: string }>();

    return {
      data: await this.withTenantNames(data),
      total,
      page: query.page,
      limit: query.limit,
      counts: Object.fromEntries(
        counts.map((c) => [c.status, Number(c.count)]),
      ),
    };
  }

  /** One exception as the operator reads it: the row plus the clinic's name. */
  async detail(id: string) {
    const row = await this.findOne(id);
    const [enriched] = await this.withTenantNames([row]);
    return enriched;
  }

  /** Adds `tenant_name` so the queue shows a clinic, not a UUID. One query for the page. */
  private async withTenantNames(rows: PaymentReconciliationException[]) {
    const ids = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const found: Array<{ id: string; name: string }> =
        await this.dataSource.query(
          `SELECT id, name FROM tenants WHERE id = ANY($1::uuid[])`,
          [ids],
        );
      for (const t of found) names.set(t.id, t.name);
    }
    return rows.map((r) => ({
      ...r,
      tenant_name: (r.tenant_id && names.get(r.tenant_id)) || null,
    }));
  }

  async findOne(id: string): Promise<PaymentReconciliationException> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Reconciliation exception not found',
      });
    }
    return row;
  }

  /**
   * An operator closes an OPEN row. IGNORED needs a reason (an ignored discrepancy
   * is a decision someone will want explained); RESOLVED takes an optional note.
   * Closing is idempotent for the same outcome and refused for a row already closed
   * the other way.
   */
  async close(
    id: string,
    actorId: string | undefined,
    outcome: 'RESOLVED' | 'IGNORED',
    note?: string,
  ): Promise<PaymentReconciliationException> {
    const trimmed = note?.trim() || undefined;
    if (outcome === 'IGNORED' && !trimmed) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'A note is required to ignore a reconciliation exception',
      });
    }

    const row = await this.findOne(id);
    if (row.status === outcome) return row;
    if (row.status !== RECONCILIATION_EXCEPTION_STATUS.OPEN) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Exception is already ${row.status}`,
      });
    }

    // Conditional on still being OPEN: two operators closing it at once cannot both win.
    const updated = await this.repo
      .createQueryBuilder()
      .update(PaymentReconciliationException)
      .set({
        status: outcome,
        resolved_at: () => 'now()',
        resolved_by: actorId ?? null,
        resolution_note: trimmed ?? null,
      })
      .where('id = :id AND status = :open', {
        id,
        open: RECONCILIATION_EXCEPTION_STATUS.OPEN,
      })
      .execute();
    if (!updated.affected) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'Exception was closed by someone else',
      });
    }

    await this.audit.record({
      action:
        outcome === 'RESOLVED'
          ? PLATFORM_ADMIN_AUDIT_ACTION.RECONCILIATION_EXCEPTION_RESOLVED
          : PLATFORM_ADMIN_AUDIT_ACTION.RECONCILIATION_EXCEPTION_IGNORED,
      userId: actorId,
      entityType: 'payment_reconciliation_exception',
      entityId: id,
      tenantId: row.tenant_id ?? undefined,
      before: { status: row.status },
      after: {
        status: outcome,
        kind: row.kind,
        providerObjectId: row.provider_object_id,
        note: trimmed ?? null,
      },
    });
    return this.findOne(id);
  }
}
