import {
  evaluateDurationRow,
  round1,
  round3,
  shapeCoverage,
} from './journey-shaping';
import {
  JOURNEY_ACTION_CODE,
  JOURNEY_ACTION_ROUTE,
  JOURNEY_CAUSE_CODE,
  JOURNEY_DQ_CODE,
  JOURNEY_ALERT_CODE,
  JOURNEY_INSIGHT_KIND,
  JOURNEY_RECOMMENDATION_CODE,
  JOURNEY_RULE_THRESHOLDS,
  JOURNEY_SEVERITY,
  JOURNEY_THRESHOLDS,
  JOURNEY_TRACKED_STAGES,
} from './journey.constants';
import type {
  JourneyActionCode,
  JourneyCauseCode,
  JourneyDimension,
  JourneyStageKey,
} from './journey.constants';
import type {
  JourneyDimensionRow,
  JourneyInsight,
  JourneyKpis,
  JourneyOverallRow,
  JourneyRemindersInfo,
} from './journey.types';
import type { MetricKey } from '../metric-registry';

/**
 * Patient Journey — the deterministic rule engine (plan §8/§9). Pure: takes
 * already-shaped/raw aggregate data and returns a ranked, capped insight
 * list. No AI, no per-tenant thresholds (see the plan's "Thresholds"
 * decision) — every number here comes from `JOURNEY_RULE_THRESHOLDS`, one
 * reviewable file.
 *
 * Every rule requires a minimum sample BEFORE looking at its threshold, and
 * every relative ("increased"/"outlier") rule also requires a minimum
 * absolute difference, not just a ratio — a clinic with 2 appointments
 * jumping to 3 is a 50% "increase" that means nothing.
 */

export interface JourneyLabel {
  name: string;
  inactive?: boolean;
  configuredMinutes?: number | null;
}

export interface JourneyInsightsInput {
  overall: JourneyOverallRow;
  priorOverall: JourneyOverallRow | null;
  kpis: JourneyKpis;
  queueCoverageRate: number | null;
  remindersEnabled: boolean;
  reminders: JourneyRemindersInfo;
  dimensions: {
    branch: JourneyDimensionRow[];
    staff: JourneyDimensionRow[];
    service: JourneyDimensionRow[];
    hour: JourneyDimensionRow[];
  };
  labels: {
    branch: Map<string, JourneyLabel>;
    staff: Map<string, JourneyLabel>;
    service: Map<string, JourneyLabel>;
  };
}

const MIN_RULE = JOURNEY_THRESHOLDS.MIN_SAMPLE_RULE;
const T = JOURNEY_RULE_THRESHOLDS;

