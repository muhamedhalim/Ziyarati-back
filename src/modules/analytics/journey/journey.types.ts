import type { AdvancedAnalyticsEnvelope } from '../advanced-analytics.service';
import type {
  JourneyActionCode,
  JourneyCauseCode,
  JourneyDimension,
  JourneyInsightCode,
  JourneyInsightKind,
  JourneySeverity,
  JourneyStageKey,
} from './journey.constants';
import type { MetricKey } from '../metric-registry';

// ───────────────────────────── Raw SQL row shapes ──────────────────────────── //

/**
 * One row from the facts query. Every count column is cast `::int` in SQL
 * (this codebase's own convention — see `computeRetention`), so it parses
 * as a native JS number; every `percentile_cont(...)` column is `double
 * precision`, also a native JS number, `null` when its population is empty.
 */
export interface JourneyOverallRow {
  booked: number;
  cancelled: number;
  no_show: number;
  completed: number;
  in_progress: number;
  upcoming: number;
  past: number;
  unresolved_past: number;
  arrived: number;
  called: number;
  started: number;
  completed_with_queue: number;
  completed_without_start: number;
  completed_with_timing: number;
  consult_too_short: number;
  consult_invalid: number;
  swept: number;
  multi_service: number;
  no_service: number;
  tz_fallback: number;
  start_from_queue: number;
  start_from_log: number;
  rem_eligible: number;
  rem_with_row: number;
  rem_reminded: number;
  rem_failed_only: number;
  resolved_reminded: number;
  resolved_not_reminded: number;
  no_show_reminded: number;
  no_show_not_reminded: number;

  lead_n: number;
  lead_invalid: number;
  lead_p50: number | null;
  lead_p90: number | null;

  arrival_n: number;
  arrival_invalid: number;
  arrival_late_n: number;
  arrival_p50: number | null;
  arrival_p90: number | null;

  wait_call_n: number;
  wait_call_invalid: number;
  wait_call_p50: number | null;
  wait_call_p90: number | null;

  call_start_n: number;
  call_start_invalid: number;
  call_start_p50: number | null;
  call_start_p90: number | null;

  wait_start_n: number;
  wait_start_invalid: number;
  wait_start_p50: number | null;
  wait_start_p90: number | null;

  ready_delay_n: number;
  ready_delay_invalid: number;
  ready_delay_p50: number | null;
  ready_delay_p90: number | null;

  start_delay_n: number;
  start_delay_invalid: number;
  start_delay_p50: number | null;
  start_delay_p90: number | null;

  consult_n: number;
  consult_p50: number | null;
  consult_p75: number | null;
  consult_p90: number | null;

  overrun_p50: number | null;
  overrun_p90: number | null;

  visit_n: number;
  visit_invalid: number;
  visit_p50: number | null;
  visit_p90: number | null;

  scheduled_p50: number | null;
}

/** One row per dimension value from the per-dimension breakdown query. Labels are joined separately (typed repositories), never in the raw SQL. */
export interface JourneyDimensionRow extends JourneyOverallRow {
  dim_key: string;
}

/** One row from the reminder-outcome grouping query (Q2). */
export interface JourneyReminderRow {
  outcome: 'SENT' | 'FAILED' | 'CANCELLED' | 'PENDING';
  channel: string;
  skip_reason: string | null;
  lead_minutes: number | null;
  n: number;
  stuck: number;
}

// ───────────────────────────── Shaped response types ───────────────────────── //

export type JourneySuppression =
  | 'INSUFFICIENT_SAMPLE'
  | 'LOW_COVERAGE'
  | 'NOT_TRACKED';

export interface JourneyDistribution {
  n: number;
  invalid: number;
  p50: number | null;
  p90: number | null;
  suppressed: JourneySuppression | null;
}

export interface JourneyDistributionWithP75 extends JourneyDistribution {
  p75: number | null;
}

