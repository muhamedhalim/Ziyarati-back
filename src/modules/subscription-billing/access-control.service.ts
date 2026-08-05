import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { AccessSource } from './platform-billing.constants';

export interface AccessDecision {
  allowed: boolean;
  source: AccessSource;
  /** Present when access came from a paid subscription. */
  subscriptionId?: string;
  /** Human-readable reason, primarily for denials. */
  reason?: string;
  /** When access is time-bounded (override end / subscription end). */
  expiresAt?: Date | null;
}

/**
 * The single source of truth for "can this tenant use the platform right now?".
 *
 * Resolution priority (fixed, documented in platform-billing.constants):
 *   1. GLOBAL MODE  — if the platform is in FREE mode, everyone is allowed.
 *   2. FREE OVERRIDE — an active super-admin override allows the tenant,
 *                      OUTRANKING (overriding) the paid-subscription check.
 *   3. PAID SUBSCRIPTION — otherwise a usable (ACTIVE/TRIAL, not expired)
 *                      subscription is required.
 *
 * This service has NO dependency on SubscriptionService/UsageService (it reads
 * the Subscription repo directly), so it can be injected by them and by guards
 * without creating a cycle. It is the only place the priority rules live.
 */
@Injectable()
export class AccessControlService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly billingMode: BillingModeService,
    private readonly overrides: FreeAccessOverrideService,
    private readonly config: ConfigService,
  ) {}

  /** Resolve the access decision for a tenant, applying the full priority chain. */
  async resolveAccess(tenantId: string): Promise<AccessDecision> {
    // 1. Global free mode short-circuits everything.
    if (!(await this.billingMode.isPaidMode())) {
      return { allowed: true, source: AccessSource.PLATFORM_FREE_MODE };
    }

    // 2. An active free-access override outranks the paid check.
    const override = await this.overrides.getActive(tenantId);
    if (override) {
      return {
        allowed: true,
        source: AccessSource.FREE_OVERRIDE,
        expiresAt: override.ends_at,
      };
    }

    // 3. Paid mode, no override → require a usable subscription.
    const subscription = await this.findCurrent(tenantId);
    if (subscription && this.isUsable(subscription)) {
      return {
        allowed: true,
        source: AccessSource.SUBSCRIPTION,
        subscriptionId: subscription.id,
        expiresAt: subscription.ends_at,
      };
    }

    return {
      allowed: false,
      source: AccessSource.NONE,
      reason: subscription
        ? `Subscription is not active (status: ${this.effective(subscription)})`
        : 'No active subscription, free-access override, or free platform mode',
    };
  }

  /** Throws 403 unless the tenant currently has access (any of the three paths). */
  async assertUsable(tenantId: string): Promise<void> {
    const decision = await this.resolveAccess(tenantId);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: decision.reason ?? 'Access denied',
        publicContext: { source: decision.source },
      });
    }
  }

  /**
   * Whether paid enforcement (quotas / feature gating) currently applies to this
   * tenant. False under FREE mode or an active override — both grant unmetered
   * access, so usage limits and feature flags are not enforced against them.
   */
  async isEnforced(tenantId: string): Promise<boolean> {
    if (!(await this.billingMode.isPaidMode())) return false;
    if (await this.overrides.hasActive(tenantId)) return false;
    return true;
  }

  /**
   * FND-031/T082 — the NARROW, write-specific gate: true unless the tenant's
   * effective state is GRACE_EXPIRED. Deliberately separate from
   * `assertUsable`/`isEnforced` (which govern the WHOLE platform, reads
   * included) — read access must be preserved even once grace-expired
   * (FR-B007d), so this must never be folded into those.
   */
  async isBillableAllowed(tenantId: string): Promise<boolean> {
    if (!(await this.billingMode.isPaidMode())) return true;
    if (await this.overrides.hasActive(tenantId)) return true;
    const subscription = await this.findCurrent(tenantId);
    if (!subscription) return true; // no subscription = AccessControlService's broader gate already refused the request
    return this.effective(subscription) !== SubscriptionStatus.GRACE_EXPIRED;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private findCurrent(tenantId: string): Promise<Subscription | null> {
    return this.subscriptions.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * FND-031 — usable (the BROAD platform-access gate) means anything
   * non-terminal: ACTIVE, TRIAL, PAST_DUE ("expired-in-grace" — full
   * capabilities, unchanged), AND GRACE_EXPIRED (read access preserved —
   * FR-B007d; only billable/usage-increasing actions are refused there, via
   * `isBillableAllowed`, never here). Only CANCELLED/SUSPENDED are not usable.
   */
  private isUsable(subscription: Subscription): boolean {
    const status = this.effective(subscription);
    return (
      status !== SubscriptionStatus.CANCELLED &&
      status !== SubscriptionStatus.SUSPENDED
    );
  }

  /**
   * Live-derives past the raw `status` column exactly like
   * `SubscriptionService.getEffectiveStatus` (duplicated rather than
   * depended-on — this service must stay dependency-free of
   * SubscriptionService/UsageService, see the class docstring): ACTIVE/TRIAL
   * past `ends_at` reads as PAST_DUE; PAST_DUE whose grace window has
   * elapsed reads as GRACE_EXPIRED. Never a race against the background
   * transition sweep (`subscriptions.processor.ts`).
   */
  private effective(subscription: Subscription): SubscriptionStatus {
    const now = new Date();
    if (
      subscription.status === SubscriptionStatus.CANCELLED ||
      subscription.status === SubscriptionStatus.SUSPENDED ||
      subscription.status === SubscriptionStatus.GRACE_EXPIRED
    ) {
      return subscription.status;
    }
    if (subscription.status === SubscriptionStatus.PAST_DUE) {
      if (subscription.grace_started_at) {
        const graceDays = this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14);
        const graceEndsAt = new Date(
          subscription.grace_started_at.getTime() + graceDays * 86_400_000,
        );
        if (graceEndsAt < now) return SubscriptionStatus.GRACE_EXPIRED;
      }
      return SubscriptionStatus.PAST_DUE;
    }
    if (subscription.ends_at < now) return SubscriptionStatus.PAST_DUE;
    return subscription.status;
  }
}
