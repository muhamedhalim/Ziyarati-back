import { JOURNEY_KNOWN_TIMEZONES, JOURNEY_LIMITS } from './journey.constants';
import type { JourneyDimension } from './journey.constants';

/**
 * Patient Journey — pure SQL builders. No I/O here: every function returns
 * `{sql, params}` for the caller (`JourneyAggregationService`) to run via
 * `manager.query`. Kept pure and separate from the service so the SQL shape
 * can be unit-tested (parameter numbering, optional clauses, no
 * interpolated values) without a database.
 *
 * Design choice vs. the original plan: the plan's draft used ONE statement
 * with `GROUP BY GROUPING SETS (...)` covering all 5 breakdown dimensions
 * at once. This implementation instead builds one "overall" statement (no
 * grouping) plus one statement PER REQUESTED DIMENSION — still one bounded,
 * set-based aggregate query each, never a per-appointment loop — because
 * this environment has no live Postgres to validate a single mega-statement
 * against, and the plan itself names the split as the sanctioned fallback
 * "if slow". `PatientJourneyService` runs the overall query plus only the
 * dimension queries an insight rule or the requested breakdown actually
 * needs, and the whole aggregate is cached together, so a warm request still
 * costs zero of these statements.
 *
 * Every appointment-touching CTE below filters `deleted_at IS NULL` (a
 * soft-deleted appointment must never appear — matches `computeRates`,
 * which gets this for free from `createQueryBuilder`) and every table is
 * filtered by tenant, never trusted from a join alone.
 */

export interface JourneyQueryOptions {
  tenantId: string;
  /** Inclusive UTC instant range — `dayRangeUtc(from).start` / `dayRangeUtc(to).end`. */
  start: Date;
  end: Date;
  branchId?: string;
  staffId?: string;
  /** Narrows to appointments whose ONLY service is this one. */
  serviceId?: string;
  /** Injectable "now" so tests are deterministic. */
  now: Date;
  /** Defaults to {@link JOURNEY_KNOWN_TIMEZONES}; overridable for tests. */
  zones?: readonly string[];
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/** Positional ($1, $2, ...) Postgres parameter builder, push-order. */
export class JourneyParamBuilder {
  private readonly values: unknown[] = [];