function baseInsight(
  partial: Omit<JourneyInsight, 'params' | 'causes' | 'cta'> & {
    params?: Record<string, string | number>;
    causes?: { key: JourneyCauseCode; params: Record<string, number> }[];
  },
): JourneyInsight {
  const cta = partial.actionKey
    ? { route: JOURNEY_ACTION_ROUTE[partial.actionKey] }
    : null;
  return { params: {}, causes: [], ...partial, cta };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ─────────────────────────────── Data quality ──────────────────────────── //

function dataQualityRules(
  o: JourneyOverallRow,
  queueCoverageRate: number | null,
): JourneyInsight[] {
  const out: JourneyInsight[] = [];

  const queueNeverUsed = o.completed > 0 && o.completed_with_queue === 0;
  if (o.completed >= MIN_RULE && queueNeverUsed) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.QUEUE_NOT_USED,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.INFO,
        metric: 'journey.queue_coverage',
        scope: { dimension: 'clinic', key: null, label: null },
        observed: 0,
        threshold: null,
        baseline: null,
        sample: { n: o.completed, min: MIN_RULE },
        params: { completed: o.completed },
        actionKey: JOURNEY_ACTION_CODE.USE_QUEUE_CHECK_IN,
        dataSources: ['queue_entries', 'appointments'],
      }),
    );
  } else if (
    o.completed >= MIN_RULE &&
    queueCoverageRate != null &&
    queueCoverageRate > 0 &&
    queueCoverageRate < T.QUEUE_COVERAGE_LOW_FLOOR
  ) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.QUEUE_COVERAGE_LOW,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.WARNING,
        metric: 'journey.queue_coverage',
        scope: { dimension: 'clinic', key: null, label: null },
        observed: round3(queueCoverageRate),
        threshold: T.QUEUE_COVERAGE_LOW_FLOOR,
        baseline: { kind: 'ABSOLUTE', value: T.QUEUE_COVERAGE_LOW_FLOOR },
        sample: { n: o.completed, min: MIN_RULE },
        params: {
          coveragePct: round1((queueCoverageRate ?? 0) * 100) ?? 0,
          withQueue: o.completed_with_queue,
          completed: o.completed,
        },
        actionKey: JOURNEY_ACTION_CODE.USE_QUEUE_CHECK_IN,
        dataSources: ['queue_entries', 'appointments'],
      }),
    );
  }

  if (
    o.completed >= MIN_RULE &&
    o.completed_without_start / o.completed >
      T.CONSULTATION_START_NOT_RECORDED_SHARE
  ) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.CONSULTATION_START_NOT_RECORDED,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.INFO,
        metric: 'journey.consultation_duration',
        scope: { dimension: 'clinic', key: null, label: null },
        observed: round3(o.completed_without_start / o.completed),
        threshold: T.CONSULTATION_START_NOT_RECORDED_SHARE,
        baseline: {
          kind: 'ABSOLUTE',
          value: T.CONSULTATION_START_NOT_RECORDED_SHARE,
        },
        sample: { n: o.completed, min: MIN_RULE },
        params: {
          sharePct:
            round1((o.completed_without_start / o.completed) * 100) ?? 0,
          count: o.completed_without_start,
        },
        actionKey: JOURNEY_ACTION_CODE.START_CONSULTATION_IN_SYSTEM,
        dataSources: ['appointment_status_logs', 'queue_entries'],
      }),
    );
  }

  if (
    o.past >= MIN_RULE &&
    o.unresolved_past >= T.UNRESOLVED_MIN_COUNT &&
    o.unresolved_past / o.past >= T.UNRESOLVED_MIN_SHARE
  ) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.UNRESOLVED_APPOINTMENTS,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.WARNING,
        metric: 'journey.stage_counts',
        scope: { dimension: 'clinic', key: null, label: null },
        observed: o.unresolved_past,
        threshold: T.UNRESOLVED_MIN_COUNT,
        baseline: { kind: 'ABSOLUTE', value: T.UNRESOLVED_MIN_COUNT },
        sample: { n: o.past, min: MIN_RULE },
        params: {
          count: o.unresolved_past,
          sharePct: round1((o.unresolved_past / o.past) * 100) ?? 0,
        },
        actionKey: JOURNEY_ACTION_CODE.CLOSE_OUT_APPOINTMENTS,
        dataSources: ['appointments'],
      }),
    );
  }

  if (
    o.arrived >= MIN_RULE &&
    o.swept >= T.SWEPT_MIN_COUNT &&
    o.swept / o.arrived >= T.SWEPT_MIN_SHARE
  ) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.QUEUE_ENTRIES_LEFT_OPEN,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.WARNING,
        metric: 'journey.queue_coverage',
        scope: { dimension: 'clinic', key: null, label: null },
        observed: o.swept,
        threshold: T.SWEPT_MIN_COUNT,
        baseline: { kind: 'ABSOLUTE', value: T.SWEPT_MIN_COUNT },
        sample: { n: o.arrived, min: MIN_RULE },
        params: {
          count: o.swept,
          sharePct: round1((o.swept / o.arrived) * 100) ?? 0,
        },
        actionKey: JOURNEY_ACTION_CODE.CLOSE_QUEUE_ENTRIES,
        dataSources: ['queue_entries'],
      }),
    );
  }

  const invalidStages: {
    key: JourneyStageKey;
    metric: MetricKey;
    n: number;
    invalid: number;
  }[] = [
    {
      key: 'ARRIVAL',
      metric: 'journey.arrival_offset',
      n: o.arrival_n,
      invalid: o.arrival_invalid,
    },
    {
      key: 'WAIT_FOR_CALL',
      metric: 'journey.wait_for_call',
      n: o.wait_call_n,
      invalid: o.wait_call_invalid,
    },
    {
      key: 'CALL_TO_START',
      metric: 'journey.call_to_start',
      n: o.call_start_n,
      invalid: o.call_start_invalid,
    },
    {
      key: 'CONSULTATION',
      metric: 'journey.consultation_duration',
      n: o.consult_n,
      invalid: o.consult_invalid,
    },
  ];
  for (const s of invalidStages) {
    const total = s.n + s.invalid;
    if (total >= MIN_RULE && s.invalid / total >= T.IMPLAUSIBLE_MIN_SHARE) {
      out.push(
        baseInsight({
          code: JOURNEY_DQ_CODE.IMPLAUSIBLE_TIMESTAMPS,
          kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
          severity: JOURNEY_SEVERITY.INFO,
          metric: s.metric,
          scope: { dimension: 'clinic', key: null, label: s.key },
          observed: round3(s.invalid / total),
          threshold: T.IMPLAUSIBLE_MIN_SHARE,
          baseline: { kind: 'ABSOLUTE', value: T.IMPLAUSIBLE_MIN_SHARE },
          sample: { n: total, min: MIN_RULE },
          params: { stage: s.key, invalid: s.invalid, total },
          actionKey: JOURNEY_ACTION_CODE.RECORD_QUEUE_STEPS_LIVE,
          dataSources: ['queue_entries', 'appointment_status_logs'],
        }),
      );
    }
  }

  return out;
}

function reminderDataQualityRules(
  o: JourneyOverallRow,
  remindersEnabled: boolean,
): JourneyInsight[] {
  const out: JourneyInsight[] = [];
  if (o.booked < MIN_RULE) return out;

  if (!remindersEnabled && o.rem_with_row === 0) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.REMINDERS_DISABLED,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.INFO,
        metric: 'journey.reminder_coverage',
        scope: { dimension: 'clinic', key: null, label: null },
        observed: null,
        threshold: null,
        baseline: null,
        sample: { n: o.booked, min: MIN_RULE },
        params: {},
        actionKey: JOURNEY_ACTION_CODE.ENABLE_REMINDERS,
        dataSources: ['tenant_settings', 'scheduled_notifications'],
      }),
    );
  } else if (
    remindersEnabled &&
    o.rem_eligible >= MIN_RULE &&
    o.rem_with_row === 0
  ) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.REMINDERS_NOT_SCHEDULED,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.WARNING,
        metric: 'journey.reminder_coverage',
        scope: { dimension: 'clinic', key: null, label: null },
        observed: 0,
        threshold: null,
        baseline: null,
        sample: { n: o.rem_eligible, min: MIN_RULE },
        params: { eligible: o.rem_eligible },
        actionKey: JOURNEY_ACTION_CODE.CONFIGURE_REMINDER_TEMPLATE,
        dataSources: ['tenant_settings', 'scheduled_notifications'],
      }),
    );
  }
  return out;
}

function untrackedStageRules(o: JourneyOverallRow): JourneyInsight[] {
  if (o.booked === 0) return [];
  const out: JourneyInsight[] = [];
  if (!JOURNEY_TRACKED_STAGES.CHECKOUT) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.CHECKOUT_NOT_TRACKED,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.INFO,
        metric: null,
        scope: { dimension: 'clinic', key: null, label: null },
        observed: null,
        threshold: null,
        baseline: null,
        sample: { n: 0, min: 0 },
        params: {},
        actionKey: null,
        dataSources: [],
      }),
    );
  }
  if (!JOURNEY_TRACKED_STAGES.FEEDBACK) {
    out.push(
      baseInsight({
        code: JOURNEY_DQ_CODE.FEEDBACK_NOT_COLLECTED,
        kind: JOURNEY_INSIGHT_KIND.DATA_QUALITY,
        severity: JOURNEY_SEVERITY.INFO,
        metric: null,
        scope: { dimension: 'clinic', key: null, label: null },
        observed: null,
        threshold: null,
        baseline: null,
        sample: { n: 0, min: 0 },
        params: {},
        actionKey: null,
        dataSources: [],
      }),
    );
  }
  return out;
}

