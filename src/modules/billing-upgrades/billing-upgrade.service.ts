import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';

import { UsageService } from '../subscription-billing/usage.service';
import { FeatureFlagService } from '../subscription-billing/feature-flag.service';
import { UsageMetric } from '../subscription-billing/usage-metric';
import { PaymentService } from '../payments/payment.service';
import { PAYMENT_PURPOSE } from '../payments/payments.constants';

import { BillingUpgradeEventService } from './billing-upgrade-event.service';
import { lockRequest } from './billing-upgrade-lock.util';
import { CreateBillingUpgradeRequestDto } from './dto/create-billing-upgrade-request.dto';
import { QueryBillingUpgradeRequestsDto } from './dto/query-billing-upgrade-requests.dto';
import {
  ACTIVE_BILLING_UPGRADE_STATUSES,
  BILLING_UPGRADE_EVENT_TYPE,
  BILLING_UPGRADE_STATUS,
  BILLING_UPGRADE_TYPE,
  BillingUpgradeStatus,
  OWNER_CANCELLABLE_STATUSES,
  TERMINAL_BILLING_UPGRADE_STATUSES,
  USAGE_METRIC_BREAKDOWN_KEY,
} from './billing-upgrade.constants';

export interface BillingUpgradeActor {
  id: string;
  email?: string;
}

export interface AcceptBillingUpgradeResult {
  request: BillingUpgradeRequest;
  redirectUrl?: string;
  paymentStatus?: string;
}

type AcceptPhaseResult =
  | { action: 'invalid'; request: BillingUpgradeRequest }
  | { action: 'not_quoted'; request: BillingUpgradeRequest }
  | { action: 'expired'; request: BillingUpgradeRequest }
  | { action: 'resume'; request: BillingUpgradeRequest }
  | { action: 'charge'; request: BillingUpgradeRequest };

/**
 * Owner-facing billing-upgrade-request workflow: create / list / get / cancel
 * / accept. Tenant is ALWAYS resolved by the caller (TenantContextService) —
 * never trusted from the request body.
 *
 * `accept()` is the security/financial-critical path: it revalidates status,
 * quote expiry, and the final price INSIDE a row-locked transaction, then
 * creates the actual charge through the existing `PaymentService` (there is
 * no wallet in this codebase — see module doc). The entitlement itself is
 * applied only by `BillingUpgradeEntitlementListener`, off the `payment.succeeded`
 * event, never here.
 */
@Injectable()
export class BillingUpgradeService {

  constructor(
    @InjectRepository(BillingUpgradeRequest)
    private readonly requests: Repository<BillingUpgradeRequest>,
    @InjectRepository(FeatureDefinition)
    private readonly featureDefinitions: Repository<FeatureDefinition>,
    private readonly dataSource: DataSource,
    private readonly usage: UsageService,
    private readonly featureFlags: FeatureFlagService,
    private readonly payments: PaymentService,
    private readonly history: BillingUpgradeEventService,
  ) {}