export interface JourneyCoverage {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export type JourneySource =
  | 'QUEUE'
  | 'STATUS_LOG'
  | 'QUEUE_OR_STATUS_LOG'
  | 'APPOINTMENT'
  | 'REMINDERS';

export interface JourneyStage {
  key: JourneyStageKey;
  tracked: boolean;
  metricKey: MetricKey | null;
  source: JourneySource | null;
  unit: 'minutes' | 'hours' | null;
  count: number | null;
  duration: JourneyDistribution | null;
}

export interface JourneyTimeBasis {
  period: 'SCHEDULED_START_UTC_DAY';
  localBuckets: 'SCHEDULED_START_LOCAL_TIME';
  localTimezoneSource: 'BOOKED_ELSE_BRANCH_ELSE_UTC';
}

export interface JourneyCounts {
  booked: number;
  cancelled: number;
  noShow: number;
  completed: number;
  inProgress: number;
  upcoming: number;
  unresolvedPast: number;
  arrived: number;
  called: number;
  consultationStarted: number;
  noShowRate: number | null;
  completionRate: number | null;
}

export interface JourneyKpis {
  waitToStart: JourneyDistribution;
  readyDelay: JourneyDistribution;
  startDelay: JourneyDistribution & {
    fromQueue: number;
    fromStatusLog: number;
  };
  consultation: JourneyDistributionWithP75;
  overrun: JourneyDistribution;
  arrivalOffset: JourneyDistribution & { lateShare: number | null };
  waitForCall: JourneyDistribution;
  callToStart: JourneyDistribution;
  visitTime: JourneyDistribution;
  bookingLeadHours: JourneyDistribution;
}

export interface JourneyComparisonPoint {
  range: { from: string; to: string };
  waitToStartP50: number | null;
  readyDelayP50: number | null;
  consultationP50: number | null;
  noShowRate: number | null;
}

export type JourneyRemindersInfo =
  | {
      available: false;
      enabled: boolean;
      reason: 'NOT_ENABLED' | 'NO_REMINDER_ROWS';
    }
  | {
      available: true;
      enabled: boolean;
      configuredLeadMinutes: number[];
      appointments: {
        eligible: number;
        withReminderRow: number;
        reminded: number;
        failedOnly: number;
        noReminderRow: number;
      };
      rows: {
        sent: number;
        failed: number;
        cancelled: number;
        pending: number;
        stuck: number;
        failureRate: number | null;
      };
      byLeadTime: { leadMinutes: number; sent: number; failed: number }[];
      byChannel: {
        channel: 'WHATSAPP' | 'EMAIL' | 'UNKNOWN';
        sent: number;
        failed: number;
      }[];
      failureReasons: { reason: string; count: number }[];
      attendance: {
        reminded: { resolved: number; noShow: number; share: number | null };
        notReminded: { resolved: number; noShow: number; share: number | null };
        comparable: boolean;
      };
      deliveryTracking: 'NOT_RELIABLE';
    };

export interface JourneyDurationSuggestion {
  serviceId: string;
  name: string;
  inactive: boolean;
  configuredMinutes: number | null;
  scheduledP50: number | null;
  consultation: JourneyDistributionWithP75;
  coverage: JourneyCoverage;
  suggestedMinutes: number | null;
  direction: 'LONGER' | 'SHORTER' | null;
}

/**
 * Why a service did or did not produce a duration suggestion. Reporting only:
 * the gates themselves are unchanged — this exposes the gate that fired
 * instead of silently dropping the service.
 */
export type JourneyDurationCandidateStatus =
  | 'OK'
  | 'SERVICE_INACTIVE'
  | 'INSUFFICIENT_SAMPLE'
  | 'LOW_TIMING_COVERAGE'
  | 'NO_PERCENTILE'
  | 'ALREADY_ALIGNED';

export interface JourneyDurationCandidate extends JourneyDurationSuggestion {
  status: JourneyDurationCandidateStatus;
}

/**
 * Panel-level reason there is nothing per-service to show. `null` means at
 * least one service has timed consultations, so the per-candidate `status`
 * carries the explanation.
 */
export type JourneyDurationSuggestionsState =
  | 'NO_SERVICES_CONFIGURED'
  | 'NO_SERVICE_APPOINTMENTS'
  | 'NO_TIMED_CONSULTATIONS';

export interface JourneyDataQuality {
  invalidIntervals: Record<
    | 'bookingLead'
    | 'arrivalOffset'
    | 'waitForCall'
    | 'callToStart'
    | 'waitToStart'
    | 'readyDelay'
    | 'startDelay'
    | 'consultation'
    | 'visitTime',
    number
  >;
  consultationTooShort: number;
  completedWithoutStart: number;
  sweptQueueEntries: number;
  multiServiceAppointments: number;
  timezoneFallback: number;
  unresolvedPast: number;
  untrackedStages: JourneyStageKey[];
  notes: (
    | 'PLAIN_TIMESTAMP_SESSION_TZ'
    | 'RECALL_OVERWRITES_CALL_TIME'
    | 'DELIVERY_STATUS_NOT_USED'
  )[];
}

export interface JourneyInsight {
  code: JourneyInsightCode;
  kind: JourneyInsightKind;
  severity: JourneySeverity;
  metric: MetricKey | null;
  scope: {
    dimension: 'clinic' | JourneyDimension;
    key: string | null;
    label: string | null;
  };
  observed: number | null;
  threshold: number | null;
  baseline: {
    kind: 'ABSOLUTE' | 'PRIOR_PERIOD' | 'CLINIC_MEDIAN';
    value: number | null;
  } | null;
  sample: { n: number; min: number };
  params: Record<string, string | number>;
  causes: { key: JourneyCauseCode; params: Record<string, number> }[];
  actionKey: JourneyActionCode | null;
  cta: { route: string; query?: Record<string, string> } | null;
  dataSources: (
    | 'appointments'
    | 'queue_entries'
    | 'appointment_status_logs'
    | 'scheduled_notifications'
    | 'appointment_services'
    | 'services'
    | 'tenant_settings'
  )[];
}

export interface JourneySummaryResponse extends AdvancedAnalyticsEnvelope {
  empty: boolean;
  filters: { staffId: string | null; serviceId: string | null };
  timeBasis: JourneyTimeBasis;
  counts: JourneyCounts;
  stages: JourneyStage[];
  kpis: JourneyKpis;
  coverage: {
    queue: JourneyCoverage;
    consultationTiming: JourneyCoverage;
    reminders: JourneyCoverage | null;
  };
  comparison: JourneyComparisonPoint | null;
  comparisonUnavailable: 'RANGE_TOO_WIDE' | 'NO_PRIOR_DATA' | null;
  reminders: JourneyRemindersInfo;
  durationSuggestions: JourneyDurationSuggestion[];
  durationSuggestionCandidates: JourneyDurationCandidate[];
  durationSuggestionsState: JourneyDurationSuggestionsState | null;
  dataQuality: JourneyDataQuality;
  insights: JourneyInsight[];
  insightsTruncated: boolean;
  thresholds: {
    minSample: number;
    minBreakdownSample: number;
    minCoverage: number;
    minDurationSample: number;
    maxIntervalMinutes: number;
  };
}

export interface JourneyBreakdownRow {
  key: string;
  label: string | null;
  inactive?: boolean;
  appointments: number;
  completed: number;
  noShow: number;
  noShowRate: number | null;
  queueCoverage: JourneyCoverage;
  waitToStart: JourneyDistribution;
  readyDelay: JourneyDistribution;
  startDelay: JourneyDistribution;
  consultation: JourneyDistributionWithP75;
  overrun: JourneyDistribution;
  remindedShare: number | null;
  configuredMinutes?: number | null;
  suggestedMinutes?: number | null;
  flags: JourneyInsightCode[];
}

export interface JourneyBreakdownResponse extends AdvancedAnalyticsEnvelope {
  empty: boolean;
  dimension: JourneyDimension;
  sort: string;
  filters: { staffId: string | null; serviceId: string | null };
  timeBasis: JourneyTimeBasis;
  reference: {
    waitToStartP50: number | null;
    readyDelayP50: number | null;
    overrunP50: number | null;
    noShowRate: number | null;
  };
  excluded: { multiOrNoServiceAppointments: number } | null;
  data: JourneyBreakdownRow[];
  total: number;
  page: number;
  limit: number;
}

/** A branch/staff/service display label, batch-fetched once per aggregate. */
export interface JourneyLabelInfo {
  name: string;
  inactive: boolean;
  configuredMinutes: number | null;
}

/**
 * The full cached aggregate — everything derived once per (scope, range)
 * and cached, then sliced/paged/shaped in memory on EVERY read (cache hit
 * or miss), so a threshold-rule change takes effect immediately without
 * waiting out the cache TTL.
 *
 * `labels` are plain `Record`s, never `Map`s: `AnalyticsCacheService.wrap`
 * round-trips the value through `JSON.stringify`/`JSON.parse` on the
 * Redis-backed path, and `JSON.stringify(new Map())` silently serializes to
 * `"{}"` — a `Map` here would work in local dev (Redis absent, the
 * `!this.client` fail-open path returns the live object untouched) and
 * silently lose every label the moment Redis is configured.
 */
export interface JourneyAggregate {
  overall: JourneyOverallRow;
  priorOverall: JourneyOverallRow | null;
  priorRange: { from: string; to: string } | null;
  byDimension: Record<JourneyDimension, JourneyDimensionRow[]>;
  reminderRows: JourneyReminderRow[];
  labels: {
    branch: Record<string, JourneyLabelInfo>;
    staff: Record<string, JourneyLabelInfo>;
    service: Record<string, JourneyLabelInfo>;
  };
  settings: {
    currency: string;
    remindersEnabled: boolean;
    reminderLeadMinutes: number[];
  };
  /**
   * Tenant-wide count of active, non-deleted services — lets the duration
   * panel tell "no services configured" from "none booked in this range".
   * Optional: a blob cached before this field existed simply lacks it, and
   * the shaping step then treats the count as unknown.
   */
  activeServiceCount?: number;
  now: string;
}