// ─────────────────────────────── Causes ────────────────────────────────── //

function causesForWait(
  o: JourneyOverallRow,
  kpis: JourneyKpis,
): { key: JourneyCauseCode; params: Record<string, number> }[] {
  const causes: { key: JourneyCauseCode; params: Record<string, number> }[] =
    [];
  const arrivalP50 = kpis.arrivalOffset.suppressed
    ? null
    : kpis.arrivalOffset.p50;
  if (arrivalP50 != null && arrivalP50 <= T.EARLY_ARRIVAL_CAUSE_MAX_OFFSET) {
    causes.push({
      key: JOURNEY_CAUSE_CODE.EARLY_ARRIVAL,
      params: { p50: arrivalP50 },
    });
  } else if (
    arrivalP50 != null &&
    arrivalP50 >= T.LATE_ARRIVAL_CAUSE_MIN_OFFSET
  ) {
    causes.push({
      key: JOURNEY_CAUSE_CODE.LATE_ARRIVAL,
      params: { p50: arrivalP50 },
    });
  }
  const readyP50 = kpis.readyDelay.suppressed ? null : kpis.readyDelay.p50;
  if (readyP50 != null && readyP50 >= T.READY_DELAY_CAUSE_MIN_MINUTES) {
    causes.push({
      key: JOURNEY_CAUSE_CODE.START_DELAY_AFTER_READY,
      params: { p50: readyP50 },
    });
  }
  const overrunP50 = kpis.overrun.suppressed ? null : kpis.overrun.p50;
  if (overrunP50 != null && overrunP50 >= T.OVERRUN_CAUSE_MIN_MINUTES) {
    causes.push({
      key: JOURNEY_CAUSE_CODE.CONSULTATIONS_OVERRUN,
      params: { p50: overrunP50 },
    });
  }
  const callStartP50 = kpis.callToStart.suppressed
    ? null
    : kpis.callToStart.p50;
  if (callStartP50 != null && callStartP50 >= T.HANDOFF_GAP_CAUSE_MIN_MINUTES) {
    causes.push({
      key: JOURNEY_CAUSE_CODE.HANDOFF_GAP,
      params: { p50: callStartP50 },
    });
  }
  void o;
  return causes;
}

function peakHourConcentrationCause(
  hourRows: JourneyDimensionRow[],
  clinicP50: number | null,
): { key: JourneyCauseCode; params: Record<string, number> } | null {
  if (clinicP50 == null) return null;
  const overThreshold = hourRows
    .filter(
      (r) =>
        r.wait_start_n >= JOURNEY_THRESHOLDS.MIN_SAMPLE_BREAKDOWN_ROW &&
        r.wait_start_p50 != null,
    )
    .map((r) => ({
      hour: r.dim_key,
      n: r.wait_start_n,
      p50: r.wait_start_p50 as number,
    }))
    .filter((r) => r.p50 > clinicP50);
  if (overThreshold.length === 0) return null;
  const totalOverN = overThreshold.reduce((s, r) => s + r.n, 0);
  const concentrated = [...overThreshold]
    .sort((a, b) => b.n - a.n)
    .slice(0, T.PEAK_HOUR_CAUSE_MAX_HOURS);
  const concentratedN = concentrated.reduce((s, r) => s + r.n, 0);
  if (
    totalOverN === 0 ||
    concentratedN / totalOverN < T.PEAK_HOUR_CAUSE_CONCENTRATION_SHARE
  )
    return null;
  return {
    key: JOURNEY_CAUSE_CODE.PEAK_HOUR_CONCENTRATION,
    params: {
      hours: concentrated.length,
      sharePct: round1((concentratedN / totalOverN) * 100) ?? 0,
    },
  };
}

// ─────────────────────────────── Alerts ────────────────────────────────── //

function waitToStartAlerts(
  o: JourneyOverallRow,
  kpis: JourneyKpis,
  branches: JourneyDimensionRow[],
  branchLabels: Map<string, JourneyLabel>,
  hourRows: JourneyDimensionRow[],
): JourneyInsight[] {
  const out: JourneyInsight[] = [];

  const evaluate = (
    n: number,
    p50: number | null,
    p90: number | null,
    scope: {
      dimension: 'clinic' | JourneyDimension;
      key: string | null;
      label: string | null;
    },
    causes: { key: JourneyCauseCode; params: Record<string, number> }[],
  ) => {
    if (n < MIN_RULE || p50 == null) return;
    const critical =
      p50 >= T.WAIT_TO_START_CRIT_P50 ||
      (p90 != null && p90 >= T.WAIT_TO_START_CRIT_P90);
    const warning =
      p50 >= T.WAIT_TO_START_WARN_P50 ||
      (p90 != null && p90 >= T.WAIT_TO_START_WARN_P90);
    if (!critical && !warning) return;
    out.push(
      baseInsight({
        code: JOURNEY_ALERT_CODE.WAIT_TO_START_HIGH,
        kind: JOURNEY_INSIGHT_KIND.ALERT,
        severity: critical
          ? JOURNEY_SEVERITY.CRITICAL
          : JOURNEY_SEVERITY.WARNING,
        metric: 'journey.wait_to_start',
        scope,
        observed: p50,
        threshold: critical
          ? T.WAIT_TO_START_CRIT_P50
          : T.WAIT_TO_START_WARN_P50,
        baseline: {
          kind: 'ABSOLUTE',
          value: critical ? T.WAIT_TO_START_CRIT_P50 : T.WAIT_TO_START_WARN_P50,
        },
        sample: { n, min: MIN_RULE },
        params: { p50, p90: p90 ?? 0, n },
        causes,
        actionKey: JOURNEY_ACTION_CODE.REVIEW_PEAK_STAFFING,
        dataSources: ['queue_entries'],
      }),
    );
  };

  evaluate(
    o.wait_start_n,
    kpis.waitToStart.suppressed ? null : kpis.waitToStart.p50,
    kpis.waitToStart.p90,
    { dimension: 'clinic', key: null, label: null },
    causesForWait(o, kpis).concat(
      (() => {
        const c = peakHourConcentrationCause(
          hourRows,
          kpis.waitToStart.suppressed ? null : kpis.waitToStart.p50,
        );
        return c ? [c] : [];
      })(),
    ),
  );

  for (const row of branches) {
    if (row.wait_start_n < JOURNEY_THRESHOLDS.MIN_SAMPLE_BREAKDOWN_ROW)
      continue;
    const label = branchLabels.get(row.dim_key)?.name ?? null;
    evaluate(
      row.wait_start_n,
      row.wait_start_p50,
      row.wait_start_p90,
      {
        dimension: 'branch',
        key: row.dim_key,
        label,
      },
      [],
    );
  }

  return out;
}