  /** Pushes a NEW parameter and returns its `$n` placeholder. */
  push(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  get params(): unknown[] {
    return this.values;
  }
}

interface FactsCtes {
  sql: string;
  params: unknown[];
}

/**
 * The CTE chain shared by every facts query: `scope_appt` (range + tenant +
 * branch/staff scope) → `svc` (service count per appointment) → `q` (the
 * one queue row per appointment, COMPLETED preferred, else latest arrival)
 * → `sl` (first IN_PROGRESS/COMPLETED status-log timestamp, fallback path)
 * → `rem` (reminder outcome per appointment) → `fact` (raw minute
 * intervals) → `v` (validity-windowed, skew-clamped values used by every
 * aggregate). Ends right before the final `SELECT` the caller appends.
 */
function buildFactsCtes(opts: JourneyQueryOptions): FactsCtes {
  const p = new JourneyParamBuilder();
  const zones = opts.zones ?? JOURNEY_KNOWN_TIMEZONES;

  const tenantId = p.push(opts.tenantId);
  const start = p.push(opts.start);
  const end = p.push(opts.end);
  const zonesParam = p.push([...zones]);
  const now = p.push(opts.now);

  const branchFilter = opts.branchId
    ? ` AND a."branchId" = ${p.push(opts.branchId)}`
    : '';
  const staffFilter = opts.staffId
    ? ` AND a."staffId" = ${p.push(opts.staffId)}`
    : '';
  const serviceFilter = opts.serviceId
    ? ` WHERE single_service_id = ${p.push(opts.serviceId)}`
    : '';

  const L = JOURNEY_LIMITS;

  const sql = `
    WITH scope_appt AS (
      SELECT
        a.id,
        a."branchId" AS branch_id,
        a."staffId" AS staff_id,
        a.status::text AS status,
        a.start_at,
        a.end_at,
        (a.created_at)::timestamptz AS created_ts,
        CASE
          WHEN a.booked_timezone = ANY(${zonesParam}::text[]) THEN a.booked_timezone
          WHEN b.timezone = ANY(${zonesParam}::text[]) THEN b.timezone
          ELSE 'UTC'
        END AS tz,
        (
          COALESCE(a.booked_timezone = ANY(${zonesParam}::text[]), false) = false
          AND COALESCE(b.timezone = ANY(${zonesParam}::text[]), false) = false
        ) AS tz_fallback
      FROM appointments a
      JOIN branches b ON b.id = a."branchId"
      WHERE a."tenantId" = ${tenantId}
        AND a.start_at >= ${start} AND a.start_at <= ${end}
        AND a.deleted_at IS NULL
        ${branchFilter}
        ${staffFilter}
    ),
    svc AS (
      SELECT
        aps."appointmentId" AS appointment_id,
        COUNT(*)::int AS service_count,
        (ARRAY_AGG(aps."serviceId"))[1] AS any_service_id
      FROM appointment_services aps
      WHERE aps."appointmentId" IN (SELECT id FROM scope_appt)
      GROUP BY aps."appointmentId"
    ),
    q AS (
      SELECT DISTINCT ON (qe."appointmentId")
        qe."appointmentId" AS appointment_id,
        qe.state,
        qe.arrived_at,
        qe.called_at,
        qe.started_at,
        qe.ended_at
      FROM queue_entries qe
      WHERE qe."tenantId" = ${tenantId}
        AND qe."appointmentId" IN (SELECT id FROM scope_appt)
      ORDER BY qe."appointmentId", (qe.state = 'COMPLETED') DESC, qe.arrived_at DESC
    ),
    sl AS (
      SELECT
        l."appointmentId" AS appointment_id,
        (MIN(l.created_at) FILTER (WHERE l.status = 'IN_PROGRESS'))::timestamptz AS in_progress_at,
        (MIN(l.created_at) FILTER (WHERE l.status = 'COMPLETED'))::timestamptz AS completed_at
      FROM appointment_status_logs l
      WHERE l."tenantId" = ${tenantId}
        AND l.status IN ('IN_PROGRESS', 'COMPLETED')
        AND l."appointmentId" IN (SELECT id FROM scope_appt)
      GROUP BY l."appointmentId"
    ),
    rem AS (
      SELECT
        sn."appointmentId" AS appointment_id,
        COUNT(*)::int AS rows_total,
        bool_or(
          sn.status IN ('SENT', 'DELIVERED')
          AND sn.sent_at IS NOT NULL
          AND sn.sent_at <= sa.start_at
        ) AS reminded,
        bool_or(
          sn.status IN ('FAILED', 'SEND_UNCERTAIN')
          OR (sn.status = 'CANCELLED' AND (sn.skip_reason IS NOT NULL OR sn.failure_reason IS NOT NULL))
        ) AS reminder_failed
      FROM scheduled_notifications sn
      JOIN scope_appt sa ON sa.id = sn."appointmentId"
      WHERE sn."tenantId" = ${tenantId}
        AND sn.source_ref LIKE 'appointment-reminder:%'
      GROUP BY sn."appointmentId"
    ),
    fact AS (
      SELECT
        sa.id,
        sa.branch_id,
        sa.staff_id,
        sa.status,
        sa.tz_fallback,
        CASE WHEN COALESCE(svc.service_count, 0) = 1 THEN svc.any_service_id END AS single_service_id,
        COALESCE(svc.service_count, 0) > 1 AS multi_service,
        COALESCE(svc.service_count, 0) = 0 AS no_service,
        EXTRACT(ISODOW FROM (sa.start_at AT TIME ZONE sa.tz))::int AS local_dow,
        EXTRACT(HOUR FROM (sa.start_at AT TIME ZONE sa.tz))::int AS local_hour,
        (sa.end_at < ${now}::timestamptz) AS is_past,
        (sa.end_at < ${now}::timestamptz - interval '24 hours') AS is_past_grace,
        (q.appointment_id IS NOT NULL) AS has_queue,
        (q.called_at IS NOT NULL) AS was_called,
        (COALESCE(q.started_at, sl.in_progress_at) IS NOT NULL) AS was_started,
        CASE
          WHEN q.started_at IS NOT NULL THEN 'QUEUE'
          WHEN sl.in_progress_at IS NOT NULL THEN 'STATUS_LOG'
        END AS start_source,
        (q.state = 'CANCELLED' AND sa.status <> 'CANCELLED') AS swept,
        EXTRACT(EPOCH FROM (sa.start_at - sa.created_ts)) / 60.0 AS lead_raw,
        EXTRACT(EPOCH FROM (q.arrived_at - sa.start_at)) / 60.0 AS arrival_raw,
        EXTRACT(EPOCH FROM (q.called_at - q.arrived_at)) / 60.0 AS wait_call_raw,
        EXTRACT(EPOCH FROM (q.started_at - q.called_at)) / 60.0 AS call_start_raw,
        EXTRACT(EPOCH FROM (q.started_at - q.arrived_at)) / 60.0 AS wait_start_raw,
        EXTRACT(EPOCH FROM (q.started_at - GREATEST(sa.start_at, q.arrived_at))) / 60.0 AS ready_delay_raw,
        EXTRACT(EPOCH FROM (COALESCE(q.started_at, sl.in_progress_at) - sa.start_at)) / 60.0 AS start_delay_raw,
        CASE
          WHEN sa.status = 'COMPLETED' AND q.state = 'COMPLETED' AND q.started_at IS NOT NULL AND q.ended_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (q.ended_at - q.started_at)) / 60.0
          WHEN sa.status = 'COMPLETED' AND sl.in_progress_at IS NOT NULL AND sl.completed_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (sl.completed_at - sl.in_progress_at)) / 60.0
        END AS consult_raw,
        EXTRACT(EPOCH FROM (sa.end_at - sa.start_at)) / 60.0 AS scheduled_min,
        CASE
          WHEN q.state = 'COMPLETED' AND q.arrived_at IS NOT NULL AND q.ended_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (q.ended_at - q.arrived_at)) / 60.0
        END AS visit_raw,
        COALESCE(rem.rows_total, 0) > 0 AS has_reminder_row,
        COALESCE(rem.reminded, false) AS reminded,
        COALESCE(rem.reminder_failed, false) AS reminder_failed
      FROM scope_appt sa
      LEFT JOIN svc ON svc.appointment_id = sa.id
      LEFT JOIN q ON q.appointment_id = sa.id
      LEFT JOIN sl ON sl.appointment_id = sa.id
      LEFT JOIN rem ON rem.appointment_id = sa.id
    ),
    v AS (
      SELECT
        fact.*,
        CASE WHEN lead_raw >= ${L.LEAD_TIME_MIN_MINUTES} THEN GREATEST(lead_raw, 0) / 60.0 END AS lead_h,
        CASE WHEN arrival_raw BETWEEN -${L.INTERVAL_MAX_MINUTES} AND ${L.INTERVAL_MAX_MINUTES} THEN arrival_raw END AS arrival,
        CASE WHEN wait_call_raw BETWEEN -${L.SKEW_TOLERANCE_MINUTES} AND ${L.INTERVAL_MAX_MINUTES} THEN GREATEST(wait_call_raw, 0) END AS wait_call,
        CASE WHEN call_start_raw BETWEEN -${L.SKEW_TOLERANCE_MINUTES} AND ${L.INTERVAL_MAX_MINUTES} THEN GREATEST(call_start_raw, 0) END AS call_start,
        CASE WHEN wait_start_raw BETWEEN -${L.SKEW_TOLERANCE_MINUTES} AND ${L.INTERVAL_MAX_MINUTES} THEN GREATEST(wait_start_raw, 0) END AS wait_start,
        CASE WHEN ready_delay_raw BETWEEN -${L.INTERVAL_MAX_MINUTES} AND ${L.INTERVAL_MAX_MINUTES} THEN ready_delay_raw END AS ready_delay,
        CASE WHEN start_delay_raw BETWEEN -${L.INTERVAL_MAX_MINUTES} AND ${L.INTERVAL_MAX_MINUTES} THEN start_delay_raw END AS start_delay,
        CASE WHEN consult_raw BETWEEN ${L.CONSULTATION_MIN_MINUTES} AND ${L.CONSULTATION_MAX_MINUTES} THEN consult_raw END AS consult,
        CASE WHEN visit_raw BETWEEN -${L.SKEW_TOLERANCE_MINUTES} AND ${L.VISIT_MAX_MINUTES} THEN GREATEST(visit_raw, 0) END AS visit
      FROM fact
      ${serviceFilter}
    )
  `;

  return { sql, params: p.params };
}

/**
 * The shared aggregate SELECT list — every count `::int`-cast (this
 * codebase's own convention for raw-SQL counts, see `computeRetention`),
 * every duration a `percentile_cont(...)` over `v`'s validity-windowed
 * columns. Identical in the overall and per-dimension queries; only the
 * leading column list, `WHERE`/`GROUP BY` differ.
 */
const AGGREGATE_SELECT_LIST = `
  COUNT(*)::int AS booked,
  COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
  COUNT(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
  COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
  COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
  COUNT(*) FILTER (WHERE NOT is_past)::int AS upcoming,
  COUNT(*) FILTER (WHERE is_past)::int AS past,
  COUNT(*) FILTER (WHERE is_past_grace AND status IN ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS'))::int AS unresolved_past,
  COUNT(*) FILTER (WHERE has_queue)::int AS arrived,
  COUNT(*) FILTER (WHERE was_called)::int AS called,
  COUNT(*) FILTER (WHERE was_started)::int AS started,
  COUNT(*) FILTER (WHERE status = 'COMPLETED' AND has_queue)::int AS completed_with_queue,
  COUNT(*) FILTER (WHERE status = 'COMPLETED' AND NOT was_started)::int AS completed_without_start,
  COUNT(*) FILTER (WHERE status = 'COMPLETED' AND consult IS NOT NULL)::int AS completed_with_timing,
  COUNT(*) FILTER (WHERE consult_raw IS NOT NULL AND consult_raw < ${JOURNEY_LIMITS.CONSULTATION_MIN_MINUTES})::int AS consult_too_short,
  COUNT(*) FILTER (
    WHERE consult_raw IS NOT NULL
      AND (consult_raw < ${JOURNEY_LIMITS.CONSULTATION_MIN_MINUTES} OR consult_raw > ${JOURNEY_LIMITS.CONSULTATION_MAX_MINUTES})
  )::int AS consult_invalid,
  COUNT(*) FILTER (WHERE swept)::int AS swept,
  COUNT(*) FILTER (WHERE multi_service)::int AS multi_service,
  COUNT(*) FILTER (WHERE no_service)::int AS no_service,
  COUNT(*) FILTER (WHERE tz_fallback)::int AS tz_fallback,
  COUNT(*) FILTER (WHERE start_source = 'QUEUE')::int AS start_from_queue,
  COUNT(*) FILTER (WHERE start_source = 'STATUS_LOG')::int AS start_from_log,

  COUNT(*) FILTER (WHERE is_past AND status <> 'CANCELLED')::int AS rem_eligible,
  COUNT(*) FILTER (WHERE is_past AND status <> 'CANCELLED' AND has_reminder_row)::int AS rem_with_row,
  COUNT(*) FILTER (WHERE is_past AND status <> 'CANCELLED' AND reminded)::int AS rem_reminded,
  COUNT(*) FILTER (
    WHERE is_past AND status <> 'CANCELLED' AND has_reminder_row AND NOT reminded AND reminder_failed
  )::int AS rem_failed_only,
  COUNT(*) FILTER (WHERE status IN ('COMPLETED','NO_SHOW') AND reminded)::int AS resolved_reminded,
  COUNT(*) FILTER (WHERE status IN ('COMPLETED','NO_SHOW') AND NOT reminded)::int AS resolved_not_reminded,
  COUNT(*) FILTER (WHERE status = 'NO_SHOW' AND reminded)::int AS no_show_reminded,
  COUNT(*) FILTER (WHERE status = 'NO_SHOW' AND NOT reminded)::int AS no_show_not_reminded,

  COUNT(lead_h)::int AS lead_n,
  COUNT(*) FILTER (WHERE lead_raw IS NOT NULL AND lead_h IS NULL)::int AS lead_invalid,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_h) AS lead_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY lead_h) AS lead_p90,

  COUNT(arrival)::int AS arrival_n,
  COUNT(*) FILTER (WHERE arrival_raw IS NOT NULL AND arrival IS NULL)::int AS arrival_invalid,
  COUNT(*) FILTER (WHERE arrival > ${JOURNEY_LIMITS.LATE_ARRIVAL_MINUTES})::int AS arrival_late_n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY arrival) AS arrival_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY arrival) AS arrival_p90,

  COUNT(wait_call)::int AS wait_call_n,
  COUNT(*) FILTER (WHERE wait_call_raw IS NOT NULL AND wait_call IS NULL)::int AS wait_call_invalid,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_call) AS wait_call_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_call) AS wait_call_p90,

  COUNT(call_start)::int AS call_start_n,
  COUNT(*) FILTER (WHERE call_start_raw IS NOT NULL AND call_start IS NULL)::int AS call_start_invalid,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY call_start) AS call_start_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY call_start) AS call_start_p90,

  COUNT(wait_start)::int AS wait_start_n,
  COUNT(*) FILTER (WHERE wait_start_raw IS NOT NULL AND wait_start IS NULL)::int AS wait_start_invalid,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_start) AS wait_start_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_start) AS wait_start_p90,

  COUNT(ready_delay)::int AS ready_delay_n,
  COUNT(*) FILTER (WHERE ready_delay_raw IS NOT NULL AND ready_delay IS NULL)::int AS ready_delay_invalid,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ready_delay) AS ready_delay_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY ready_delay) AS ready_delay_p90,

  COUNT(start_delay)::int AS start_delay_n,
  COUNT(*) FILTER (WHERE start_delay_raw IS NOT NULL AND start_delay IS NULL)::int AS start_delay_invalid,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY start_delay) AS start_delay_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY start_delay) AS start_delay_p90,

  COUNT(consult)::int AS consult_n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY consult) AS consult_p50,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY consult) AS consult_p75,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY consult) AS consult_p90,

  percentile_cont(0.5) WITHIN GROUP (ORDER BY (consult - scheduled_min)) AS overrun_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY (consult - scheduled_min)) AS overrun_p90,

  COUNT(visit)::int AS visit_n,
  COUNT(*) FILTER (WHERE visit_raw IS NOT NULL AND visit IS NULL)::int AS visit_invalid,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY visit) AS visit_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY visit) AS visit_p90,

  percentile_cont(0.5) WITHIN GROUP (ORDER BY scheduled_min) AS scheduled_p50
`;

/** FR-A020-style "overall" facts for the summary KPIs — a single row, no grouping. */
export function buildJourneyOverallQuery(
  opts: JourneyQueryOptions,
): BuiltQuery {
  const { sql: ctes, params } = buildFactsCtes(opts);
  const sql = `${ctes}\nSELECT\n${AGGREGATE_SELECT_LIST}\nFROM v`;
  return { sql, params };
}

/** The grouping column for a breakdown dimension. */
function dimensionGroupColumn(dimension: JourneyDimension): string {
  switch (dimension) {
    case 'branch':
      return 'branch_id';
    case 'staff':
      return 'staff_id';
    case 'service':
      return 'single_service_id';
    case 'weekday':
      return 'local_dow';
    case 'hour':
      return 'local_hour';
  }
}

/**
 * The facts, grouped by one dimension. Rows whose grouping column is NULL
 * (a branch/staff/service appointment can't happen given the schema's own
 * FKs, but `service` is legitimately NULL for a multi-service or
 * zero-service appointment — see `journey-sql.ts`'s `fact` CTE) are
 * excluded, never folded into a misleading "unknown" bucket. Labels are
 * NOT joined here — see this file's top-level docblock.
 */
export function buildJourneyDimensionQuery(
  opts: JourneyQueryOptions,
  dimension: JourneyDimension,
): BuiltQuery {
  const { sql: ctes, params } = buildFactsCtes(opts);
  const col = dimensionGroupColumn(dimension);
  const sql = `${ctes}\nSELECT\n  ${col}::text AS dim_key,\n${AGGREGATE_SELECT_LIST}\nFROM v\nWHERE ${col} IS NOT NULL\nGROUP BY ${col}`;
  return { sql, params };
}

/**
 * Q2 — reminder rows grouped by outcome/channel/skip-reason/lead-time
 * (plan §6/§10). Reuses only `scope_appt`, not the full facts chain (no
 * queue/status-log/service joins needed here).
 */
export function buildReminderRowsQuery(opts: JourneyQueryOptions): BuiltQuery {
  const p = new JourneyParamBuilder();
  const tenantId = p.push(opts.tenantId);
  const start = p.push(opts.start);
  const end = p.push(opts.end);
  const now = p.push(opts.now);

  const branchFilter = opts.branchId
    ? ` AND a."branchId" = ${p.push(opts.branchId)}`
    : '';
  const staffFilter = opts.staffId
    ? ` AND a."staffId" = ${p.push(opts.staffId)}`
    : '';

  const sql = `
    WITH scope_appt AS (
      SELECT a.id, a.start_at
      FROM appointments a
      WHERE a."tenantId" = ${tenantId}
        AND a.start_at >= ${start} AND a.start_at <= ${end}
        AND a.deleted_at IS NULL
        ${branchFilter}
        ${staffFilter}
    )
    SELECT
      CASE
        WHEN sn.status IN ('SENT', 'DELIVERED') THEN 'SENT'
        WHEN sn.status IN ('FAILED', 'SEND_UNCERTAIN')
          OR (sn.status = 'CANCELLED' AND (sn.skip_reason IS NOT NULL OR sn.failure_reason IS NOT NULL))
          THEN 'FAILED'
        WHEN sn.status = 'CANCELLED' THEN 'CANCELLED'
        ELSE 'PENDING'
      END AS outcome,
      COALESCE(sn.channel, 'UNKNOWN') AS channel,
      sn.skip_reason,
      CASE WHEN split_part(sn.source_ref, ':', 3) ~ '^[0-9]+$' THEN split_part(sn.source_ref, ':', 3)::int END AS lead_minutes,
      COUNT(*)::int AS n,
      COUNT(*) FILTER (
        WHERE sn.status IN ('PENDING', 'SCHEDULED', 'PROCESSING') AND sn.scheduled_at < ${now}::timestamptz - interval '1 hour'
      )::int AS stuck
    FROM scheduled_notifications sn
    JOIN scope_appt sa ON sa.id = sn."appointmentId"
    WHERE sn."tenantId" = ${tenantId}
      AND sn.source_ref LIKE 'appointment-reminder:%'
    GROUP BY 1, 2, 3, 4
  `;

  return { sql, params: p.params };
}
