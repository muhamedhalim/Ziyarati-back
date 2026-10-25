import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import {
  InvoiceStatus,
  SubscriptionInvoiceKind,
  SubscriptionStatus,
} from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { BillingService } from './billing.service';
import { BillingModeService } from './billing-mode.service';
import { computeNextPeriodEnd } from './subscription-period.util';
import {
  effectiveSubscriptionStatus,
  resolveGraceDays,
} from './subscription-status';
import { AccessControlService } from './access-control.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import {
  SubscriptionActivatedEvent,
  SubscriptionCancelledEvent,
  SubscriptionPlanChangedEvent,
  SubscriptionReactivatedEvent,
  SubscriptionTrialStartedEvent,
} from '../../events/subscription.events';

/**
 * Effective (computed) status. FND-031: previously this bolted on a separate
 * 'EXPIRED' string for "ACTIVE/TRIAL past ends_at" — that WAS the silent-lapse
 * bug (a tenant past its end date became unusable forever, with no grace, no
 * notice, no path back). It now live-derives straight into the real
 * PAST_DUE/GRACE_EXPIRED enum values the state machine defines, so a
 * subscription whose column hasn't been swept yet by the background
 * transition job (`subscriptions.processor.ts`) is still treated exactly as
 * if it had been — never a race between "what the column says" and
 * "what's actually true".
 */
export type EffectiveStatus = SubscriptionStatus;

/**
 * FND-031/T086 — the three access states named in the finding/spec, additive
 * to (never replacing or translating) the underlying `status` enum (LG-10).
 * `pending-payment` (Tap migration D2): a paid subscription whose first payment
 * has not been captured yet — NOT usable, and not a lapse.
 */
export type AccessState =
  | 'active'
  | 'expired-in-grace'
  | 'grace-expired'
  | 'terminal'
  | 'pending-payment';

/** The one invoice a clinic can pay right now, as the billing page needs it. */
export interface OpenInvoiceSummary {
  id: string;
  /** What it buys (`SubscriptionInvoiceKind`), or null for a legacy invoice. */
  kind: string | null;
  amount: string;
  currency: string;
}

export interface SubscriptionView {
  subscription: Subscription;
  effectiveStatus: EffectiveStatus;
  isUsable: boolean;
  /** Additive — FND-031/T086. Never derived by the client from `status` (LG-10: machine values are never translated). */
  accessState: AccessState;
  /** Additive — FND-031/T086. Null unless currently in `expired-in-grace` (PAST_DUE). */
  graceEndsAt: Date | null;
  /** Tap D4 — the plan a scheduled downgrade will switch to at the next renewal. */
  pendingPlan?: SubscriptionPlan | null;
  /** Tap D2 — the OPEN invoice to pay (initial payment, upgrade, renewal), if any. */
  openInvoice?: OpenInvoiceSummary | null;
}

/**
 * How a plan change took effect.
 *  - `switched`   — applied immediately (no payment involved: legacy provider, or a free plan);
 *  - `checkout`   — an invoice was issued; the plan switches ONLY when it is paid;
 *  - `scheduled`  — a downgrade, applied at the next renewal (`effectiveAt`);
 *  - `cleared`    — re-selecting the current plan cancelled a scheduled downgrade.
 */
export type PlanChangeMode = 'switched' | 'checkout' | 'scheduled' | 'cleared';

export interface ChangePlanResult extends SubscriptionView {
  mode: PlanChangeMode;
  invoiceId?: string;
  effectiveAt?: Date;
}