function waitToStartIncreasedAlert(
  o: JourneyOverallRow,
  prior: JourneyOverallRow | null,
): JourneyInsight | null {
  if (!prior) return null;
  if (o.wait_start_n < MIN_RULE || prior.wait_start_n < MIN_RULE) return null;
  if (
    o.wait_start_p50 == null ||
    prior.wait_start_p50 == null ||
    prior.wait_start_p50 <= 0
  )
    return null;
  const delta = o.wait_start_p50 - prior.wait_start_p50;
  if (o.wait_start_p50 < prior.wait_start_p50 * T.WAIT_TO_START_INCREASE_RATIO)
    return null;
  if (delta < T.WAIT_TO_START_INCREASE_MIN_DELTA) return null;
  return baseInsight({
    code: JOURNEY_ALERT_CODE.WAIT_TO_START_INCREASED,
    kind: JOURNEY_INSIGHT_KIND.ALERT,
    severity: JOURNEY_SEVERITY.WARNING,
    metric: 'journey.wait_to_start',
    scope: { dimension: 'clinic', key: null, label: null },
    observed: round1(o.wait_start_p50),
    threshold: null,
    baseline: { kind: 'PRIOR_PERIOD', value: round1(prior.wait_start_p50) },
    sample: { n: o.wait_start_n, min: MIN_RULE },
    params: {
      p50: round1(o.wait_start_p50) ?? 0,
      priorP50: round1(prior.wait_start_p50) ?? 0,
      changePct: round1((delta / prior.wait_start_p50) * 100) ?? 0,
    },
    actionKey: JOURNEY_ACTION_CODE.REVIEW_PEAK_STAFFING,
    dataSources: ['queue_entries'],
  });
}

function readyDelayAlerts(
  clinicN: number,
  clinicP50: number | null,
  staffRows: JourneyDimensionRow[],
  staffLabels: Map<string, JourneyLabel>,
): JourneyInsight[] {
  const out: JourneyInsight[] = [];
  for (const row of staffRows) {
    const useReady = row.ready_delay_n >= MIN_RULE;
    const n = useReady ? row.ready_delay_n : row.start_delay_n;
    const p50 = useReady ? row.ready_delay_p50 : row.start_delay_p50;
    const p90 = useReady ? row.ready_delay_p90 : row.start_delay_p90;
    if (n < MIN_RULE || p50 == null) continue;
    const label = staffLabels.get(row.dim_key);
    if (label?.inactive) continue;

    const critical = p50 >= T.READY_DELAY_CRIT_MINUTES;
    const warnAbsolute = p50 >= T.READY_DELAY_WARN_MINUTES;
    const warnRelative =
      clinicP50 != null &&
      clinicN >= MIN_RULE &&
      p50 >= clinicP50 * T.READY_DELAY_MEDIAN_RATIO &&
      p50 - clinicP50 >= T.READY_DELAY_MIN_DELTA;
    if (!critical && !warnAbsolute && !warnRelative) continue;

    out.push(
      baseInsight({
        code: JOURNEY_ALERT_CODE.READY_DELAY_HIGH,
        kind: JOURNEY_INSIGHT_KIND.ALERT,
        severity: critical
          ? JOURNEY_SEVERITY.CRITICAL
          : JOURNEY_SEVERITY.WARNING,
        metric: useReady ? 'journey.ready_delay' : 'journey.start_delay',
        scope: {
          dimension: 'staff',
          key: row.dim_key,
          label: label?.name ?? null,
        },
        observed: p50,
        threshold: critical
          ? T.READY_DELAY_CRIT_MINUTES
          : T.READY_DELAY_WARN_MINUTES,
        baseline:
          warnRelative && !warnAbsolute && !critical
            ? { kind: 'CLINIC_MEDIAN', value: clinicP50 }
            : {
                kind: 'ABSOLUTE',
                value: critical
                  ? T.READY_DELAY_CRIT_MINUTES
                  : T.READY_DELAY_WARN_MINUTES,
              },
        sample: { n, min: MIN_RULE },
        params: {
          staff: label?.name ?? row.dim_key,
          p50,
          p90: p90 ?? 0,
          clinicP50: clinicP50 ?? 0,
          n,
          basis: useReady ? 1 : 0,
        },
        actionKey: JOURNEY_ACTION_CODE.REVIEW_DOCTOR_SCHEDULE,
        dataSources: ['queue_entries', 'appointment_status_logs'],
      }),
    );
  }
  return out;
}

