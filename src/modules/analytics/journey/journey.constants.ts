/**
 * Patient Journey — domain constants for the `journey/` sub-module.
 *
 * Plan: `patient-journey` implementation plan (approved 2026-09-16), §6-9.
 * Kept in one file, code-owned (no per-tenant configuration — see the plan's
 * "Thresholds" decision), so every limit and every alert/recommendation rule
 * is reviewable in one place rather than scattered across the SQL, the
 * shaping step and the rule engine.
 */

// ─────────────────────────── Journey stages ──────────────────────────────── //

export const JOURNEY_STAGE_KEYS = [
  'BOOKING',
  'REMINDER',
  'ARRIVAL',
  'WAIT_FOR_CALL',
  'CALL_TO_START',
  'CONSULTATION',
  'COMPLETION',
  'CHECKOUT',
  'FEEDBACK',
] as const;

export type JourneyStageKey = (typeof JOURNEY_STAGE_KEYS)[number];

/**
 * Stages the current data model cannot measure at all (plan §3, classes D/E).
 * `customer_reviews` has no reachable writer (only `ROLE.CUSTOMER` holds
 * `reviews.create`, and no signup/booking flow assigns that role —
 * `rbac.constants.ts:320-328`) and no departure/checkout timestamp exists
 * anywhere. This is the hook a later feature flips, not a UI toggle.
 */
export const JOURNEY_TRACKED_STAGES: Record<JourneyStageKey, boolean> = {
  BOOKING: true,
  REMINDER: true,
  ARRIVAL: true,
  WAIT_FOR_CALL: true,
  CALL_TO_START: true,
  CONSULTATION: true,
  COMPLETION: true,
  CHECKOUT: false,
  FEEDBACK: false,
};

// ─────────────────────────── Breakdown dimensions ─────────────────────────── //

export const JOURNEY_DIMENSIONS = [
  'branch',
  'staff',
  'service',
  'weekday',
  'hour',
] as const;
export type JourneyDimension = (typeof JOURNEY_DIMENSIONS)[number];

export const JOURNEY_BREAKDOWN_SORTS = [
  'appointments',
  'waitToStartP50',
  'readyDelayP50',
  'overrunP50',
  'noShowRate',
] as const;
export type JourneyBreakdownSort = (typeof JOURNEY_BREAKDOWN_SORTS)[number];

// ───────────────────────────── Validity windows ────────────────────────────── //

/**
 * Bounds every raw interval must fall inside to be counted rather than
 * flagged `invalid` (plan §3/§6 edge-case table). A small negative value
 * within `SKEW_TOLERANCE_MINUTES` is clock skew (arrival comes from Node,
 * the rest from DB `now()`) and is clamped to 0 rather than excluded.
 */
export const JOURNEY_LIMITS = {
  /** Booking lead time: earliest allowed created→start gap, minutes. */
  LEAD_TIME_MIN_MINUTES: -60,
  /** Arrival offset, wait-for-call/call-to-start/wait-to-start/ready-delay/start-delay/visit-time bound, minutes. */
  INTERVAL_MAX_MINUTES: 720,
  /** Consultation duration bounds, minutes. */
  CONSULTATION_MIN_MINUTES: 1,
  CONSULTATION_MAX_MINUTES: 360,
  /** Visit-time upper bound (arrival → consultation end), minutes. */
  VISIT_MAX_MINUTES: 960,
  /** Small negative intervals within this tolerance are clock skew, clamped to 0. */
  SKEW_TOLERANCE_MINUTES: 1,
  /** "Late" arrival / start threshold used by insight rules, minutes. */
  LATE_ARRIVAL_MINUTES: 10,
} as const;

// ───────────────────────────── Sample & coverage ───────────────────────────── //

export const JOURNEY_THRESHOLDS = {
  /** Minimum n for a summary-level distribution/rate to be shown. */
  MIN_SAMPLE_SUMMARY: 20,
  /** Minimum n for one breakdown row. */
  MIN_SAMPLE_BREAKDOWN_ROW: 10,
  /** Minimum n for an alert/recommendation rule to fire. */
  MIN_SAMPLE_RULE: 30,
  /** Minimum n for a duration suggestion. */
  MIN_SAMPLE_DURATION_SUGGESTION: 20,
  /** Below this coverage, queue-timing distributions are suppressed. */
  MIN_COVERAGE: 0.5,
  /** Comparison against the prior period is only offered for ranges this wide or narrower, days. */
  MAX_COMPARISON_RANGE_DAYS: 366,
  /** Cap on how many insights a response returns. */
  MAX_INSIGHTS: 20,
  /** Cap on how many duration suggestions a response returns. */
  MAX_DURATION_SUGGESTIONS: 10,
  /** Cap on how many per-service duration-suggestion candidates (with their gate status) a response returns. */
  MAX_DURATION_CANDIDATES: 25,
} as const;

