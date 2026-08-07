export enum TenantApprovalStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
}

export enum VerificationDocStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum BillingCycle {
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
  CUSTOM = 'CUSTOM',
}

export enum SubscriptionStatus {
  TRIAL = 'TRIAL',
  ACTIVE = 'ACTIVE',
  PAST_DUE = 'PAST_DUE',
  CANCELLED = 'CANCELLED',
  SUSPENDED = 'SUSPENDED',
  /** FND-031/M-02 — grace window elapsed with no settlement. New billable/usage-increasing actions refused; read access preserved. */
  GRACE_EXPIRED = 'GRACE_EXPIRED',
}

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  OPEN = 'OPEN',
  PAID = 'PAID',
  VOID = 'VOID',
  UNCOLLECTIBLE = 'UNCOLLECTIBLE',
  REFUNDED = 'REFUNDED',
}

export enum AppointmentStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  CONFIRMED = 'CONFIRMED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  NO_SHOW = 'NO_SHOW',
  RESCHEDULED = 'RESCHEDULED',
}

export enum AppointmentSource {
  PLATFORM = 'PLATFORM',
  WHATSAPP_BOT = 'WHATSAPP_BOT',
  MANUAL = 'MANUAL',
}

/**
 * Payment lifecycle of an appointment — a SEPARATE axis from the scheduling
 * `AppointmentStatus`, so "is it paid?" no longer leaks into "is it happening?".
 * The legacy `AppointmentStatus.PENDING_PAYMENT` remains for back-compat but the
 * authoritative payment signal is this field.
 */
export enum AppointmentPaymentStatus {
  UNPAID = 'UNPAID',
  DEPOSIT_PAID = 'DEPOSIT_PAID',
  PAID = 'PAID',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  /**
   * Payment is handled outside this system entirely — through the patient's
   * health insurance or directly at the clinic — never collected online. Set
   * only when the patient confirmed they have insurance; no online payment is
   * ever expected, so this never transitions to PAID via `applyPaymentOutcome`.
   */
  INSURANCE = 'INSURANCE',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
}

export enum SettlementStatus {
  UNSETTLED = 'UNSETTLED',
  IN_BATCH = 'IN_BATCH',
  SETTLED = 'SETTLED',
}

export enum PayoutStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PAID = 'PAID',
  FAILED = 'FAILED',
}

/**
 * @deprecated Legacy single-axis campaign status. Superseded by the two
 * orthogonal axes {@link CampaignLifecycle} (business state, on Campaign) and
 * {@link CampaignExecution} (system state, on CampaignRun). Kept exported so the
 * migration can map old rows; no entity column uses it anymore.
 */
export enum CampaignStatus {
  DRAFT = 'DRAFT',
  SCHEDULED = 'SCHEDULED',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/**
 * BUSINESS state — what the operator intends. Slow-changing, user-driven,
 * audited. Lives on the `campaigns` table.
 */
export enum CampaignLifecycle {
  DRAFT = 'DRAFT', // being edited
  SCHEDULED = 'SCHEDULED', // approved, waiting for scheduled_at
  ACTIVE = 'ACTIVE', // operator wants it sending
  PAUSED = 'PAUSED', // operator hit pause
  ARCHIVED = 'ARCHIVED', // soft-hidden / cancelled-and-closed
}

/**
 * SYSTEM state — what the engine is doing for a single run. Fast-changing,
 * worker-driven, derived. Lives on the `campaign_runs` table.
 */
export enum CampaignExecution {
  IDLE = 'IDLE', // not started
  ENQUEUEING = 'ENQUEUEING', // fan-out in progress
  PROCESSING = 'PROCESSING', // recipients in flight
  DRAINING = 'DRAINING', // paused/cancelled, finishing in-flight
  COMPLETED = 'COMPLETED', // all recipients terminal
  FAILED = 'FAILED', // aborted (tenant suspended, provider revoked, …)
}

export enum CampaignType {
  BIRTHDAY = 'BIRTHDAY',
  HOLIDAY = 'HOLIDAY',
  REACTIVATION = 'REACTIVATION',
  PROMOTION = 'PROMOTION',
  CUSTOM = 'CUSTOM',
}

/**
 * @deprecated Legacy single-column recipient status. Replaced by the split
 * {@link RecipientProcessing} (worker-owned) + {@link RecipientDelivery}
 * (webhook-owned). Kept exported for migration mapping only.
 */
export enum RecipientStatus {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

/**
 * PROCESSING state — owned by the WORKER. "Did we hand it to the provider?"
 */
export enum RecipientProcessing {
  PENDING = 'PENDING', // not yet picked up
  DISPATCHING = 'DISPATCHING', // claimed by a worker, send in progress
  DISPATCHED = 'DISPATCHED', // provider accepted (has provider_ref)
  FAILED = 'FAILED', // permanent processing failure (after retries/DLQ)
  SKIPPED = 'SKIPPED', // business rule excluded it (opt-out, cap, dedup)
}

/**
 * DELIVERY state — owned by PROVIDER WEBHOOKS. "What did the carrier tell us?"
 */
export enum RecipientDelivery {
  NONE = 'NONE', // no provider callback yet
  ACCEPTED = 'ACCEPTED', // provider queued it
  DELIVERED = 'DELIVERED', // reached the device
  READ = 'READ', // opened
  BOUNCED = 'BOUNCED', // hard delivery failure from carrier
}

/** Classification that drives retry behaviour for a failed dispatch. */
export enum FailureClass {
  TRANSIENT = 'TRANSIENT', // retry with backoff (429, 5xx, timeout, reset)
  PERMANENT = 'PERMANENT', // do not retry (invalid number, opt-out, 4xx auth)
}

/** Lifecycle of a transactional-outbox row (state-change → queue publish). */
export enum OutboxStatus {
  PENDING = 'PENDING',
  /**
   * Claimed by a relay instance and mid-publish (Phase 0 — see
   * docs/CACHING_QUEUES_AUDIT.md §0.5 item 5). A row stuck here past the
   * recovery threshold means the relay crashed between claiming and
   * publishing; `OutboxRelayService.recoverStuckPublishing` resets it to
   * PENDING so a later poll retries it. The `dedupe_key` jobId makes a
   * duplicate publish attempt safe either way.
   */
  PUBLISHING = 'PUBLISHING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}