function consultationOverrunAlerts(
  rows: JourneyDimensionRow[],
  labels: Map<string, JourneyLabel>,
  dimension: 'staff' | 'service',
): JourneyInsight[] {
  const out: JourneyInsight[] = [];
  for (const row of rows) {
    if (row.consult_n < MIN_RULE) continue;
    const coverage = shapeCoverage(row.completed_with_timing, row.completed);
    if (
      coverage.rate == null ||
      coverage.rate < JOURNEY_THRESHOLDS.MIN_COVERAGE
    )
      continue;
    if (
      row.overrun_p50 == null ||
      row.consult_p50 == null ||
      row.scheduled_p50 == null ||
      row.scheduled_p50 <= 0
    )
      continue;
    const label = labels.get(row.dim_key);
    if (label?.inactive) continue;
    if (row.overrun_p50 < T.OVERRUN_MIN_MINUTES) continue;
    if (row.consult_p50 < row.scheduled_p50 * T.OVERRUN_SCHEDULED_RATIO)
      continue;

    out.push(
      baseInsight({
        code: JOURNEY_ALERT_CODE.CONSULTATION_OVERRUN,
        kind: JOURNEY_INSIGHT_KIND.ALERT,
        severity: JOURNEY_SEVERITY.WARNING,
        metric: 'journey.consultation_overrun',
        scope: { dimension, key: row.dim_key, label: label?.name ?? null },
        observed: round1(row.overrun_p50),
        threshold: T.OVERRUN_MIN_MINUTES,
        baseline: { kind: 'ABSOLUTE', value: T.OVERRUN_MIN_MINUTES },
        sample: { n: row.consult_n, min: MIN_RULE },
        params: {
          label: label?.name ?? row.dim_key,
          overrunP50: round1(row.overrun_p50) ?? 0,
          consultationP50: round1(row.consult_p50) ?? 0,
          scheduledP50: round1(row.scheduled_p50) ?? 0,
          n: row.consult_n,
        },
        actionKey:
          dimension === 'service'
            ? JOURNEY_ACTION_CODE.REVIEW_SERVICE_DURATION
            : JOURNEY_ACTION_CODE.REVIEW_DOCTOR_SCHEDULE,
        dataSources: [
          'appointment_services',
          'queue_entries',
          'appointment_status_logs',
        ],
      }),
    );
  }
  return out;
}

function noShowRateAlerts(
  o: JourneyOverallRow,
  branches: JourneyDimensionRow[],
  staff: JourneyDimensionRow[],
  branchLabels: Map<string, JourneyLabel>,
  staffLabels: Map<string, JourneyLabel>,
  remindersEnabled: boolean,
): JourneyInsight[] {
  const out: JourneyInsight[] = [];

  const evaluate = (
    n: number,
    noShow: number,
    scope: {
      dimension: 'clinic' | JourneyDimension;
      key: string | null;
      label: string | null;
    },
  ) => {
    if (n < MIN_RULE) return;
    const rate = noShow / n;
    const critical = rate >= T.NO_SHOW_CRIT_RATE;
    const warning = rate >= T.NO_SHOW_WARN_RATE;
    if (!critical && !warning) return;
    out.push(
      baseInsight({
        code: JOURNEY_ALERT_CODE.NO_SHOW_RATE_HIGH,
        kind: JOURNEY_INSIGHT_KIND.ALERT,
        severity: critical
          ? JOURNEY_SEVERITY.CRITICAL
          : JOURNEY_SEVERITY.WARNING,
        metric: 'rates.no_show',
        scope,
        observed: round3(rate),
        threshold: critical ? T.NO_SHOW_CRIT_RATE : T.NO_SHOW_WARN_RATE,
        baseline: {
          kind: 'ABSOLUTE',
          value: critical ? T.NO_SHOW_CRIT_RATE : T.NO_SHOW_WARN_RATE,
        },
        sample: { n, min: MIN_RULE },
        params: { ratePct: round1(rate * 100) ?? 0, noShow, appointments: n },
        actionKey: remindersEnabled
          ? JOURNEY_ACTION_CODE.REVIEW_REMINDER_LEAD_TIMES
          : JOURNEY_ACTION_CODE.ENABLE_REMINDERS,
        dataSources: ['appointments'],
      }),
    );
  };

  evaluate(o.booked, o.no_show, {
    dimension: 'clinic',
    key: null,
    label: null,
  });
  for (const row of branches) {
    evaluate(row.booked, row.no_show, {
      dimension: 'branch',
      key: row.dim_key,
      label: branchLabels.get(row.dim_key)?.name ?? null,
    });
  }
  for (const row of staff) {
    const label = staffLabels.get(row.dim_key);
    if (label?.inactive) continue;
    evaluate(row.booked, row.no_show, {
      dimension: 'staff',
      key: row.dim_key,
      label: label?.name ?? null,
    });
  }
  return out;
}

function noShowRateIncreasedAlert(
  o: JourneyOverallRow,
  prior: JourneyOverallRow | null,
): JourneyInsight | null {
  if (!prior) return null;
  if (o.booked < MIN_RULE || prior.booked < MIN_RULE) return null;
  const rate = o.no_show / o.booked;
  const priorRate = prior.no_show / prior.booked;
  if (priorRate <= 0) return null;
  const deltaPp = rate - priorRate;
  if (deltaPp < T.NO_SHOW_INCREASE_MIN_DELTA_PP) return null;
  if (rate < priorRate * T.NO_SHOW_INCREASE_RATIO) return null;
  return baseInsight({
    code: JOURNEY_ALERT_CODE.NO_SHOW_RATE_INCREASED,
    kind: JOURNEY_INSIGHT_KIND.ALERT,
    severity: JOURNEY_SEVERITY.WARNING,
    metric: 'rates.no_show',
    scope: { dimension: 'clinic', key: null, label: null },
    observed: round3(rate),
    threshold: null,
    baseline: { kind: 'PRIOR_PERIOD', value: round3(priorRate) },
    sample: { n: o.booked, min: MIN_RULE },
    params: {
      ratePct: round1(rate * 100) ?? 0,
      priorRatePct: round1(priorRate * 100) ?? 0,
    },
    actionKey: JOURNEY_ACTION_CODE.REVIEW_REMINDER_LEAD_TIMES,
    dataSources: ['appointments'],
  });
}