// ───────────────────────────── Skip-reason allow-list ──────────────────────── //

/**
 * `scheduled_notifications.skip_reason` literal values actually written by
 * `notification-dispatch.service.ts` (verified: NO_PROVIDER, INVALID_RECIPIENT,
 * RECIPIENT_NOT_FOUND, OPTED_OUT, UNREACHABLE, QUOTA_EXHAUSTED — plus UNKNOWN,
 * the fallback default). Anything outside this list is reported as `OTHER`
 * rather than surfacing raw text.
 */
export const JOURNEY_KNOWN_SKIP_REASONS = [
  'NO_PROVIDER',
  'INVALID_RECIPIENT',
  'RECIPIENT_NOT_FOUND',
  'OPTED_OUT',
  'UNREACHABLE',
  'QUOTA_EXHAUSTED',
  'UNKNOWN',
] as const;
export type JourneyKnownSkipReason =
  (typeof JOURNEY_KNOWN_SKIP_REASONS)[number];

// ───────────────────────────── Timezones ───────────────────────────────────── //

/**
 * The allow-list local-hour/weekday bucketing validates `booked_timezone`/
 * `Branch.timezone` against — both are free strings in the schema (no DB
 * check constraint), so an invalid value passed straight into
 * `AT TIME ZONE` would raise a query error. `Intl.supportedValuesOf` doesn't
 * itself include `'UTC'` (verified on Node 24), so it's added explicitly —
 * it's the journey's own fallback zone.
 */
export const JOURNEY_KNOWN_TIMEZONES: readonly string[] = [
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
];

// ───────────────────────────── Insight codes ───────────────────────────────── //

export const JOURNEY_INSIGHT_KIND = {
  ALERT: 'ALERT',
  RECOMMENDATION: 'RECOMMENDATION',
  DATA_QUALITY: 'DATA_QUALITY',
} as const;
export type JourneyInsightKind =
  (typeof JOURNEY_INSIGHT_KIND)[keyof typeof JOURNEY_INSIGHT_KIND];

export const JOURNEY_SEVERITY = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
} as const;
export type JourneySeverity =
  (typeof JOURNEY_SEVERITY)[keyof typeof JOURNEY_SEVERITY];

/** Data-quality codes (plan §8, first table). */
export const JOURNEY_DQ_CODE = {
  QUEUE_NOT_USED: 'QUEUE_NOT_USED',
  QUEUE_COVERAGE_LOW: 'QUEUE_COVERAGE_LOW',
  CONSULTATION_START_NOT_RECORDED: 'CONSULTATION_START_NOT_RECORDED',
  UNRESOLVED_APPOINTMENTS: 'UNRESOLVED_APPOINTMENTS',
  QUEUE_ENTRIES_LEFT_OPEN: 'QUEUE_ENTRIES_LEFT_OPEN',
  IMPLAUSIBLE_TIMESTAMPS: 'IMPLAUSIBLE_TIMESTAMPS',
  REMINDERS_DISABLED: 'REMINDERS_DISABLED',
  REMINDERS_NOT_SCHEDULED: 'REMINDERS_NOT_SCHEDULED',
  CHECKOUT_NOT_TRACKED: 'CHECKOUT_NOT_TRACKED',
  FEEDBACK_NOT_COLLECTED: 'FEEDBACK_NOT_COLLECTED',
} as const;

/** Operational alert codes (plan §8, second table). */
export const JOURNEY_ALERT_CODE = {
  WAIT_TO_START_HIGH: 'WAIT_TO_START_HIGH',
  WAIT_TO_START_INCREASED: 'WAIT_TO_START_INCREASED',
  READY_DELAY_HIGH: 'READY_DELAY_HIGH',
  CONSULTATION_OVERRUN: 'CONSULTATION_OVERRUN',
  NO_SHOW_RATE_HIGH: 'NO_SHOW_RATE_HIGH',
  NO_SHOW_RATE_INCREASED: 'NO_SHOW_RATE_INCREASED',
  PEAK_HOUR_WAIT: 'PEAK_HOUR_WAIT',
  BRANCH_WAIT_OUTLIER: 'BRANCH_WAIT_OUTLIER',
  REMINDER_FAILURE_RATE_HIGH: 'REMINDER_FAILURE_RATE_HIGH',
  REMINDER_COVERAGE_LOW: 'REMINDER_COVERAGE_LOW',
  PATIENT_LATE_ARRIVALS: 'PATIENT_LATE_ARRIVALS',
} as const;

