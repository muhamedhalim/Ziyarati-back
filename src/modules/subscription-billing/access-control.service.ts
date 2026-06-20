import { Injectable } from '@nestjs/common';
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
        context: { source: decision.source },
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

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private findCurrent(tenantId: string): Promise<Subscription | null> {
    return this.subscriptions.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      order: { created_at: 'DESC' },
    });
  }

  private isUsable(subscription: Subscription): boolean {
    const status = this.effective(subscription);
    return status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.TRIAL;
  }

  /** ACTIVE/TRIAL past their `ends_at` are effectively EXPIRED. */
  private effective(subscription: Subscription): SubscriptionStatus | 'EXPIRED' {
    if (
      (subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.TRIAL) &&
      subscription.ends_at < new Date()
    ) {
      return 'EXPIRED';
    }
    return subscription.status;
  }
}