function peakHourWaitAlert(
  hourRows: JourneyDimensionRow[],
  clinicP50: number | null,
): JourneyInsight[] {
  if (clinicP50 == null) return [];
  const candidates = hourRows
    .filter((r) => r.wait_start_n >= MIN_RULE && r.wait_start_p50 != null)
    .filter(
      (r) => (r.wait_start_p50 as number) >= clinicP50 * T.PEAK_HOUR_RATIO,
    )
    .filter(
      (r) => (r.wait_start_p50 as number) - clinicP50 >= T.PEAK_HOUR_MIN_DELTA,
    )
    .sort((a, b) => (b.wait_start_p50 as number) - (a.wait_start_p50 as number))
    .slice(0, T.PEAK_HOUR_TOP_N);

  return candidates.map((row) =>
    baseInsight({
      code: JOURNEY_ALERT_CODE.PEAK_HOUR_WAIT,
      kind: JOURNEY_INSIGHT_KIND.ALERT,
      severity: JOURNEY_SEVERITY.WARNING,
      metric: 'journey.wait_to_start',
      scope: { dimension: 'hour', key: row.dim_key, label: null },
      observed: round1(row.wait_start_p50),
      threshold: null,
      baseline: { kind: 'CLINIC_MEDIAN', value: round1(clinicP50) },
      sample: { n: row.wait_start_n, min: MIN_RULE },
      params: {
        hour: Number(row.dim_key),
        p50: round1(row.wait_start_p50) ?? 0,
        clinicP50: round1(clinicP50) ?? 0,
        n: row.wait_start_n,
      },
      actionKey: JOURNEY_ACTION_CODE.REVIEW_PEAK_STAFFING,
      dataSources: ['queue_entries'],
    }),
  );
}

function branchWaitOutlierAlerts(
  branchRows: JourneyDimensionRow[],
  labels: Map<string, JourneyLabel>,
): JourneyInsight[] {
  const qualifying = branchRows.filter(
    (r) => r.wait_start_n >= MIN_RULE && r.wait_start_p50 != null,
  );
  if (qualifying.length < T.BRANCH_OUTLIER_MIN_QUALIFYING_BRANCHES) return [];
  const branchesMedian = median(
    qualifying.map((r) => r.wait_start_p50 as number),
  );
  if (branchesMedian == null) return [];

  const out: JourneyInsight[] = [];
  for (const row of qualifying) {
    const p50 = row.wait_start_p50 as number;
    if (p50 < branchesMedian * T.BRANCH_OUTLIER_RATIO) continue;
    if (p50 - branchesMedian < T.BRANCH_OUTLIER_MIN_DELTA) continue;
    out.push(
      baseInsight({
        code: JOURNEY_ALERT_CODE.BRANCH_WAIT_OUTLIER,
        kind: JOURNEY_INSIGHT_KIND.ALERT,
        severity: JOURNEY_SEVERITY.WARNING,
        metric: 'journey.wait_to_start',
        scope: {
          dimension: 'branch',
          key: row.dim_key,
          label: labels.get(row.dim_key)?.name ?? null,
        },
        observed: round1(p50),
        threshold: null,
        baseline: { kind: 'CLINIC_MEDIAN', value: round1(branchesMedian) },
        sample: { n: row.wait_start_n, min: MIN_RULE },
        params: {
          branch: labels.get(row.dim_key)?.name ?? row.dim_key,
          p50: round1(p50) ?? 0,
          branchesMedian: round1(branchesMedian) ?? 0,
        },
        actionKey: JOURNEY_ACTION_CODE.REVIEW_BRANCH_FLOW,
        dataSources: ['queue_entries'],
      }),
    );
  }
  return out;
}

function reminderAlerts(
  o: JourneyOverallRow,
  reminders: JourneyRemindersInfo,
): JourneyInsight[] {
  const out: JourneyInsight[] = [];
  if (!reminders.available) return out;

  const { sent, failed } = reminders.rows;
  const denom = sent + failed;
  if (denom >= MIN_RULE) {
    const rate = failed / denom;
    const critical = rate >= T.REMINDER_FAILURE_CRIT_RATE;
    const warning = rate >= T.REMINDER_FAILURE_WARN_RATE;
    if (critical || warning) {
      const topReason = reminders.failureReasons[0]?.reason ?? null;
      const actionKey: JourneyActionCode =
        topReason === 'NO_PROVIDER'
          ? JOURNEY_ACTION_CODE.CONNECT_WHATSAPP
          : topReason === 'QUOTA_EXHAUSTED'
            ? JOURNEY_ACTION_CODE.REVIEW_MESSAGING_QUOTA
            : topReason === 'INVALID_RECIPIENT' ||
                topReason === 'RECIPIENT_NOT_FOUND'
              ? JOURNEY_ACTION_CODE.FIX_PATIENT_CONTACTS
              : JOURNEY_ACTION_CODE.REVIEW_NOTIFICATION_LOG;
      out.push(
        baseInsight({
          code: JOURNEY_ALERT_CODE.REMINDER_FAILURE_RATE_HIGH,
          kind: JOURNEY_INSIGHT_KIND.ALERT,
          severity: critical
            ? JOURNEY_SEVERITY.CRITICAL
            : JOURNEY_SEVERITY.WARNING,
          metric: 'journey.reminder_failure_rate',
          scope: { dimension: 'clinic', key: null, label: null },
          observed: round3(rate),
          threshold: critical
            ? T.REMINDER_FAILURE_CRIT_RATE
            : T.REMINDER_FAILURE_WARN_RATE,
          baseline: {
            kind: 'ABSOLUTE',
            value: critical
              ? T.REMINDER_FAILURE_CRIT_RATE
              : T.REMINDER_FAILURE_WARN_RATE,
          },
          sample: { n: denom, min: MIN_RULE },
          params: {
            ratePct: round1(rate * 100) ?? 0,
            failed,
            total: denom,
            topReason: topReason ?? 'OTHER',
          },
          actionKey,
          dataSources: ['scheduled_notifications'],
        }),
      );
    }
  }

  if (o.rem_eligible >= MIN_RULE && o.rem_with_row > 0) {
    const coverage = o.rem_reminded / o.rem_eligible;
    if (coverage < T.REMINDER_COVERAGE_WARN_FLOOR) {
      out.push(
        baseInsight({
          code: JOURNEY_ALERT_CODE.REMINDER_COVERAGE_LOW,
          kind: JOURNEY_INSIGHT_KIND.ALERT,
          severity: JOURNEY_SEVERITY.WARNING,
          metric: 'journey.reminder_coverage',
          scope: { dimension: 'clinic', key: null, label: null },
          observed: round3(coverage),
          threshold: T.REMINDER_COVERAGE_WARN_FLOOR,
          baseline: { kind: 'ABSOLUTE', value: T.REMINDER_COVERAGE_WARN_FLOOR },
          sample: { n: o.rem_eligible, min: MIN_RULE },
          params: {
            coveragePct: round1(coverage * 100) ?? 0,
            reminded: o.rem_reminded,
            eligible: o.rem_eligible,
          },
          actionKey: JOURNEY_ACTION_CODE.CHECK_REMINDER_SETUP,
          dataSources: ['scheduled_notifications'],
        }),
      );
    }
  }

  return out;
}