/**
 * Subscription lifecycle.
 *
 * Tenant isolation: `subscriptions` is tenant-scoped via the `tenant` relation,
 * so every query filters `where: { tenant: { id: tenantId } }`. The tenant is
 * always taken from the authenticated principal.
 *
 * Note on states: the enum is TRIAL | ACTIVE | PAST_DUE | CANCELLED | SUSPENDED
 * (+ GRACE_EXPIRED, PENDING_PAYMENT). There is no persisted EXPIRED — "expired"
 * is DERIVED when an otherwise-active subscription's `ends_at` is in the past
 * (see `getEffectiveStatus`).
 *
 * Payment rules (Tap migration, decisions D2/D4). They apply ONLY when the bound
 * provider can take a checkout (`BillingService.supportsCheckout`); with none
 * (the production stand-in, the dev stub) every flow below keeps its legacy
 * behaviour, so nothing is ever locked behind a payment that cannot be made.
 *  - a paid subscription starts PENDING_PAYMENT and becomes ACTIVE only when its
 *    first invoice is paid (`InvoiceSettlementService`);
 *  - an upgrade (or trial -> paid) issues an invoice and switches the plan ONLY
 *    when it is paid;
 *  - a downgrade is scheduled for the next renewal (`pending_plan`), no charge;
 *  - nothing is prorated.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionPlan)
    private readonly plans: Repository<SubscriptionPlan>,
    private readonly billing: BillingService,
    private readonly access: AccessControlService,
    private readonly platformSettings: SystemSettingService,
    private readonly emitter: EventEmitter2,
    private readonly config: ConfigService,
    @Optional() private readonly billingMode?: BillingModeService,
  ) {}

  // ───────────────────────────── Plans ───────────────────────────────────── //

  /** Active plans available to subscribe to (global catalogue, not tenant-scoped). */
  listPlans(): Promise<SubscriptionPlan[]> {
    return this.plans.find({
      where: { is_active: true },
      order: { price: 'ASC' },
    });
  }

  async getPlan(id: string): Promise<SubscriptionPlan> {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Plan not found' });
    }
    return plan;
  }

  // ─────────────────────────── Subscription ──────────────────────────────── //

  async create(
    tenantId: string,
    dto: CreateSubscriptionDto,
  ): Promise<SubscriptionView> {
    const plan = await this.getActivePlan(dto.planId);

    const existing = await this.subscriptions.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
    });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This tenant already has an active subscription',
      });
    }

    if (dto.startTrial) {
      // FIN-005: one trial per tenant. A cancelled subscription no longer blocks
      // creating a new one, so cancel → create could restart the trial forever.
      // Derived from history (including soft-deleted rows), so it also covers
      // tenants that trialled before this rule existed — no new column.
      const previous = await this.subscriptions.count({
        where: { tenant: { id: tenantId } },
        withDeleted: true,
      });
      if (previous > 0) {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            'A free trial has already been used by this tenant. Please choose a plan.',
        });
      }
    } else {
      await this.assertPaidPlanChargeable(plan);
    }

    const startsAt = new Date();
    let endsAt: Date;
    let status: SubscriptionStatus;
    // D2 — a PAID plan waits for its payment, but only where a payment can be taken.
    const awaitsPayment =
      !dto.startTrial && this.isPaid(plan) && this.billing.supportsCheckout;

    if (dto.startTrial) {
      const trialDays = await this.platformSettings.getTyped<number>(
        SettingKey.TRIAL_DURATION_DAYS,
      );
      endsAt = new Date(startsAt.getTime() + trialDays * 86_400_000);
      status = SubscriptionStatus.TRIAL;
    } else {
      // For PENDING_PAYMENT these dates are provisional: settling the invoice
      // restarts the period from the moment of payment.
      endsAt = computeNextPeriodEnd(startsAt, plan);
      status = awaitsPayment
        ? SubscriptionStatus.PENDING_PAYMENT
        : SubscriptionStatus.ACTIVE;
    }

    const subscription = await this.subscriptions.save(
      this.subscriptions.create({
        tenant: { id: tenantId } as Tenant,
        plan: { id: plan.id } as SubscriptionPlan,
        status,
        starts_at: startsAt,
        ends_at: endsAt,
        auto_renew: dto.autoRenew ?? true,
      }),
    );

    // Issue the first invoice for paid (non-trial) subscriptions.
    if (status !== SubscriptionStatus.TRIAL) {
      try {
        const currency = await this.platformSettings.getTyped<string>(
          SettingKey.DEFAULT_CURRENCY,
        );
        await this.billing.generateInvoice(
          tenantId,
          subscription.id,
          Number(plan.price),
          startsAt,
          endsAt,
          currency,
          InvoiceStatus.OPEN,
          awaitsPayment
            ? {
                kind: SubscriptionInvoiceKind.INITIAL,
                targetPlanId: plan.id,
                provider: this.billing.providerName,
              }
            : {},
        );
      } catch (err) {
        // FIN-S8: never leave a subscription without its invoice — a PENDING one
        // would have nothing to pay for a week. The row was created a moment ago
        // and nothing else references it yet.
        await this.subscriptions
          .delete({ id: subscription.id })
          .catch(() => undefined);
        throw err;
      }
    }

    // The tenant just moved from "no subscription" to a subscription — every
    // cached capability decision for it is now wrong in BOTH directions
    // (previously-denied features open, and previously-unmetered ones become
    // PLAN_ENFORCED).
    this.access.invalidate(tenantId);

    const view = await this.withBilling(
      this.view(await this.loadWithPlan(tenantId, subscription.id)),
    );

    if (status === SubscriptionStatus.TRIAL) {
      this.emitter.emit(
        SubscriptionTrialStartedEvent.eventName,
        new SubscriptionTrialStartedEvent(
          tenantId,
          subscription.id,
          plan.id,
          endsAt,
        ),
      );
    } else if (status === SubscriptionStatus.ACTIVE) {
      this.emitter.emit(
        SubscriptionActivatedEvent.eventName,
        new SubscriptionActivatedEvent(tenantId, subscription.id, plan.id),
      );
    }
    // PENDING_PAYMENT: nothing is activated yet — the settle path emits
    // SubscriptionActivatedEvent when the first invoice is paid.

    return view;
  }

  /**
   * The tenant's current subscription (most recent, non-deleted) + computed
   * status.
   *
   * T046 (015-db-api-efficiency-audit, P7-2/ORM-001): same fix as T045 —
   * `findOne` unconditionally sets `take: 1` internally (research.md R-01),
   * so the `relations: { plan: true }` join here cost 2 round trips. `plan`
   * stays a real `leftJoinAndSelect` (its columns are read by `this.view()`),
   * the tenant filter moves to the FK column resolved from entity metadata
   * (R-11), and `.limit(1)` replaces the implicit `take: 1` (R-10). The
   * hand-written `deleted_at IS NULL` is dropped — `Subscription` has
   * `@DeleteDateColumn`, so the query builder injects the identical
   * predicate for the main alias automatically.
   */
  async getCurrent(tenantId: string): Promise<SubscriptionView> {
    const tenantFk = this.fk(this.subscriptions, 'tenant');
    const subscription = await this.subscriptions
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.plan', 'plan')
      .leftJoinAndSelect('s.pending_plan', 'pending_plan')
      .where(`s."${tenantFk}" = :tenantId`, { tenantId })
      .orderBy('s.created_at', 'DESC')
      .limit(1)
      .getOne();
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No subscription found for this tenant',
      });
    }
    return this.withBilling(this.view(subscription));
  }

  async changePlan(
    tenantId: string,
    dto: ChangePlanDto,
  ): Promise<ChangePlanResult> {
    const current = await this.getActiveSubscription(tenantId);
    if (current.plan.id === dto.planId) {
      // Re-selecting the current plan withdraws a scheduled downgrade; with
      // nothing scheduled it is still the same conflict as before.
      if (current.pending_plan) {
        // Only while it is still the downgrade the clinic saw (not yet applied).
        const written = await this.patch(
          current,
          { pending_plan: null },
          { plan: true, pendingPlan: true },
        );
        if (!written) throw this.changedMeanwhile();
        const view = await this.withBilling(
          this.view(await this.loadWithPlan(tenantId, current.id)),
        );
        return { ...view, mode: 'cleared' };
      }
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'The subscription is already on this plan',
      });
    }
    const newPlan = await this.getActivePlan(dto.planId);

    if (!this.billing.supportsCheckout) {
      await this.assertPaidPlanChargeable(newPlan);
      return this.changePlanImmediately(tenantId, current, newPlan);
    }
    return this.changePlanWithPayment(tenantId, current, newPlan);
  }

  async cancel(
    tenantId: string,
    dto: CancelSubscriptionDto,
  ): Promise<SubscriptionView> {
    const current = await this.getActiveSubscription(tenantId);

    const neverPaid = current.status === SubscriptionStatus.PENDING_PAYMENT;
    // FIN-S1: a clinic that is paying right now must not have its invoice voided
    // under the hosted page — the money would be captured and then not booked.
    if (neverPaid) await this.assertNoLivePaymentOnOpenInvoice(current.id);
    const immediate = neverPaid || !dto.cancelAtPeriodEnd;
    if (!immediate && !current.auto_renew) {
      // Already set to end at period end: nothing to change, nothing to announce.
      return this.withBilling(
        this.view(await this.loadWithPlan(tenantId, current.id)),
      );
    }
    if (immediate) {
      // Immediate cancellation. A subscription that was never paid has no period
      // to keep, so "at period end" would only leave it stuck PENDING_PAYMENT.
      // Nothing is left for a scheduled downgrade to apply to. Only while the
      // status is still the one read: a payment that just activated it wins.
      const written = await this.patch(
        current,
        {
          auto_renew: false,
          status: SubscriptionStatus.CANCELLED,
          pending_plan: null,
        },
        { status: true },
      );
      if (!written) throw this.changedMeanwhile();
      current.status = SubscriptionStatus.CANCELLED;
    } else {
      // At period end only auto-renew changes: status/access stay until ends_at,
      // and a scheduled downgrade is KEPT — it still takes effect at ends_at
      // (`ScheduledPlanChangeService`), and turning auto-renew back on has the
      // renewal bill it as before.
      await this.patch(current, { auto_renew: false });
    }
    current.auto_renew = false;
    if (neverPaid) {
      // Nothing to collect any more; a payment that still arrives for the voided
      // invoice is not booked and raises an ALERT in the settle path.
      // Conditional void: a checkout opened since the check above keeps its
      // invoice (a capture on it is then flagged for review, never lost).
      await this.billing.voidSupersededOpenInvoices(
        current.id,
        'Subscription cancelled before payment',
        'all',
      );
    }
    if (!neverPaid && current.status === SubscriptionStatus.CANCELLED) {
      // Immediate cancellation of a paid subscription: its unpaid invoices (an open
      // renewal, say) have nothing left to apply to. Only the ones nobody is paying
      // right now — a live checkout / unresolved charge keeps its invoice.
      await this.billing.voidSupersededOpenInvoices(
        current.id,
        'Subscription cancelled',
        'all',
      );
    }
    // An immediate cancellation must stop access now, not at the next TTL.
    this.access.invalidate(tenantId);

    const view = await this.withBilling(
      this.view(await this.loadWithPlan(tenantId, current.id)),
    );
    this.emitter.emit(
      SubscriptionCancelledEvent.eventName,
      new SubscriptionCancelledEvent(
        tenantId,
        current.id,
        neverPaid ? false : (dto.cancelAtPeriodEnd ?? false),
      ),
    );
    return view;
  }

  async reactivate(tenantId: string): Promise<SubscriptionView> {
    const subscription = await this.subscriptions.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      relations: { plan: true, pending_plan: true },
      order: { created_at: 'DESC' },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No subscription found for this tenant',
      });
    }
    if (subscription.status === SubscriptionStatus.ACTIVE) {
      return this.resumeAutoRenew(tenantId, subscription);
    }

    if (!this.billing.supportsCheckout || !this.isPaid(subscription.plan)) {
      await this.assertPaidPlanChargeable(subscription.plan);
      return this.reactivateImmediately(tenantId, subscription);
    }
    return this.reactivateWithPayment(tenantId, subscription);
  }

  // ─────────────────── Cross-module access validation ────────────────────── //

  /**
   * Computes the effective status, live-deriving past the raw column when the
   * background transition sweep (`subscriptions.processor.ts`) hasn't caught
   * up yet: ACTIVE/TRIAL past `ends_at` reads as PAST_DUE; PAST_DUE whose
   * grace window (from `grace_started_at` + `graceDurationDays`) has elapsed
   * reads as GRACE_EXPIRED. CANCELLED/SUSPENDED (terminal), an
   * already-GRACE_EXPIRED row and PENDING_PAYMENT (whose dates are provisional
   * until it is paid) pass through unchanged.
   */
  getEffectiveStatus(
    subscription: Subscription,
    graceDurationDays: number = resolveGraceDays(this.config),
  ): EffectiveStatus {
    return effectiveSubscriptionStatus(subscription, graceDurationDays);
  }

  /**
   * Read access is preserved in EVERY non-terminal state (FR-B007d) — only
   * CANCELLED/SUSPENDED, and a subscription that has not been paid for yet
   * (PENDING_PAYMENT), are not usable. Distinct from
   * `assertBillableActionAllowed`, which is the narrower, write-specific gate.
   */
  isUsable(subscription: Subscription, graceDurationDays?: number): boolean {
    const effective = this.getEffectiveStatus(subscription, graceDurationDays);
    return (
      effective !== SubscriptionStatus.CANCELLED &&
      effective !== SubscriptionStatus.SUSPENDED &&
      effective !== SubscriptionStatus.PENDING_PAYMENT
    );
  }

  /**
   * FND-031/FR-B007 — throws once a subscription is GRACE_EXPIRED. Callers
   * are the same call sites FND-034 already gates (appointments, campaigns,
   * WhatsApp sends, AI turns) plus any other billable/state-mutating action —
   * read-only endpoints must NEVER call this.
   */
  async assertBillableActionAllowed(tenantId: string): Promise<void> {
    const subscription = await this.subscriptions.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      order: { created_at: 'DESC' },
    });
    if (!subscription) return; // no subscription at all is AccessControlService's concern, not this gate's
    if (
      this.getEffectiveStatus(subscription) === SubscriptionStatus.GRACE_EXPIRED
    ) {
      throw new AppError(ErrorCode.SUBSCRIPTION_GRACE_EXPIRED);
    }
  }

  // NOTE: a pass-through `assertUsable(tenantId)` used to live here, delegating
  // to `AccessControlService`. It had no callers, and as a tenant-WIDE check it
  // could never carry the capability a route was gating — so anything that did
  // adopt it would have re-introduced exactly the split this work removed
  // (admitted by the guard, refused here). Gate on `AccessControlService`
  // directly, with the FeatureKey in hand.

  // ───────────────────────── Plan change: no payment ─────────────────────── //

  /**
   * Legacy behaviour (no provider can take a checkout): the plan switches at
   * once and an invoice for the new price is issued.
   *
   * The old code issued that invoice for the SAME period as the subscription's
   * existing one, which `UQ_sub_invoice_period` (and the one-OPEN-invoice index)
   * rejects — a second plan change in a period was a 500. The superseded OPEN
   * invoice is now voided and the change invoice starts at the moment of change.
   */
  private async changePlanImmediately(
    tenantId: string,
    current: Subscription,
    newPlan: SubscriptionPlan,
  ): Promise<ChangePlanResult> {
    current.plan = { id: newPlan.id } as SubscriptionPlan;
    current.status = SubscriptionStatus.ACTIVE;
    current.pending_plan = null;
    await this.subscriptions.save(current);
    // Plan entitlement (`feature_plans`) and every plan limit are keyed off the
    // plan id that just changed.
    this.access.invalidate(tenantId);

    await this.billing.voidOpenInvoices(
      current.id,
      'Superseded by a plan change',
    );
    // Proration is abstracted: issue an invoice for the new plan price.
    const now = new Date();
    const currency = await this.platformSettings.getTyped<string>(
      SettingKey.DEFAULT_CURRENCY,
    );
    await this.billing.generateInvoice(
      tenantId,
      current.id,
      Number(newPlan.price),
      now,
      current.ends_at > now
        ? current.ends_at
        : computeNextPeriodEnd(now, newPlan),
      currency,
    );

    const view = await this.withBilling(
      this.view(await this.loadWithPlan(tenantId, current.id)),
    );
    this.emitter.emit(
      SubscriptionPlanChangedEvent.eventName,
      new SubscriptionPlanChangedEvent(tenantId, current.id, newPlan.id),
    );
    return { ...view, mode: 'switched' };
  }

  // ───────────────────────── Plan change: with payment ───────────────────── //

  private async changePlanWithPayment(
    tenantId: string,
    current: Subscription,
    newPlan: SubscriptionPlan,
  ): Promise<ChangePlanResult> {
    if (current.status === SubscriptionStatus.SUSPENDED) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This subscription is suspended — contact support',
      });
    }
    // A free plan needs no payment: switch at once (nothing to charge).
    if (!this.isPaid(newPlan)) {
      return this.switchToFreePlan(tenantId, current, newPlan);
    }

    // Not paid for yet: choosing another plan just re-quotes the first invoice.
    if (current.status === SubscriptionStatus.PENDING_PAYMENT) {
      return this.requoteUnpaid(tenantId, current, newPlan);
    }

    const currentPrice = Number(current.plan.price);
    const newPrice = Number(newPlan.price);
    const isUpgrade =
      current.status === SubscriptionStatus.TRIAL || newPrice > currentPrice;

    if (isUpgrade) {
      return this.issueUpgrade(tenantId, current, newPlan);
    }

    // Downgrade (or same price): no charge now; it takes effect at the next renewal.
    // Decided against the plan and status read above: if a payment changed them
    // meanwhile, this comparison is stale and the clinic must decide again.
    const written = await this.patch(
      current,
      { pending_plan: { id: newPlan.id } as SubscriptionPlan },
      { plan: true, status: true },
    );
    if (!written) throw this.changedMeanwhile();
    const view = await this.withBilling(
      this.view(await this.loadWithPlan(tenantId, current.id)),
    );
    return { ...view, mode: 'scheduled', effectiveAt: current.ends_at };
  }

  /** Upgrade (or trial -> paid): an invoice is issued and the plan switches ONLY when it is paid. */
  private async issueUpgrade(
    tenantId: string,
    current: Subscription,
    newPlan: SubscriptionPlan,
  ): Promise<ChangePlanResult> {
    const open = await this.billing.findOpenInvoice(current.id);
    if (open) {
      const sameQuote =
        open.kind === SubscriptionInvoiceKind.UPGRADE &&
        open.target_plan_id === newPlan.id;
      if (sameQuote) {
        // The clinic clicked again: hand back the invoice that is already open.
        const view = await this.withBilling(
          this.view(await this.loadWithPlan(tenantId, current.id)),
        );
        return { ...view, mode: 'checkout', invoiceId: open.id };
      }
      // A hosted checkout was opened on it: what Tap says about that charge
      // decides, not our checkout timer — a captured charge is booked (never
      // voided under the payer), a dead one stops counting as in flight.
      const hosted = await this.billing.reconcileHostedCheckout(open);
      if (hosted === 'paid') {
        // That payment may itself have changed the plan or the period: decide
        // again from what is now true.
        const fresh = await this.loadWithPlan(tenantId, current.id);
        if (fresh.plan.id === newPlan.id) {
          const view = await this.withBilling(this.view(fresh));
          return { ...view, mode: 'switched' };
        }
        return this.changePlanWithPayment(tenantId, fresh, newPlan);
      }

      // An invoice that bills a real period (a renewal, a first payment, a
      // reactivation) is money owed: it is paid first, whatever auto-renew says.
      // Only an upgrade quote or a legacy invoice (kind NULL — which settles as
      // nothing and which the renewal sweep itself supersedes) may be replaced.
      const supersedable =
        open.kind == null || open.kind === SubscriptionInvoiceKind.UPGRADE;
      if (!supersedable) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'Pay the open invoice before changing your plan',
          publicContext: { invoiceId: open.id, kind: open.kind },
        });
      }
      if (hosted === 'pending' || this.billing.isPaymentInFlight(open)) {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            'A payment for the open invoice is in progress — finish it or try again shortly',
          publicContext: { invoiceId: open.id, kind: open.kind },
        });
      }
      // Atomic: voids only while still nobody is paying it.
      const voided = await this.billing.voidSupersededOpenInvoices(
        current.id,
        'Superseded by a new plan quote',
      );
      if (voided === 0) {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            'A payment for the open invoice is in progress — finish it or try again shortly',
          publicContext: { invoiceId: open.id, kind: open.kind },
        });
      }
    }

    const now = new Date();
    const currency = await this.platformSettings.getTyped<string>(
      SettingKey.DEFAULT_CURRENCY,
    );
    const invoice = await this.billing.generateInvoice(
      tenantId,
      current.id,
      Number(newPlan.price),
      now,
      computeNextPeriodEnd(now, newPlan),
      currency,
      InvoiceStatus.OPEN,
      {
        kind: SubscriptionInvoiceKind.UPGRADE,
        targetPlanId: newPlan.id,
        provider: this.billing.providerName,
      },
    );
    const view = await this.withBilling(
      this.view(await this.loadWithPlan(tenantId, current.id)),
    );
    return { ...view, mode: 'checkout', invoiceId: invoice.id };
  }

  /** PENDING_PAYMENT: nothing is paid, so another plan simply replaces the unpaid quote. */
  private async requoteUnpaid(
    tenantId: string,
    current: Subscription,
    newPlan: SubscriptionPlan,
  ): Promise<ChangePlanResult> {
    const open = await this.billing.findOpenInvoice(current.id);
    if (open && this.billing.isPaymentInFlight(open)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A payment for this subscription is already in progress',
      });
    }
    const kind =
      open?.kind === SubscriptionInvoiceKind.REACTIVATION
        ? SubscriptionInvoiceKind.REACTIVATION
        : SubscriptionInvoiceKind.INITIAL;
    await this.voidIdleOpenInvoices(
      current.id,
      'Superseded by a new plan quote',
    );

    const now = new Date();
    const endsAt = computeNextPeriodEnd(now, newPlan);
    // Still unpaid? A first payment that landed meanwhile has activated it.
    const written = await this.patch(
      current,
      {
        plan: { id: newPlan.id } as SubscriptionPlan,
        starts_at: now,
        ends_at: endsAt,
      },
      { status: true },
    );
    if (!written) throw this.changedMeanwhile();

    const currency = await this.platformSettings.getTyped<string>(
      SettingKey.DEFAULT_CURRENCY,
    );
    const invoice = await this.billing.generateInvoice(
      tenantId,
      current.id,
      Number(newPlan.price),
      now,
      endsAt,
      currency,
      InvoiceStatus.OPEN,
      {
        kind,
        targetPlanId: newPlan.id,
        provider: this.billing.providerName,
      },
    );
    this.access.invalidate(tenantId);
    const view = await this.withBilling(
      this.view(await this.loadWithPlan(tenantId, current.id)),
    );
    return { ...view, mode: 'checkout', invoiceId: invoice.id };
  }

  /** A free plan takes effect at once: there is nothing to charge. */
  private async switchToFreePlan(
    tenantId: string,
    current: Subscription,
    newPlan: SubscriptionPlan,
  ): Promise<ChangePlanResult> {
    const now = new Date();
    await this.billing.voidOpenInvoices(
      current.id,
      'Superseded by a plan change',
    );
    // Only from the plan and status read: a paid upgrade that settled meanwhile
    // must not be thrown away for a free plan the clinic picked from stale data.
    const written = await this.patch(
      current,
      {
        plan: { id: newPlan.id } as SubscriptionPlan,
        status: SubscriptionStatus.ACTIVE,
        starts_at: now,
        ends_at: computeNextPeriodEnd(now, newPlan),
        pending_plan: null,
        grace_started_at: null,
        grace_expired_at: null,
      },
      { plan: true, status: true },
    );
    if (!written) throw this.changedMeanwhile();
    this.access.invalidate(tenantId);

    const view = await this.withBilling(
      this.view(await this.loadWithPlan(tenantId, current.id)),
    );
    this.emitter.emit(
      SubscriptionPlanChangedEvent.eventName,
      new SubscriptionPlanChangedEvent(tenantId, current.id, newPlan.id),
    );
    return { ...view, mode: 'switched' };
  }

  // ───────────────────────────── Reactivation ────────────────────────────── //

  /**
   * ACTIVE with auto-renew off (cancel at period end): turning auto-renew back
   * on. The running period is already paid — the same rule as a CANCELLED
   * subscription resumed inside its period — so nothing is charged and no
   * invoice is issued; the renewal job bills the next period once it is due,
   * exactly as for any auto-renewing subscription (`UQ_sub_invoice_period`
   * keeps that to one invoice). A scheduled downgrade is kept: that renewal
   * bills it.
   *
   * Guarded UPDATE, so a double click (or two tabs) resumes it once; the loser,
   * like a subscription that never stopped renewing, gets the old 409.
   */
  private async resumeAutoRenew(
    tenantId: string,
    subscription: Subscription,
  ): Promise<SubscriptionView> {
    const res = subscription.auto_renew
      ? { affected: 0 }
      : await this.subscriptions
          .createQueryBuilder()
          .update(Subscription)
          .set({ auto_renew: true })
          .where('id = :id AND auto_renew = false AND status = :active', {
            id: subscription.id,
            active: SubscriptionStatus.ACTIVE,
          })
          .execute();
    if (!res.affected) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'Subscription is already active',
      });
    }
    subscription.auto_renew = true;
    this.access.invalidate(tenantId);
    this.emitter.emit(
      SubscriptionReactivatedEvent.eventName,
      new SubscriptionReactivatedEvent(tenantId, subscription.id),
    );
    return this.withBilling(
      this.view(await this.loadWithPlan(tenantId, subscription.id)),
    );
  }

  /** Legacy behaviour: straight back to ACTIVE, with a fresh period if it had lapsed. */
  private async reactivateImmediately(
    tenantId: string,
    subscription: Subscription,
  ): Promise<SubscriptionView> {
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.auto_renew = true;
    if (subscription.ends_at < new Date()) {
      subscription.starts_at = new Date();
      subscription.ends_at = computeNextPeriodEnd(
        subscription.starts_at,
        subscription.plan,
      );
    }
    await this.subscriptions.save(subscription);
    this.access.invalidate(tenantId);

    this.emitter.emit(
      SubscriptionReactivatedEvent.eventName,
      new SubscriptionReactivatedEvent(tenantId, subscription.id),
    );
    return this.withBilling(this.view(subscription));
  }

  /**
   * D2 for a returning clinic. A period that is still paid resumes at once; a
   * lapsed one must be paid for again — through a REACTIVATION invoice — before
   * the subscription is ACTIVE.
   */
  private async reactivateWithPayment(
    tenantId: string,
    subscription: Subscription,
  ): Promise<SubscriptionView> {
    const status = subscription.status;
    if (
      status === SubscriptionStatus.SUSPENDED ||
      status === SubscriptionStatus.TRIAL
    ) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          status === SubscriptionStatus.SUSPENDED
            ? 'This subscription is suspended — contact support'
            : 'A trial is not reactivated — choose a plan instead',
      });
    }
    const reload = async () =>
      this.withBilling(
        this.view(await this.loadWithPlan(tenantId, subscription.id)),
      );

    // Already waiting on its first payment: hand the same invoice back.
    if (status === SubscriptionStatus.PENDING_PAYMENT) return reload();

    const now = new Date();
    if (status === SubscriptionStatus.CANCELLED && subscription.ends_at > now) {
      // The period was already paid for — nothing to charge, simply resume.
      const written = await this.patch(
        subscription,
        { status: SubscriptionStatus.ACTIVE, auto_renew: true },
        { status: true },
      );
      if (!written) throw this.changedMeanwhile();
      this.access.invalidate(tenantId);
      this.emitter.emit(
        SubscriptionReactivatedEvent.eventName,
        new SubscriptionReactivatedEvent(tenantId, subscription.id),
      );
      return reload();
    }

    // Lapsed (cancelled past its end, PAST_DUE, GRACE_EXPIRED).
    const open = await this.billing.findOpenInvoice(subscription.id);
    const isGrace =
      status === SubscriptionStatus.PAST_DUE ||
      status === SubscriptionStatus.GRACE_EXPIRED;
    if (open && isGrace) {
      // The renewal invoice is already waiting: paying it is the way back.
      // Only the flag: that very payment may be settling right now.
      await this.patch(subscription, { auto_renew: true });
      return reload();
    }
    if (open) {
      if (this.billing.isPaymentInFlight(open)) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'A payment for this subscription is already in progress',
        });
      }
      await this.voidIdleOpenInvoices(
        subscription.id,
        'Superseded by a reactivation',
      );
    }

    const plan = subscription.plan;
    const endsAt = computeNextPeriodEnd(now, plan);
    const currency = await this.platformSettings.getTyped<string>(
      SettingKey.DEFAULT_CURRENCY,
    );
    await this.billing.generateInvoice(
      tenantId,
      subscription.id,
      Number(plan.price),
      now,
      endsAt,
      currency,
      InvoiceStatus.OPEN,
      {
        kind: SubscriptionInvoiceKind.REACTIVATION,
        targetPlanId: plan.id,
        provider: this.billing.providerName,
      },
    );
    // Not usable until paid when it was CANCELLED. PAST_DUE/GRACE_EXPIRED keep
    // their status — their grace rules still apply until the payment lands.
    await this.patch(
      subscription,
      status === SubscriptionStatus.CANCELLED
        ? {
            auto_renew: true,
            status: SubscriptionStatus.PENDING_PAYMENT,
            starts_at: now,
            ends_at: endsAt,
          }
        : { auto_renew: true },
      { status: true },
    );
    this.access.invalidate(tenantId);
    return reload();
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private isPaid(plan: SubscriptionPlan): boolean {
    return Number(plan.price) > 0;
  }

  /**
   * Writes ONLY `fields`, and only while the row is still in the state this
   * request read (`expect`). These requests read the subscription unlocked, and
   * `save()` writes back every column that differs from the row as it is NOW —
   * so a settlement or the downgrade sweep that committed in between was undone
   * (a paid renewal rolled back to PAST_DUE, a paid upgrade back to the old plan).
   * FALSE when the row moved on; the caller then refuses instead of guessing.
   */
  private async patch(
    subscription: Subscription,
    fields: QueryDeepPartialEntity<Subscription>,
    expect: { status?: boolean; plan?: boolean; pendingPlan?: boolean } = {},
  ): Promise<boolean> {
    const qb = this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set(fields)
      .where('id = :id', { id: subscription.id });
    if (expect.status) {
      qb.andWhere('status = :expectedStatus', {
        expectedStatus: subscription.status,
      });
    }
    if (expect.plan) {
      qb.andWhere('"planId" = :expectedPlanId', {
        expectedPlanId: subscription.plan.id,
      });
    }
    if (expect.pendingPlan) {
      qb.andWhere('pending_plan_id = :expectedPendingId', {
        expectedPendingId: subscription.pending_plan?.id,
      });
    }
    const res = await qb.execute();
    return !!res.affected;
  }

  /**
   * FIN-S1. Refuses (409) while the subscription's OPEN invoice has a live or
   * unresolved payment. A hosted checkout is first asked about at the provider:
   * a captured one is booked (so the caller sees the subscription changed), a
   * dead one is cleared and no longer blocks.
   */
  private async assertNoLivePaymentOnOpenInvoice(
    subscriptionId: string,
  ): Promise<void> {
    const open = await this.billing.findOpenInvoice(subscriptionId);
    if (!open || !this.billing.isPaymentInFlight(open)) return;

    const hosted = await this.billing.reconcileHostedCheckout(open);
    if (hosted === 'paid') throw this.changedMeanwhile();
    if (hosted === 'cleared' && !this.billing.isPaymentInFlight(open)) return;
    throw new AppError(ErrorCode.CONFLICT, {
      message: 'A payment for this subscription is already in progress',
    });
  }

  /**
   * Voids the subscription's unpaid OPEN invoices, but only the ones nobody is
   * paying: the void is a single conditional UPDATE, so a checkout or charge that
   * started after the caller's in-flight check keeps its invoice. When an invoice
   * survived because of that, the change is refused rather than done around it.
   */
  private async voidIdleOpenInvoices(
    subscriptionId: string,
    reason: string,
  ): Promise<void> {
    await this.billing.voidSupersededOpenInvoices(
      subscriptionId,
      reason,
      'all',
    );
    if (await this.billing.findOpenInvoice(subscriptionId)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A payment for this subscription is already in progress',
      });
    }
  }

  private changedMeanwhile(): AppError {
    return new AppError(ErrorCode.CONFLICT, {
      message:
        'The subscription changed while this request was processed — refresh and try again',
    });
  }

  /**
   * FIN-004 — a paid plan must NEVER go ACTIVE without a payment. When no provider can
   * take a checkout (`RecurringUnavailableProvider`, the dev stub, or Tap left
   * unconfigured) the "legacy immediate" paths would hand the plan over with an unpaid
   * invoice and the clinic would never be sent to pay. So this refuses in EVERY
   * environment and billing mode.
   *
   * 422 (the code SubscriptionCheckoutService uses for the same condition), NOT 503: the web
   * client treats every 503 as platform maintenance and redirects to /maintenance.
   *
   * The only exceptions are tests (NODE_ENV=test) and an explicit local opt-in,
   * `SUBSCRIPTION_ALLOW_UNPAID_STUB=true`, which is ignored in production.
   */
  private async assertPaidPlanChargeable(
    plan: SubscriptionPlan,
  ): Promise<void> {
    if (!this.isPaid(plan) || this.billing.supportsCheckout) return;
    const env = this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
    if (env === 'test') return;
    if (
      env !== 'production' &&
      String(
        this.config.get<string>('SUBSCRIPTION_ALLOW_UNPAID_STUB') ??
          process.env.SUBSCRIPTION_ALLOW_UNPAID_STUB,
      ) === 'true'
    ) {
      return;
    }
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message:
        'Online payment is not available right now, so this paid plan cannot be activated. Please contact support.',
    });
  }

  private view(subscription: Subscription): SubscriptionView {
    const graceDurationDays = resolveGraceDays(this.config);
    const effectiveStatus = this.getEffectiveStatus(
      subscription,
      graceDurationDays,
    );
    const isUsable = this.isUsable(subscription, graceDurationDays);

    let accessState: AccessState;
    let graceEndsAt: Date | null = null;
    switch (effectiveStatus) {
      case SubscriptionStatus.CANCELLED:
      case SubscriptionStatus.SUSPENDED:
        accessState = 'terminal';
        break;
      case SubscriptionStatus.PENDING_PAYMENT:
        accessState = 'pending-payment';
        break;
      case SubscriptionStatus.GRACE_EXPIRED:
        accessState = 'grace-expired';
        break;
      case SubscriptionStatus.PAST_DUE:
        accessState = 'expired-in-grace';
        if (subscription.grace_started_at) {
          graceEndsAt = new Date(
            subscription.grace_started_at.getTime() +
              graceDurationDays * 86_400_000,
          );
        }
        break;
      default: // ACTIVE / TRIAL
        accessState = 'active';
    }

    return {
      subscription,
      effectiveStatus,
      isUsable,
      accessState,
      graceEndsAt,
    };
  }

  /**
   * Adds what the billing page needs beyond the status: the scheduled downgrade
   * and the one OPEN invoice there is to pay (an indexed lookup — the open-invoice
   * unique index makes it at most one row).
   */
  private async withBilling(view: SubscriptionView): Promise<SubscriptionView> {
    const open: SubscriptionInvoice | null = await this.billing.findOpenInvoice(
      view.subscription.id,
    );
    return {
      ...view,
      pendingPlan: view.subscription.pending_plan ?? null,
      openInvoice: open
        ? {
            id: open.id,
            kind: open.kind ?? null,
            amount: open.amount,
            currency: open.currency,
          }
        : null,
    };
  }

  private async getActivePlan(planId: string): Promise<SubscriptionPlan> {
    const plan = await this.plans.findOne({ where: { id: planId } });
    if (!plan) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Plan not found' });
    }
    if (!plan.is_active) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This plan is not available for subscription',
      });
    }
    return plan;
  }

  private async getActiveSubscription(tenantId: string): Promise<Subscription> {
    const subscription = await this.subscriptions.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
      relations: { plan: true, pending_plan: true },
      order: { created_at: 'DESC' },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No active subscription found for this tenant',
      });
    }
    return subscription;
  }

  private async loadWithPlan(
    tenantId: string,
    id: string,
  ): Promise<Subscription> {
    const subscription = await this.subscriptions.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { plan: true, pending_plan: true },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Subscription not found',
      });
    }
    return subscription;
  }

  /** Resolves `property`'s join-column database name from entity metadata —
   *  no entity exposes a relation's FK as a plain property (research.md
   *  R-11); the proven `DashboardSummaryService.fk()` pattern. */
  private fk(repo: Repository<Subscription>, property: string): string {
    const relation = repo.metadata.findRelationWithPropertyPath(property);
    const column = relation?.joinColumns[0]?.databaseName;
    if (!column) {
      throw new Error(`${repo.metadata.name}.${property} has no join column`);
    }
    return column;
  }
}