  async create(
    tenantId: string,
    actor: BillingUpgradeActor,
    dto: CreateBillingUpgradeRequestDto,
  ): Promise<BillingUpgradeRequest> {
    let targetKey: string;
    let currentUsage: number | null = null;
    let currentLimit: number | null = null;
    let requestedQuantity: number | null = null;

    if (dto.type === BILLING_UPGRADE_TYPE.FEATURE) {
      if (!dto.featureKey) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          message: 'featureKey is required for feature requests',
        });
      }
      await this.assertRequestableFeature(tenantId, dto.featureKey);
      targetKey = dto.featureKey;
    } else {
      if (!dto.usageMetric || dto.requestedQuantity == null) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          message: 'usageMetric and requestedQuantity are required for usage_limit requests',
        });
      }
      const snapshot = await this.snapshotUsageTarget(
        tenantId,
        dto.usageMetric as UsageMetric,
        dto.requestedQuantity,
      );
      currentUsage = snapshot.currentUsage;
      currentLimit = snapshot.currentLimit;
      requestedQuantity = dto.requestedQuantity;
      targetKey = dto.usageMetric;
    }

    // Friendly pre-check; the partial unique index is the authoritative guard
    // under a concurrent double-submit (caught below as a 23505).
    const active = await this.requests.findOne({
      where: {
        tenant: { id: tenantId },
        status: In(ACTIVE_BILLING_UPGRADE_STATUSES),
        ...(dto.type === BILLING_UPGRADE_TYPE.FEATURE
          ? { feature_key: targetKey }
          : { usage_metric: targetKey }),
      },
    });
    if (active) {
      throw new AppError(ErrorCode.DUPLICATE_ACTIVE_REQUEST, {
        publicContext: { existingRequestId: active.id },
      });
    }

    let saved: BillingUpgradeRequest;
    try {
      saved = await this.requests.save(
        this.requests.create({
          tenant: { id: tenantId } as Tenant,
          requestedBy: { id: actor.id } as User,
          requested_by_email: actor.email ?? undefined,
          type: dto.type,
          feature_key: dto.type === BILLING_UPGRADE_TYPE.FEATURE ? targetKey : undefined,
          usage_metric: dto.type === BILLING_UPGRADE_TYPE.USAGE_LIMIT ? targetKey : undefined,
          current_usage: currentUsage !== null ? String(currentUsage) : undefined,
          current_limit: currentLimit !== null ? String(currentLimit) : undefined,
          requested_quantity: requestedQuantity !== null ? String(requestedQuantity) : undefined,
          status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
        }),
      );
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new AppError(ErrorCode.DUPLICATE_ACTIVE_REQUEST);
      }
      throw err;
    }

    await this.history.record({
      requestId: saved.id,
      type: BILLING_UPGRADE_EVENT_TYPE.STATUS_CHANGED,
      toValue: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
      note: dto.note,
      actorId: actor.id,
      actorName: actor.email,
    });

    return saved;
  }

  /**
   * T047 (015-db-api-efficiency-audit, P7-2/ORM-001): a relation-shaped
   * `where: { tenant: { id } }` creates the same join a `relations:` option
   * does, and combined with `skip`/`take` forces TypeORM's DISTINCT-id-then-
   * hydrate branch — 2 round trips, not 1 (research.md R-01/R-08/R-10). No
   * relation is actually needed here, so this is built as a query builder
   * filtering the FK column resolved from entity metadata (no entity exposes
   * it as a plain property — R-11; `"tenantId"` also carries a real index,
   * `IDX_billing_upgrade_requests_tenant`), with `.limit()/.offset()`
   * instead of `.take()/.skip()` (R-10).
   */
  async list(tenantId: string, query: QueryBillingUpgradeRequestsDto) {
    const tenantFk = this.fk(this.requests, 'tenant');
    const qb = this.requests
      .createQueryBuilder('r')
      .where(`r."${tenantFk}" = :tenantId`, { tenantId })
      .orderBy('r.created_at', 'DESC')
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
    if (query.status) {
      qb.andWhere('r.status = :status', { status: query.status });
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page: query.page, limit: query.limit };
  }

  /** Resolves `property`'s join-column database name from entity metadata —
   *  no entity exposes a relation's FK as a plain property (research.md
   *  R-11); the proven `DashboardSummaryService.fk()` pattern. */
  private fk(repo: Repository<BillingUpgradeRequest>, property: string): string {
    const relation = repo.metadata.findRelationWithPropertyPath(property);
    const column = relation?.joinColumns[0]?.databaseName;
    if (!column) {
      throw new Error(`${repo.metadata.name}.${property} has no join column`);
    }
    return column;
  }

  async get(tenantId: string, id: string) {
    const request = await this.findOwned(tenantId, id);
    const events = await this.history.listVisible(id);
    return { ...request, events };
  }

  async cancel(tenantId: string, id: string, actor: BillingUpgradeActor): Promise<BillingUpgradeRequest> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BillingUpgradeRequest);
      const request = await repo.findOne({
        where: { id, tenant: { id: tenantId } },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Request not found' });
      }
      if (!OWNER_CANCELLABLE_STATUSES.includes(request.status as BillingUpgradeStatus)) {
        throw new AppError(ErrorCode.INVALID_REQUEST_STATUS, {
          message: `Request cannot be cancelled from status "${request.status}"`,
        });
      }
      const fromStatus = request.status;
      request.status = BILLING_UPGRADE_STATUS.CANCELLED;
      request.cancelled_at = new Date();
      const saved = await repo.save(request);
      await this.history.record(
        {
          requestId: saved.id,
          type: BILLING_UPGRADE_EVENT_TYPE.STATUS_CHANGED,
          fromValue: fromStatus,
          toValue: BILLING_UPGRADE_STATUS.CANCELLED,
          actorId: actor.id,
          actorName: actor.email,
        },
        manager,
      );
      return saved;
    });
  }

  /**
   * Accept the super admin's quote and start payment. Re-validates status,
   * quote expiry, and the final price INSIDE a locked transaction (never
   * trusts anything from the client — there is nothing financial in the
   * request body at all). The actual gateway call happens AFTER that
   * transaction commits (never holding a row lock across a network call —
   * matches PaymentService.confirm()'s lock→verify→lock pattern).
   */
  async accept(tenantId: string, id: string, actor: BillingUpgradeActor): Promise<AcceptBillingUpgradeResult> {
    const phase = await this.dataSource.transaction<AcceptPhaseResult>(async (manager) => {
      const repo = manager.getRepository(BillingUpgradeRequest);
      // Lock first, join after: FOR UPDATE + a LEFT JOINed `payment` is refused by
      // Postgres. The payment is only needed on the resume branch below.
      const request = await lockRequest(manager, { id, tenant: { id: tenantId } });
      if (!request) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Request not found' });
      }

      if (TERMINAL_BILLING_UPGRADE_STATUSES.includes(request.status as BillingUpgradeStatus)) {
        return { action: 'invalid', request };
      }
      if (request.status === BILLING_UPGRADE_STATUS.PENDING_REVIEW) {
        return { action: 'not_quoted', request };
      }
      if (request.status === BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING) {
        // Already accepted and in flight — repeated-approval / double-click
        // guard. If a prior attempt crashed before linking a payment, resume
        // it (charge) instead of rejecting the owner outright.
        const withPayment = await repo.findOne({
          where: { id: request.id },
          relations: { payment: true },
        });
        if (withPayment?.payment) request.payment = withPayment.payment;
        return request.payment ? { action: 'resume', request } : { action: 'charge', request };
      }

      // AWAITING_OWNER_APPROVAL or PAYMENT_FAILED only, from here.
      if (!request.final_price_minor) {
        return { action: 'not_quoted', request };
      }
      if (request.quote_expires_at && request.quote_expires_at.getTime() < Date.now()) {
        request.status = BILLING_UPGRADE_STATUS.EXPIRED;
        const saved = await repo.save(request);
        return { action: 'expired', request: saved };
      }

      const fromStatus = request.status;
      request.owner_approved_at = request.owner_approved_at ?? new Date();
      request.status = BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING;
      const saved = await repo.save(request);
      await this.history.record(
        {
          requestId: saved.id,
          type: BILLING_UPGRADE_EVENT_TYPE.STATUS_CHANGED,
          fromValue: fromStatus,
          toValue: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
          actorId: actor.id,
          actorName: actor.email,
        },
        manager,
      );
      return { action: 'charge', request: saved };
    });

    if (phase.action === 'invalid') {
      throw new AppError(ErrorCode.INVALID_REQUEST_STATUS, {
        message: `Request cannot be accepted from status "${phase.request.status}"`,
      });
    }
    if (phase.action === 'not_quoted') {
      throw new AppError(ErrorCode.REQUEST_NOT_QUOTED);
    }
    if (phase.action === 'expired') {
      throw new AppError(ErrorCode.QUOTE_EXPIRED);
    }
    if (phase.action === 'resume') {
      const payment = phase.request.payment!;
      return {
        request: phase.request,
        redirectUrl: (payment.metadata as Record<string, unknown> | undefined)?.redirect_url as
          | string
          | undefined,
        paymentStatus: payment.status,
      };
    }

    // action === 'charge': create the payment OUTSIDE any lock (network call).
    // `purpose: BILLING_UPGRADE` (Phase 1.5 plan §12; Tap Phase 2) — this
    // charge is the clinic paying the PLATFORM for a plan/feature upgrade, not
    // a patient/customer payment, so it must never require the clinic's own
    // merchant-onboarding approval, must never carry a marketplace split
    // (which would incorrectly route platform revenue back to the clinic's
    // own gateway recipient), and is recorded as platform revenue so no clinic
    // settlement can ever claim it.
    const { payment, redirectUrl } = await this.payments.create(
      tenantId,
      {
        amount: this.minorToMajor(Number(phase.request.final_price_minor)),
        currency: phase.request.currency,
        description: this.paymentDescription(phase.request),
        idempotencyKey: randomUUID(),
      },
      { purpose: PAYMENT_PURPOSE.BILLING_UPGRADE },
    );

    // Race-safe link: only the first concurrent "charge" attempt (e.g. a
    // client retry after a crash before linking) wins — mirrors
    // FreeAccessOverrideService's raw conditional-UPDATE idiom.
    const linkRes = await this.dataSource.query(
      `UPDATE billing_upgrade_requests
       SET "paymentId" = $1, payment_reference = $2, updated_at = now()
       WHERE id = $3 AND "paymentId" IS NULL`,
      [payment.id, payment.gateway_payment_id ?? null, phase.request.id],
    );
    const linked = Array.isArray(linkRes) ? linkRes[1] : (linkRes as { rowCount?: number })?.rowCount;

    const finalRequest = await this.requests.findOne({
      where: { id: phase.request.id },
      relations: { payment: true },
    });
    if (!linked) {
      // Lost the race — another attempt's payment is already linked; surface
      // its info instead of the (now-orphaned) payment we just created.
      const winnerPayment = finalRequest?.payment;
      return {
        request: finalRequest!,
        redirectUrl: (winnerPayment?.metadata as Record<string, unknown> | undefined)?.redirect_url as
          | string
          | undefined,
        paymentStatus: winnerPayment?.status,
      };
    }
    return { request: finalRequest!, redirectUrl, paymentStatus: payment.status };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async findOwned(tenantId: string, id: string): Promise<BillingUpgradeRequest> {
    const request = await this.requests.findOne({ where: { id, tenant: { id: tenantId } } });
    if (!request) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Request not found' });
    }
    return request;
  }

  private async assertRequestableFeature(tenantId: string, featureKey: string): Promise<void> {
    const def = await this.featureDefinitions.findOne({
      where: { feature_key: featureKey, is_active: true },
    });
    if (!def) {
      throw new AppError(ErrorCode.INVALID_UPGRADE_METRIC, {
        message: `Unknown feature key "${featureKey}"`,
        publicContext: { featureKey },
      });
    }
    const alreadyEnabled = await this.featureFlags.isEnabled(tenantId, featureKey);
    if (alreadyEnabled) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This feature is already enabled for your clinic',
        publicContext: { featureKey },
      });
    }
  }

  private async snapshotUsageTarget(
    tenantId: string,
    metric: UsageMetric,
    requestedQuantity: number,
  ): Promise<{ currentUsage: number; currentLimit: number }> {
    const key = USAGE_METRIC_BREAKDOWN_KEY[metric];
    if (!key) {
      throw new AppError(ErrorCode.INVALID_UPGRADE_METRIC, {
        message: `Unknown usage metric "${metric}"`,
        publicContext: { metric },
      });
    }
    const breakdown = await this.usage.getBreakdown(tenantId);
    const line = breakdown.metrics[key];
    if (line.limit === null) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This usage metric is already unlimited on your plan',
        publicContext: { metric },
      });
    }
    if (requestedQuantity <= line.limit) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Requested quantity must exceed your current plan limit',
        publicContext: { metric, currentLimit: line.limit, requestedQuantity },
      });
    }
    return { currentUsage: line.used, currentLimit: line.limit };
  }

  private paymentDescription(request: BillingUpgradeRequest): string {
    return request.type === BILLING_UPGRADE_TYPE.FEATURE
      ? `Billing upgrade: enable feature "${request.feature_key}"`
      : `Billing upgrade: raise ${request.usage_metric} limit to ${request.approved_quantity}`;
  }

  /** Payment.amount is major-unit decimal(14,2); this entity stores minor units. One conversion, at this single boundary. */
  private minorToMajor(minor: number): number {
    return Math.round(minor) / 100;
  }
}