function lateArrivalAlert(
  o: JourneyOverallRow,
  kpis: JourneyKpis,
): JourneyInsight | null {
  if (kpis.arrivalOffset.suppressed || o.arrival_n < MIN_RULE) return null;
  const share = kpis.arrivalOffset.lateShare;
  if (share == null || share < T.LATE_ARRIVAL_SHARE_WARN) return null;
  return baseInsight({
    code: JOURNEY_ALERT_CODE.PATIENT_LATE_ARRIVALS,
    kind: JOURNEY_INSIGHT_KIND.ALERT,
    severity: JOURNEY_SEVERITY.INFO,
    metric: 'journey.arrival_offset',
    scope: { dimension: 'clinic', key: null, label: null },
    observed: round3(share),
    threshold: T.LATE_ARRIVAL_SHARE_WARN,
    baseline: { kind: 'ABSOLUTE', value: T.LATE_ARRIVAL_SHARE_WARN },
    sample: { n: o.arrival_n, min: MIN_RULE },
    params: { sharePct: round1(share * 100) ?? 0, n: o.arrival_n },
    actionKey: JOURNEY_ACTION_CODE.REVIEW_ARRIVAL_INSTRUCTIONS,
    dataSources: ['queue_entries'],
  });
}

// ────────────────────────────── Recommendations ────────────────────────── //

function reminderAttendanceGapRecommendation(
  o: JourneyOverallRow,
  reminders: JourneyRemindersInfo,
): JourneyInsight | null {
  if (!reminders.available) return null;
  const { reminded, notReminded, comparable } = reminders.attendance;
  if (!comparable || reminded.share == null || notReminded.share == null)
    return null;
  if (o.rem_eligible === 0) return null;
  const coverage = o.rem_eligible > 0 ? o.rem_reminded / o.rem_eligible : 0;
  if (coverage >= T.REMINDER_ATTENDANCE_GAP_MAX_COVERAGE) return null;
  const gap = notReminded.share - reminded.share;
  if (gap < T.REMINDER_ATTENDANCE_GAP_MIN_DELTA) return null;

  return baseInsight({
    code: JOURNEY_RECOMMENDATION_CODE.REMINDER_ATTENDANCE_GAP,
    kind: JOURNEY_INSIGHT_KIND.RECOMMENDATION,
    severity: JOURNEY_SEVERITY.INFO,
    metric: 'journey.no_show_share_by_reminder',
    scope: { dimension: 'clinic', key: null, label: null },
    observed: round3(gap),
    threshold: T.REMINDER_ATTENDANCE_GAP_MIN_DELTA,
    baseline: null,
    sample: {
      n: Math.min(reminded.resolved, notReminded.resolved),
      min: JOURNEY_THRESHOLDS.MIN_SAMPLE_RULE,
    },
    params: {
      remindedSharePct: round1(reminded.share * 100) ?? 0,
      notRemindedSharePct: round1(notReminded.share * 100) ?? 0,
      gapPct: round1(gap * 100) ?? 0,
    },
    actionKey: JOURNEY_ACTION_CODE.EXTEND_REMINDER_COVERAGE,
    dataSources: ['scheduled_notifications', 'appointments'],
  });
}

function bottleneckStageRecommendation(
  o: JourneyOverallRow,
  kpis: JourneyKpis,
): JourneyInsight | null {
  const waitCallP50 = kpis.waitForCall.suppressed ? null : kpis.waitForCall.p50;
  const callStartP50 = kpis.callToStart.suppressed
    ? null
    : kpis.callToStart.p50;
  if (waitCallP50 == null && callStartP50 == null) return null;
  const [stage, p50] =
    (waitCallP50 ?? -Infinity) >= (callStartP50 ?? -Infinity)
      ? (['WAIT_FOR_CALL', waitCallP50] as const)
      : (['CALL_TO_START', callStartP50] as const);
  if (p50 == null || p50 < T.BOTTLENECK_MIN_MINUTES) return null;
  if (
    o.visit_n < JOURNEY_THRESHOLDS.MIN_SAMPLE_RULE ||
    o.visit_p50 == null ||
    o.visit_p50 <= 0
  )
    return null;

  return baseInsight({
    code: JOURNEY_RECOMMENDATION_CODE.BOTTLENECK_STAGE,
    kind: JOURNEY_INSIGHT_KIND.RECOMMENDATION,
    severity: JOURNEY_SEVERITY.INFO,
    metric:
      stage === 'WAIT_FOR_CALL'
        ? 'journey.wait_for_call'
        : 'journey.call_to_start',
    scope: { dimension: 'clinic', key: null, label: stage },
    observed: round1(p50),
    threshold: T.BOTTLENECK_MIN_MINUTES,
    baseline: null,
    sample: { n: o.visit_n, min: JOURNEY_THRESHOLDS.MIN_SAMPLE_RULE },
    params: {
      stage,
      p50: round1(p50) ?? 0,
      shareOfVisit:
        round1(((p50 as number) / (o.visit_p50 as number)) * 100) ?? 0,
    },
    actionKey: null,
    dataSources: ['queue_entries'],
  });
}

