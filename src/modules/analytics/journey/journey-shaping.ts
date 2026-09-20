import {
  JOURNEY_KNOWN_SKIP_REASONS,
  JOURNEY_RULE_THRESHOLDS,
  JOURNEY_STAGE_KEYS,
  JOURNEY_THRESHOLDS,
  JOURNEY_TRACKED_STAGES,
} from './journey.constants';
import type { JourneyStageKey } from './journey.constants';
import type {
  JourneyBreakdownRow,
  JourneyComparisonPoint,
  JourneyCoverage,
  JourneyCounts,
  JourneyDataQuality,
  JourneyDimensionRow,
  JourneyDistribution,
  JourneyDistributionWithP75,
  JourneyDurationCandidate,
  JourneyDurationCandidateStatus,
  JourneyDurationSuggestion,
  JourneyDurationSuggestionsState,
  JourneyKpis,
  JourneyLabelInfo,
  JourneyOverallRow,
  JourneyRemindersInfo,
  JourneyReminderRow,
  JourneyStage,
  JourneySuppression,
} from './journey.types';
import type { JourneyInsightCode } from './journey.constants';

/**
 * Patient Journey — pure shaping. Takes raw SQL-aggregate rows (already
 * `::int`/float8-typed numbers, see `journey-sql.ts`) and produces the
 * response pieces. No I/O, no Date.now() — every "now"-like input is
 * passed in, so this is fully unit-testable without a database.
 */

