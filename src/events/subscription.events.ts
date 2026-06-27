/**
 * Subscription domain events.
 *
 * Emitted by SubscriptionService after lifecycle transitions. The recipient
 * for subscription notifications is the tenant itself (TENANT recipient type)
 * rather than an individual customer — the notification dispatch layer handles
 * delivery to the clinic owner's preferred channel.
 */

export const SUBSCRIPTION_EVENT = {
  ACTIVATED: 'subscription.activated',
  TRIAL_STARTED: 'subscription.trial_started',
  CANCELLED: 'subscription.cancelled',
  PLAN_CHANGED: 'subscription.plan_changed',
  REACTIVATED: 'subscription.reactivated',
} as const;

export type SubscriptionEventName =
  (typeof SUBSCRIPTION_EVENT)[keyof typeof SUBSCRIPTION_EVENT];

export class SubscriptionActivatedEvent {
  static readonly eventName = SUBSCRIPTION_EVENT.ACTIVATED;
  constructor(
    readonly tenantId: string,
    readonly subscriptionId: string,
    readonly planId: string,
  ) {}
}

export class SubscriptionTrialStartedEvent {
  static readonly eventName = SUBSCRIPTION_EVENT.TRIAL_STARTED;
  constructor(
    readonly tenantId: string,
    readonly subscriptionId: string,
    readonly planId: string,
    readonly endsAt: Date,
  ) {}
}

export class SubscriptionCancelledEvent {
  static readonly eventName = SUBSCRIPTION_EVENT.CANCELLED;
  constructor(
    readonly tenantId: string,
    readonly subscriptionId: string,
    /** True when cancellation takes effect at period end; false for immediate. */
    readonly cancelAtPeriodEnd: boolean,
  ) {}
}

export class SubscriptionPlanChangedEvent {
  static readonly eventName = SUBSCRIPTION_EVENT.PLAN_CHANGED;
  constructor(
    readonly tenantId: string,
    readonly subscriptionId: string,
    readonly newPlanId: string,
  ) {}
}

export class SubscriptionReactivatedEvent {
  static readonly eventName = SUBSCRIPTION_EVENT.REACTIVATED;
  constructor(
    readonly tenantId: string,
    readonly subscriptionId: string,
  ) {}
}
