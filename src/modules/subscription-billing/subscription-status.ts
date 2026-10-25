import type { ConfigService } from '@nestjs/config';

import { SubscriptionStatus } from '../../entities/enums';

/** Default length of the PAST_DUE grace window, in days. */
export const DEFAULT_SUBSCRIPTION_GRACE_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * The one place `SUBSCRIPTION_GRACE_DAYS` is read. Access gating, the
 * subscription view, the renewal job, the transition sweeper and the platform
 * dashboard all call this, so the window can never differ between them.
 */
export function resolveGraceDays(config: Pick<ConfigService, 'get'>): number {
  return config.get<number>(
    'SUBSCRIPTION_GRACE_DAYS',
    DEFAULT_SUBSCRIPTION_GRACE_DAYS,
  );
}

/** When a PAST_DUE subscription's grace window ends. */
export function graceEndsAtOf(graceStartedAt: Date, graceDays: number): Date {
  return new Date(graceStartedAt.getTime() + graceDays * DAY_MS);
}

/**
 * The status a subscription effectively has right now, derived live from the
 * stored `status` column so it never races the background transition sweep:
 * ACTIVE/TRIAL past `ends_at` reads as PAST_DUE, and PAST_DUE whose grace
 * window has elapsed reads as GRACE_EXPIRED. CANCELLED, SUSPENDED,
 * GRACE_EXPIRED and PENDING_PAYMENT (dates provisional until paid) pass
 * through unchanged.
 */
export function effectiveSubscriptionStatus(
  subscription: {
    status: SubscriptionStatus;
    ends_at: Date;
    grace_started_at?: Date | null;
  },
  graceDays: number,
  now: Date = new Date(),
): SubscriptionStatus {
  switch (subscription.status) {
    case SubscriptionStatus.CANCELLED:
    case SubscriptionStatus.SUSPENDED:
    case SubscriptionStatus.GRACE_EXPIRED:
    case SubscriptionStatus.PENDING_PAYMENT:
      return subscription.status;
    case SubscriptionStatus.PAST_DUE:
      if (
        subscription.grace_started_at &&
        graceEndsAtOf(subscription.grace_started_at, graceDays) < now
      ) {
        return SubscriptionStatus.GRACE_EXPIRED;
      }
      return SubscriptionStatus.PAST_DUE;
    default:
      return subscription.ends_at < now
        ? SubscriptionStatus.PAST_DUE
        : subscription.status;
  }
}