/** Recommendation codes (plan §9). */
export const JOURNEY_RECOMMENDATION_CODE = {
  SERVICE_DURATION_REVIEW: 'SERVICE_DURATION_REVIEW',
  REMINDER_ATTENDANCE_GAP: 'REMINDER_ATTENDANCE_GAP',
  BOTTLENECK_STAGE: 'BOTTLENECK_STAGE',
} as const;

export const JOURNEY_INSIGHT_CODE = {
  ...JOURNEY_DQ_CODE,
  ...JOURNEY_ALERT_CODE,
  ...JOURNEY_RECOMMENDATION_CODE,
} as const;
export type JourneyInsightCode =
  (typeof JOURNEY_INSIGHT_CODE)[keyof typeof JOURNEY_INSIGHT_CODE];

/** Likely-cause codes attached to wait alerts (plan §9). Association only. */
export const JOURNEY_CAUSE_CODE = {
  EARLY_ARRIVAL: 'EARLY_ARRIVAL',
  LATE_ARRIVAL: 'LATE_ARRIVAL',
  START_DELAY_AFTER_READY: 'START_DELAY_AFTER_READY',
  CONSULTATIONS_OVERRUN: 'CONSULTATIONS_OVERRUN',
  PEAK_HOUR_CONCENTRATION: 'PEAK_HOUR_CONCENTRATION',
  HANDOFF_GAP: 'HANDOFF_GAP',
} as const;
export type JourneyCauseCode =
  (typeof JOURNEY_CAUSE_CODE)[keyof typeof JOURNEY_CAUSE_CODE];

/** Suggested-action codes, each with a fixed CTA route (plan §8/§9). */
export const JOURNEY_ACTION_CODE = {
  USE_QUEUE_CHECK_IN: 'USE_QUEUE_CHECK_IN',
  START_CONSULTATION_IN_SYSTEM: 'START_CONSULTATION_IN_SYSTEM',
  CLOSE_OUT_APPOINTMENTS: 'CLOSE_OUT_APPOINTMENTS',
  CLOSE_QUEUE_ENTRIES: 'CLOSE_QUEUE_ENTRIES',
  RECORD_QUEUE_STEPS_LIVE: 'RECORD_QUEUE_STEPS_LIVE',
  ENABLE_REMINDERS: 'ENABLE_REMINDERS',
  CONFIGURE_REMINDER_TEMPLATE: 'CONFIGURE_REMINDER_TEMPLATE',
  REVIEW_PEAK_STAFFING: 'REVIEW_PEAK_STAFFING',
  REVIEW_DOCTOR_SCHEDULE: 'REVIEW_DOCTOR_SCHEDULE',
  REVIEW_SERVICE_DURATION: 'REVIEW_SERVICE_DURATION',
  REVIEW_REMINDER_LEAD_TIMES: 'REVIEW_REMINDER_LEAD_TIMES',
  REVIEW_BRANCH_FLOW: 'REVIEW_BRANCH_FLOW',
  CONNECT_WHATSAPP: 'CONNECT_WHATSAPP',
  REVIEW_MESSAGING_QUOTA: 'REVIEW_MESSAGING_QUOTA',
  FIX_PATIENT_CONTACTS: 'FIX_PATIENT_CONTACTS',
  REVIEW_NOTIFICATION_LOG: 'REVIEW_NOTIFICATION_LOG',
  CHECK_REMINDER_SETUP: 'CHECK_REMINDER_SETUP',
  REVIEW_ARRIVAL_INSTRUCTIONS: 'REVIEW_ARRIVAL_INSTRUCTIONS',
  EXTEND_REMINDER_COVERAGE: 'EXTEND_REMINDER_COVERAGE',
} as const;
export type JourneyActionCode =
  (typeof JOURNEY_ACTION_CODE)[keyof typeof JOURNEY_ACTION_CODE];