/** Round a minutes/hours value to 1 dp; `null`/non-finite stays `null`. */
export function round1(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

/** Round a rate/share to 3 dp (percentages are formatted client-side). */
export function round3(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

export function shapeCoverage(
  numerator: number,
  denominator: number,
): JourneyCoverage {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? round3(numerator / denominator) : null,
  };
}

interface SuppressionInput {
  n: number;
  minSample: number;
  coverage?: number | null;
  minCoverage?: number;
  neverUsed?: boolean;
}

/**
 * Suppression precedence (plan §6): a source that was NEVER used beats low
 * coverage, which beats a merely-small sample. A suppressed value is
 * reported as `null`, never a misleading `0` — `n`/`invalid` stay visible
 * so the caller can see WHY (a genuinely 0-coverage clinic looks different
 * from a 3-appointment sample).
 */
export function suppressionFor(
  input: SuppressionInput,
): JourneySuppression | null {
  if (input.neverUsed) return 'NOT_TRACKED';
  if (
    input.coverage != null &&
    input.minCoverage != null &&
    input.coverage < input.minCoverage
  ) {
    return 'LOW_COVERAGE';
  }
  if (input.n < input.minSample) return 'INSUFFICIENT_SAMPLE';
  return null;
}

export function shapeDistribution(
  n: number,
  invalid: number,
  p50: number | null,
  p90: number | null,
  suppression: SuppressionInput,
): JourneyDistribution {
  const suppressed = suppressionFor(suppression);
  return {
    n,
    invalid,
    p50: suppressed ? null : round1(p50),
    p90: suppressed ? null : round1(p90),
    suppressed,
  };
}

export function shapeDistributionWithP75(
  n: number,
  invalid: number,
  p50: number | null,
  p75: number | null,
  p90: number | null,
  suppression: SuppressionInput,
): JourneyDistributionWithP75 {
  const base = shapeDistribution(n, invalid, p50, p90, suppression);
  return { ...base, p75: base.suppressed ? null : round1(p75) };
}

// ─────────────────────────────── Counts ────────────────────────────────── //

/** Same definitions as `AnalyticsAggregationService.computeRates` (parity — see the aggregation spec). */
export function shapeCounts(o: JourneyOverallRow): JourneyCounts {
  return {
    booked: o.booked,
    cancelled: o.cancelled,
    noShow: o.no_show,
    completed: o.completed,
    inProgress: o.in_progress,
    upcoming: o.upcoming,
    unresolvedPast: o.unresolved_past,
    arrived: o.arrived,
    called: o.called,
    consultationStarted: o.started,
    noShowRate: o.booked > 0 ? round3(o.no_show / o.booked) : null,
    completionRate: o.booked > 0 ? round3(o.completed / o.booked) : null,
  };
}

// ─────────────────────────────── Coverage ──────────────────────────────── //

export interface ShapedCoverages {
  queue: JourneyCoverage;
  consultationTiming: JourneyCoverage;
  queueNeverUsed: boolean;
  timingNeverUsed: boolean;
}

export function shapeJourneyCoverages(o: JourneyOverallRow): ShapedCoverages {
  const queue = shapeCoverage(o.completed_with_queue, o.completed);
  const consultationTiming = shapeCoverage(
    o.completed_with_timing,
    o.completed,
  );
  return {
    queue,
    consultationTiming,
    queueNeverUsed: o.completed > 0 && o.completed_with_queue === 0,
    timingNeverUsed: o.completed > 0 && o.completed_with_timing === 0,
  };
}

// ─────────────────────────────── KPIs ──────────────────────────────────── //

export function shapeKpis(
  o: JourneyOverallRow,
  minSample: number,
  cov: ShapedCoverages,
): JourneyKpis {
  const queueSup = (n: number): SuppressionInput => ({
    n,
    minSample,
    coverage: cov.queue.rate,
    minCoverage: JOURNEY_THRESHOLDS.MIN_COVERAGE,
    neverUsed: cov.queueNeverUsed,
  });
  const timingSup = (n: number): SuppressionInput => ({
    n,
    minSample,
    coverage: cov.consultationTiming.rate,
    minCoverage: JOURNEY_THRESHOLDS.MIN_COVERAGE,
    neverUsed: cov.timingNeverUsed,
  });

  const arrivalOffset = shapeDistribution(
    o.arrival_n,
    o.arrival_invalid,
    o.arrival_p50,
    o.arrival_p90,
    queueSup(o.arrival_n),
  );
  const startDelay = shapeDistribution(
    o.start_delay_n,
    o.start_delay_invalid,
    o.start_delay_p50,
    o.start_delay_p90,
    timingSup(o.start_delay_n),
  );
  const consultation = shapeDistributionWithP75(
    o.consult_n,
    0,
    o.consult_p50,
    o.consult_p75,
    o.consult_p90,
    timingSup(o.consult_n),
  );
  const overrun = shapeDistribution(
    o.consult_n,
    0,
    o.overrun_p50,
    o.overrun_p90,
    timingSup(o.consult_n),
  );

  return {
    waitToStart: shapeDistribution(
      o.wait_start_n,
      o.wait_start_invalid,
      o.wait_start_p50,
      o.wait_start_p90,
      queueSup(o.wait_start_n),
    ),
    readyDelay: shapeDistribution(
      o.ready_delay_n,
      o.ready_delay_invalid,
      o.ready_delay_p50,
      o.ready_delay_p90,
      queueSup(o.ready_delay_n),
    ),
    startDelay: {
      ...startDelay,
      fromQueue: o.start_from_queue,
      fromStatusLog: o.start_from_log,
    },
    consultation,
    overrun,
    arrivalOffset: {
      ...arrivalOffset,
      lateShare: arrivalOffset.suppressed
        ? null
        : o.arrival_n > 0
          ? round3(o.arrival_late_n / o.arrival_n)
          : null,
    },
    waitForCall: shapeDistribution(
      o.wait_call_n,
      o.wait_call_invalid,
      o.wait_call_p50,
      o.wait_call_p90,
      queueSup(o.wait_call_n),
    ),
    callToStart: shapeDistribution(
      o.call_start_n,
      o.call_start_invalid,
      o.call_start_p50,
      o.call_start_p90,
      queueSup(o.call_start_n),
    ),
    visitTime: shapeDistribution(
      o.visit_n,
      o.visit_invalid,
      o.visit_p50,
      o.visit_p90,
      queueSup(o.visit_n),
    ),
    bookingLeadHours: shapeDistribution(
      o.lead_n,
      o.lead_invalid,
      o.lead_p50,
      o.lead_p90,
      { n: o.lead_n, minSample },
    ),
  };
}

// ─────────────────────────────── Stages ────────────────────────────────── //

export function shapeStages(
  o: JourneyOverallRow,
  kpis: JourneyKpis,
): JourneyStage[] {
  const stages: Record<JourneyStageKey, JourneyStage> = {
    BOOKING: {
      key: 'BOOKING',
      tracked: true,
      metricKey: 'journey.booking_lead_time',
      source: 'APPOINTMENT',
      unit: 'hours',
      count: o.booked,
      duration: kpis.bookingLeadHours,
    },
    REMINDER: {
      key: 'REMINDER',
      tracked: true,
      metricKey: 'journey.reminder_coverage',
      source: 'REMINDERS',
      unit: null,
      count: o.rem_reminded,
      duration: null,
    },
    ARRIVAL: {
      key: 'ARRIVAL',
      tracked: true,
      metricKey: 'journey.arrival_offset',
      source: 'QUEUE',
      unit: 'minutes',
      count: o.arrived,
      duration: {
        n: kpis.arrivalOffset.n,
        invalid: kpis.arrivalOffset.invalid,
        p50: kpis.arrivalOffset.p50,
        p90: kpis.arrivalOffset.p90,
        suppressed: kpis.arrivalOffset.suppressed,
      },
    },
    WAIT_FOR_CALL: {
      key: 'WAIT_FOR_CALL',
      tracked: true,
      metricKey: 'journey.wait_for_call',
      source: 'QUEUE',
      unit: 'minutes',
      count: o.called,
      duration: kpis.waitForCall,
    },
    CALL_TO_START: {
      key: 'CALL_TO_START',
      tracked: true,
      metricKey: 'journey.call_to_start',
      source: 'QUEUE',
      unit: 'minutes',
      count: o.started,
      duration: kpis.callToStart,
    },
    CONSULTATION: {
      key: 'CONSULTATION',
      tracked: true,
      metricKey: 'journey.consultation_duration',
      source: 'QUEUE_OR_STATUS_LOG',
      unit: 'minutes',
      count: o.completed_with_timing,
      duration: {
        n: kpis.consultation.n,
        invalid: kpis.consultation.invalid,
        p50: kpis.consultation.p50,
        p90: kpis.consultation.p90,
        suppressed: kpis.consultation.suppressed,
      },
    },
    COMPLETION: {
      key: 'COMPLETION',
      tracked: true,
      metricKey: 'appointments.completed',
      source: 'QUEUE_OR_STATUS_LOG',
      unit: null,
      count: o.completed,
      duration: null,
    },
    CHECKOUT: {
      key: 'CHECKOUT',
      tracked: false,
      metricKey: null,
      source: null,
      unit: null,
      count: null,
      duration: null,
    },
    FEEDBACK: {
      key: 'FEEDBACK',
      tracked: false,
      metricKey: null,
      source: null,
      unit: null,
      count: null,
      duration: null,
    },
  };
  return JOURNEY_STAGE_KEYS.map((k) => stages[k]);
}

// ────────────────────────────── Data quality ───────────────────────────── //

export function shapeDataQuality(o: JourneyOverallRow): JourneyDataQuality {
  const untracked = (
    Object.keys(JOURNEY_TRACKED_STAGES) as JourneyStageKey[]
  ).filter((k) => !JOURNEY_TRACKED_STAGES[k]);
  return {
    invalidIntervals: {
      bookingLead: o.lead_invalid,
      arrivalOffset: o.arrival_invalid,
      waitForCall: o.wait_call_invalid,
      callToStart: o.call_start_invalid,
      waitToStart: o.wait_start_invalid,
      readyDelay: o.ready_delay_invalid,
      startDelay: o.start_delay_invalid,
      consultation: o.consult_invalid,
      visitTime: o.visit_invalid,
    },
    consultationTooShort: o.consult_too_short,
    completedWithoutStart: o.completed_without_start,
    sweptQueueEntries: o.swept,
    multiServiceAppointments: o.multi_service,
    timezoneFallback: o.tz_fallback,
    unresolvedPast: o.unresolved_past,
    untrackedStages: untracked,
    notes: [
      'PLAIN_TIMESTAMP_SESSION_TZ',
      'RECALL_OVERWRITES_CALL_TIME',
      'DELIVERY_STATUS_NOT_USED',
    ],
  };
}

// ─────────────────────────────── Comparison ────────────────────────────── //

export function shapeComparison(
  prior: JourneyOverallRow | null,
  priorRange: { from: string; to: string } | null,
  rangeDays: number,
): {
  comparison: JourneyComparisonPoint | null;
  comparisonUnavailable: 'RANGE_TOO_WIDE' | 'NO_PRIOR_DATA' | null;
} {
  if (rangeDays > JOURNEY_THRESHOLDS.MAX_COMPARISON_RANGE_DAYS) {
    return { comparison: null, comparisonUnavailable: 'RANGE_TOO_WIDE' };
  }
  if (!prior || !priorRange || prior.booked === 0) {
    return { comparison: null, comparisonUnavailable: 'NO_PRIOR_DATA' };
  }
  return {
    comparison: {
      range: priorRange,
      waitToStartP50: round1(prior.wait_start_p50),
      readyDelayP50: round1(prior.ready_delay_p50),
      consultationP50: round1(prior.consult_p50),
      noShowRate:
        prior.booked > 0 ? round3(prior.no_show / prior.booked) : null,
    },
    comparisonUnavailable: null,
  };
}

// ─────────────────────────────── Reminders ─────────────────────────────── //

export function shapeReminders(
  o: JourneyOverallRow,
  rows: JourneyReminderRow[],
  settings: { remindersEnabled: boolean; reminderLeadMinutes: number[] },
): JourneyRemindersInfo {
  if (rows.length === 0) {
    return {
      available: false,
      enabled: settings.remindersEnabled,
      reason: settings.remindersEnabled ? 'NO_REMINDER_ROWS' : 'NOT_ENABLED',
    };
  }

  let sent = 0;
  let failed = 0;
  let cancelled = 0;
  let pending = 0;
  let stuck = 0;
  const byLead = new Map<number, { sent: number; failed: number }>();
  const byChannel = new Map<
    'WHATSAPP' | 'EMAIL' | 'UNKNOWN',
    { sent: number; failed: number }
  >();
  const byReason = new Map<string, number>();

  for (const r of rows) {
    stuck += r.stuck;
    if (r.outcome === 'SENT') sent += r.n;
    else if (r.outcome === 'FAILED') failed += r.n;
    else if (r.outcome === 'CANCELLED') cancelled += r.n;
    else pending += r.n;

    if (r.lead_minutes != null) {
      const e = byLead.get(r.lead_minutes) ?? { sent: 0, failed: 0 };
      if (r.outcome === 'SENT') e.sent += r.n;
      if (r.outcome === 'FAILED') e.failed += r.n;
      byLead.set(r.lead_minutes, e);
    }

    const channel: 'WHATSAPP' | 'EMAIL' | 'UNKNOWN' =
      r.channel === 'WHATSAPP' || r.channel === 'EMAIL' ? r.channel : 'UNKNOWN';
    const ce = byChannel.get(channel) ?? { sent: 0, failed: 0 };
    if (r.outcome === 'SENT') ce.sent += r.n;
    if (r.outcome === 'FAILED') ce.failed += r.n;
    byChannel.set(channel, ce);

    if (r.outcome === 'FAILED') {
      const known = (JOURNEY_KNOWN_SKIP_REASONS as readonly string[]).includes(
        r.skip_reason ?? '',
      );
      const reason = known ? (r.skip_reason as string) : 'OTHER';
      byReason.set(reason, (byReason.get(reason) ?? 0) + r.n);
    }
  }

  const remindedResolved = o.resolved_reminded;
  const remindedNoShow = o.no_show_reminded;
  const notRemindedResolved = o.resolved_not_reminded;
  const notRemindedNoShow = o.no_show_not_reminded;

  return {
    available: true,
    enabled: settings.remindersEnabled,
    configuredLeadMinutes: settings.reminderLeadMinutes,
    appointments: {
      eligible: o.rem_eligible,
      withReminderRow: o.rem_with_row,
      reminded: o.rem_reminded,
      failedOnly: o.rem_failed_only,
      noReminderRow: Math.max(0, o.rem_eligible - o.rem_with_row),
    },
    rows: {
      sent,
      failed,
      cancelled,
      pending,
      stuck,
      failureRate: sent + failed > 0 ? round3(failed / (sent + failed)) : null,
    },
    byLeadTime: [...byLead.entries()]
      .map(([leadMinutes, v]) => ({ leadMinutes, ...v }))
      .sort((a, b) => a.leadMinutes - b.leadMinutes),
    byChannel: [...byChannel.entries()].map(([channel, v]) => ({
      channel,
      ...v,
    })),
    failureReasons: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    attendance: {
      reminded: {
        resolved: remindedResolved,
        noShow: remindedNoShow,
        share:
          remindedResolved > 0
            ? round3(remindedNoShow / remindedResolved)
            : null,
      },
      notReminded: {
        resolved: notRemindedResolved,
        noShow: notRemindedNoShow,
        share:
          notRemindedResolved > 0
            ? round3(notRemindedNoShow / notRemindedResolved)
            : null,
      },
      comparable:
        remindedResolved >= JOURNEY_THRESHOLDS.MIN_SAMPLE_RULE &&
        notRemindedResolved >= JOURNEY_THRESHOLDS.MIN_SAMPLE_RULE,
    },
    deliveryTracking: 'NOT_RELIABLE',
  };
}

// ───────────────────────────── Duration suggestions ────────────────────── //

export interface ServiceLabel {
  name: string;
  inactive: boolean;
  configuredMinutes: number | null;
}

/** `ceil(p75 / 5) * 5`, clamped [5, 480] minutes (plan §9). */
export function suggestDurationMinutes(p75: number): number {
  const rounded =
    Math.ceil(p75 / JOURNEY_RULE_THRESHOLDS.DURATION_ROUND_TO_MINUTES) *
    JOURNEY_RULE_THRESHOLDS.DURATION_ROUND_TO_MINUTES;
  return Math.min(
    JOURNEY_RULE_THRESHOLDS.DURATION_MAX_MINUTES,
    Math.max(JOURNEY_RULE_THRESHOLDS.DURATION_MIN_MINUTES, rounded),
  );
}

/**
 * The single evaluation of every duration-suggestion gate for one service
 * row. Both the suggestion list and the candidate list (which explains WHY a
 * service produced no suggestion) go through this, so the gates cannot drift
 * apart. Order is the original gate order; no threshold is changed here.
 */
export function evaluateDurationRow(
  row: JourneyDimensionRow,
  label: ServiceLabel,
): {
  status: JourneyDurationCandidateStatus;
  coverage: JourneyCoverage;
  suggested: number | null;
} {
  const coverage = shapeCoverage(row.completed_with_timing, row.completed);
  if (label.inactive) {
    return { status: 'SERVICE_INACTIVE', coverage, suggested: null };
  }
  if (row.consult_n < JOURNEY_THRESHOLDS.MIN_SAMPLE_DURATION_SUGGESTION) {
    return { status: 'INSUFFICIENT_SAMPLE', coverage, suggested: null };
  }
  if (coverage.rate == null || coverage.rate < JOURNEY_THRESHOLDS.MIN_COVERAGE) {
    return { status: 'LOW_TIMING_COVERAGE', coverage, suggested: null };
  }
  if (row.consult_p75 == null) {
    return { status: 'NO_PERCENTILE', coverage, suggested: null };
  }

  const suggested = suggestDurationMinutes(row.consult_p75);
  const configured = label.configuredMinutes;
  if (configured != null) {
    const delta = Math.abs(suggested - configured);
    const minDelta = Math.max(
      JOURNEY_RULE_THRESHOLDS.DURATION_SUGGESTION_MIN_DELTA_MINUTES,
      configured * JOURNEY_RULE_THRESHOLDS.DURATION_SUGGESTION_MIN_DELTA_RATIO,
    );
    if (delta < minDelta) {
      return { status: 'ALREADY_ALIGNED', coverage, suggested };
    }
  }
  return { status: 'OK', coverage, suggested };
}

function buildDurationCandidate(
  row: JourneyDimensionRow,
  label: ServiceLabel,
): JourneyDurationCandidate {
  const { status, coverage, suggested } = evaluateDurationRow(row, label);
  const configured = label.configuredMinutes;
  return {
    serviceId: row.dim_key,
    name: label.name,
    inactive: label.inactive,
    configuredMinutes: configured,
    scheduledP50: round1(row.scheduled_p50),
    // Sample-gated like every other distribution: below the minimum sample
    // the percentiles stay null while `n` remains visible.
    consultation: shapeDistributionWithP75(
      row.consult_n,
      0,
      row.consult_p50,
      row.consult_p75,
      row.consult_p90,
      {
        n: row.consult_n,
        minSample: JOURNEY_THRESHOLDS.MIN_SAMPLE_DURATION_SUGGESTION,
      },
    ),
    coverage,
    suggestedMinutes: suggested,
    direction:
      status !== 'OK' || configured == null || suggested == null
        ? null
        : suggested > configured
          ? 'LONGER'
          : 'SHORTER',
    status,
  };
}

function durationDelta(s: {
  configuredMinutes: number | null;
  suggestedMinutes: number | null;
}): number {
  return s.configuredMinutes == null
    ? 0
    : Math.abs((s.suggestedMinutes ?? 0) - s.configuredMinutes);
}

export function shapeDurationSuggestions(
  serviceRows: JourneyDimensionRow[],
  labels: Map<string, ServiceLabel>,
): JourneyDurationSuggestion[] {
  const out: JourneyDurationSuggestion[] = [];

  for (const row of serviceRows) {
    const label = labels.get(row.dim_key);
    if (!label) continue;
    const candidate = buildDurationCandidate(row, label);
    if (candidate.status !== 'OK') continue;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { status, ...suggestion } = candidate;
    out.push(suggestion);
  }

  out.sort((a, b) => durationDelta(b) - durationDelta(a));

  return out.slice(0, JOURNEY_THRESHOLDS.MAX_DURATION_SUGGESTIONS);
}

const CANDIDATE_STATUS_RANK: Record<JourneyDurationCandidateStatus, number> = {
  OK: 0,
  ALREADY_ALIGNED: 1,
  INSUFFICIENT_SAMPLE: 2,
  LOW_TIMING_COVERAGE: 3,
  NO_PERCENTILE: 4,
  SERVICE_INACTIVE: 5,
};

/**
 * Explains the duration-suggestion outcome per service: one candidate per
 * service that had appointments in scope, each carrying the gate it stopped
 * at, plus a panel-level `state` when there is nothing per-service to show.
 * Reporting only — it never changes which suggestions exist.
 *
 * `activeServiceCount` is the tenant-wide count; `undefined` (a blob cached
 * before the field existed) means unknown, so "no services configured" is
 * never asserted without evidence. The state is derived from the FULL list,
 * before the payload cap, so truncation cannot change the explanation.
 */
export function shapeDurationExplanation(
  serviceRows: JourneyDimensionRow[],
  labels: Map<string, ServiceLabel>,
  activeServiceCount: number | undefined,
): {
  candidates: JourneyDurationCandidate[];
  state: JourneyDurationSuggestionsState | null;
} {
  const all: JourneyDurationCandidate[] = [];
  for (const row of serviceRows) {
    const label = labels.get(row.dim_key);
    if (!label) continue;
    all.push(buildDurationCandidate(row, label));
  }

  const live = all.filter((c) => c.status !== 'SERVICE_INACTIVE');
  const state: JourneyDurationSuggestionsState | null =
    activeServiceCount === 0
      ? 'NO_SERVICES_CONFIGURED'
      : live.length === 0
        ? 'NO_SERVICE_APPOINTMENTS'
        : live.every((c) => c.consultation.n === 0)
          ? 'NO_TIMED_CONSULTATIONS'
          : null;

  all.sort(
    (a, b) =>
      CANDIDATE_STATUS_RANK[a.status] - CANDIDATE_STATUS_RANK[b.status] ||
      (a.status === 'OK' ? durationDelta(b) - durationDelta(a) : 0) ||
      b.consultation.n - a.consultation.n ||
      a.name.localeCompare(b.name),
  );

  return {
    candidates: all.slice(0, JOURNEY_THRESHOLDS.MAX_DURATION_CANDIDATES),
    state,
  };
}

// ─────────────────────────────── Breakdown rows ────────────────────────── //

/**
 * One breakdown table/chart row. `flags` is left empty here — the caller
 * (`PatientJourneyService`) fills it in after `generateInsights` runs on
 * the FULL aggregate, by matching each insight's `scope.dimension`/`key`
 * back to this row (this function only shapes one row's own numbers, it
 * never sees the other dimensions or the insight list).
 */
export function shapeBreakdownRow(
  row: JourneyDimensionRow,
  label: JourneyLabelInfo | null,
  minSample: number,
): JourneyBreakdownRow {
  const queueCoverage = shapeCoverage(row.completed_with_queue, row.completed);
  const timingCoverage = shapeCoverage(
    row.completed_with_timing,
    row.completed,
  );
  const queueNeverUsed = row.completed > 0 && row.completed_with_queue === 0;
  const timingNeverUsed = row.completed > 0 && row.completed_with_timing === 0;

  const queueSup = (n: number): SuppressionInput => ({
    n,
    minSample,
    coverage: queueCoverage.rate,
    minCoverage: JOURNEY_THRESHOLDS.MIN_COVERAGE,
    neverUsed: queueNeverUsed,
  });
  const timingSup = (n: number): SuppressionInput => ({
    n,
    minSample,
    coverage: timingCoverage.rate,
    minCoverage: JOURNEY_THRESHOLDS.MIN_COVERAGE,
    neverUsed: timingNeverUsed,
  });

  const suggestedMinutes =
    row.consult_n >= JOURNEY_THRESHOLDS.MIN_SAMPLE_DURATION_SUGGESTION &&
    row.consult_p75 != null
      ? suggestDurationMinutes(row.consult_p75)
      : undefined;

  const flags: JourneyInsightCode[] = [];

  return {
    key: row.dim_key,
    label: label?.name ?? null,
    inactive: label?.inactive,
    appointments: row.booked,
    completed: row.completed,
    noShow: row.no_show,
    noShowRate: row.booked > 0 ? round3(row.no_show / row.booked) : null,
    queueCoverage,
    waitToStart: shapeDistribution(
      row.wait_start_n,
      row.wait_start_invalid,
      row.wait_start_p50,
      row.wait_start_p90,
      queueSup(row.wait_start_n),
    ),
    readyDelay: shapeDistribution(
      row.ready_delay_n,
      row.ready_delay_invalid,
      row.ready_delay_p50,
      row.ready_delay_p90,
      queueSup(row.ready_delay_n),
    ),
    startDelay: shapeDistribution(
      row.start_delay_n,
      row.start_delay_invalid,
      row.start_delay_p50,
      row.start_delay_p90,
      timingSup(row.start_delay_n),
    ),
    consultation: shapeDistributionWithP75(
      row.consult_n,
      0,
      row.consult_p50,
      row.consult_p75,
      row.consult_p90,
      timingSup(row.consult_n),
    ),
    overrun: shapeDistribution(
      row.consult_n,
      0,
      row.overrun_p50,
      row.overrun_p90,
      timingSup(row.consult_n),
    ),
    remindedShare:
      row.rem_eligible > 0 ? round3(row.rem_reminded / row.rem_eligible) : null,
    configuredMinutes: label?.configuredMinutes ?? undefined,
    suggestedMinutes,
    flags,
  };
}