function serviceDurationRecommendations(
  serviceRows: JourneyDimensionRow[],
  labels: Map<string, JourneyLabel>,
): JourneyInsight[] {
  const out: JourneyInsight[] = [];
  for (const row of serviceRows) {
    const label = labels.get(row.dim_key);
    if (!label) continue;
    // One evaluation of the gates, shared with the duration-suggestions list
    // (see `evaluateDurationRow`) so the two can never disagree.
    const configured = label.configuredMinutes ?? null;
    const { status, suggested } = evaluateDurationRow(row, {
      name: label.name,
      inactive: !!label.inactive,
      configuredMinutes: configured,
    });
    // A "review" recommendation compares against a configured baseline, so a
    // service with no configured duration yields a suggestion but no insight.
    if (status !== 'OK' || suggested == null || configured == null) continue;

    out.push(
      baseInsight({
        code: JOURNEY_RECOMMENDATION_CODE.SERVICE_DURATION_REVIEW,
        kind: JOURNEY_INSIGHT_KIND.RECOMMENDATION,
        severity: JOURNEY_SEVERITY.INFO,
        metric: 'journey.service_duration_suggestion',
        scope: { dimension: 'service', key: row.dim_key, label: label.name },
        observed: round1(row.consult_p75),
        threshold: null,
        baseline: { kind: 'ABSOLUTE', value: configured },
        sample: {
          n: row.consult_n,
          min: JOURNEY_THRESHOLDS.MIN_SAMPLE_DURATION_SUGGESTION,
        },
        params: {
          service: label.name,
          configured,
          suggested,
          p50: round1(row.consult_p50) ?? 0,
          p75: round1(row.consult_p75) ?? 0,
          p90: round1(row.consult_p90) ?? 0,
          n: row.consult_n,
        },
        actionKey: JOURNEY_ACTION_CODE.REVIEW_SERVICE_DURATION,
        dataSources: [
          'appointment_services',
          'services',
          'queue_entries',
          'appointment_status_logs',
        ],
      }),
    );
  }
  return out;
}

// ───────────────────────────────── Entry point ─────────────────────────── //

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};
const KIND_RANK: Record<string, number> = {
  ALERT: 0,
  RECOMMENDATION: 1,
  DATA_QUALITY: 2,
};

export function generateInsights(input: JourneyInsightsInput): {
  insights: JourneyInsight[];
  truncated: boolean;
} {
  const {
    overall: o,
    priorOverall,
    kpis,
    dimensions,
    labels,
    reminders,
    remindersEnabled,
    queueCoverageRate,
  } = input;

  const all: JourneyInsight[] = [
    ...dataQualityRules(o, queueCoverageRate),
    ...reminderDataQualityRules(o, remindersEnabled),
    ...untrackedStageRules(o),
    ...waitToStartAlerts(
      o,
      kpis,
      dimensions.branch,
      labels.branch,
      dimensions.hour,
    ),
    ...(waitToStartIncreasedAlert(o, priorOverall)
      ? [waitToStartIncreasedAlert(o, priorOverall) as JourneyInsight]
      : []),
    ...readyDelayAlerts(
      o.ready_delay_n >= MIN_RULE ? o.ready_delay_n : o.start_delay_n,
      o.ready_delay_n >= MIN_RULE ? o.ready_delay_p50 : o.start_delay_p50,
      dimensions.staff,
      labels.staff,
    ),
    ...consultationOverrunAlerts(dimensions.staff, labels.staff, 'staff'),
    ...consultationOverrunAlerts(dimensions.service, labels.service, 'service'),
    ...noShowRateAlerts(
      o,
      dimensions.branch,
      dimensions.staff,
      labels.branch,
      labels.staff,
      remindersEnabled,
    ),
    ...(noShowRateIncreasedAlert(o, priorOverall)
      ? [noShowRateIncreasedAlert(o, priorOverall) as JourneyInsight]
      : []),
    ...peakHourWaitAlert(
      dimensions.hour,
      kpis.waitToStart.suppressed ? null : kpis.waitToStart.p50,
    ),
    ...branchWaitOutlierAlerts(dimensions.branch, labels.branch),
    ...reminderAlerts(o, reminders),
    ...(lateArrivalAlert(o, kpis)
      ? [lateArrivalAlert(o, kpis) as JourneyInsight]
      : []),
    ...(reminderAttendanceGapRecommendation(o, reminders)
      ? [reminderAttendanceGapRecommendation(o, reminders) as JourneyInsight]
      : []),
    ...(bottleneckStageRecommendation(o, kpis)
      ? [bottleneckStageRecommendation(o, kpis) as JourneyInsight]
      : []),
    ...serviceDurationRecommendations(dimensions.service, labels.service),
  ];

  const sorted = all.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kind !== 0) return kind;
    const exceedanceA =
      a.observed != null && a.threshold ? a.observed - a.threshold : 0;
    const exceedanceB =
      b.observed != null && b.threshold ? b.observed - b.threshold : 0;
    if (exceedanceB !== exceedanceA) return exceedanceB - exceedanceA;
    return a.code.localeCompare(b.code);
  });

  const truncated = sorted.length > JOURNEY_THRESHOLDS.MAX_INSIGHTS;
  return {
    insights: sorted.slice(0, JOURNEY_THRESHOLDS.MAX_INSIGHTS),
    truncated,
  };
}