/** Fixed CTA route per action, only rendered client-side if the viewer can see that page. */
export const JOURNEY_ACTION_ROUTE: Record<JourneyActionCode, string> = {
  USE_QUEUE_CHECK_IN: '/app/queue',
  START_CONSULTATION_IN_SYSTEM: '/app/queue',
  CLOSE_OUT_APPOINTMENTS: '/app/appointments',
  CLOSE_QUEUE_ENTRIES: '/app/queue',
  RECORD_QUEUE_STEPS_LIVE: '/app/queue',
  ENABLE_REMINDERS: '/app/settings',
  CONFIGURE_REMINDER_TEMPLATE: '/app/notifications',
  REVIEW_PEAK_STAFFING: '/app/patient-journey',
  REVIEW_DOCTOR_SCHEDULE: '/app/patient-journey',
  REVIEW_SERVICE_DURATION: '/app/services',
  REVIEW_REMINDER_LEAD_TIMES: '/app/settings',
  REVIEW_BRANCH_FLOW: '/app/patient-journey',
  CONNECT_WHATSAPP: '/app/whatsapp',
  REVIEW_MESSAGING_QUOTA: '/app/billing',
  FIX_PATIENT_CONTACTS: '/app/crm',
  REVIEW_NOTIFICATION_LOG: '/app/notifications',
  CHECK_REMINDER_SETUP: '/app/notifications',
  REVIEW_ARRIVAL_INSTRUCTIONS: '/app/notifications',
  EXTEND_REMINDER_COVERAGE: '/app/settings',
};

// ───────────────────────────── Alert rule thresholds ───────────────────────── //

/**
 * Absolute defaults for every threshold-bearing rule (plan §8/§9). Initial
 * product judgments, reviewed here in one place — not per-tenant
 * configurable (see the plan's "Thresholds" decision).
 */
export const JOURNEY_RULE_THRESHOLDS = {
  WAIT_TO_START_WARN_P50: 20,
  WAIT_TO_START_WARN_P90: 45,
  WAIT_TO_START_CRIT_P50: 40,
  WAIT_TO_START_CRIT_P90: 90,
  WAIT_TO_START_INCREASE_RATIO: 1.25,
  WAIT_TO_START_INCREASE_MIN_DELTA: 5,

  READY_DELAY_WARN_MINUTES: 15,
  READY_DELAY_CRIT_MINUTES: 30,
  READY_DELAY_MEDIAN_RATIO: 2,
  READY_DELAY_MIN_DELTA: 10,

  OVERRUN_MIN_MINUTES: 5,
  OVERRUN_SCHEDULED_RATIO: 1.2,

  NO_SHOW_WARN_RATE: 0.15,
  NO_SHOW_CRIT_RATE: 0.25,
  NO_SHOW_INCREASE_MIN_DELTA_PP: 0.05,
  NO_SHOW_INCREASE_RATIO: 1.3,

  PEAK_HOUR_TOP_N: 3,
  PEAK_HOUR_RATIO: 1.5,
  PEAK_HOUR_MIN_DELTA: 10,

  BRANCH_OUTLIER_RATIO: 1.5,
  BRANCH_OUTLIER_MIN_DELTA: 10,
  BRANCH_OUTLIER_MIN_QUALIFYING_BRANCHES: 2,

  REMINDER_FAILURE_WARN_RATE: 0.1,
  REMINDER_FAILURE_CRIT_RATE: 0.25,
  REMINDER_COVERAGE_WARN_FLOOR: 0.7,

  LATE_ARRIVAL_SHARE_WARN: 0.25,

  DURATION_SUGGESTION_MIN_DELTA_MINUTES: 5,
  DURATION_SUGGESTION_MIN_DELTA_RATIO: 0.15,
  DURATION_ROUND_TO_MINUTES: 5,
  DURATION_MIN_MINUTES: 5,
  DURATION_MAX_MINUTES: 480,

  REMINDER_ATTENDANCE_GAP_MIN_DELTA: 0.05,
  REMINDER_ATTENDANCE_GAP_MAX_COVERAGE: 0.9,

  BOTTLENECK_MIN_MINUTES: 10,

  EARLY_ARRIVAL_CAUSE_MAX_OFFSET: -15,
  LATE_ARRIVAL_CAUSE_MIN_OFFSET: 10,
  READY_DELAY_CAUSE_MIN_MINUTES: 15,
  OVERRUN_CAUSE_MIN_MINUTES: 5,
  HANDOFF_GAP_CAUSE_MIN_MINUTES: 5,
  PEAK_HOUR_CAUSE_CONCENTRATION_SHARE: 0.5,
  PEAK_HOUR_CAUSE_MAX_HOURS: 3,

  QUEUE_COVERAGE_LOW_FLOOR: 0.5,
  CONSULTATION_START_NOT_RECORDED_SHARE: 0.5,
  UNRESOLVED_MIN_COUNT: 10,
  UNRESOLVED_MIN_SHARE: 0.05,
  SWEPT_MIN_COUNT: 10,
  SWEPT_MIN_SHARE: 0.1,
  IMPLAUSIBLE_MIN_SHARE: 0.1,
} as const;
