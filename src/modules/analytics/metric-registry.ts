/**
 * Spec 014 (Clinic Platform Completion) — T022 (S6, FR-A002). The single
 * source of truth for every analytics figure's key, label, prose definition
 * and source query. "Every figure MUST have a single stated definition,
 * visible to the user, saying exactly what it counts and excludes; two
 * figures MUST NOT measure the same thing under different names" (FR-A002).
 *
 * Definitions here are NOT redefinitions — each one documents an existing,
 * already-computed figure (see `source`). Revenue in particular keeps
 * `AnalyticsAggregationService.sumBranchRevenue`'s exact definition (settled
 * `Payment` rows) rather than introducing a second one.
 */
export type MetricKey =
  | 'appointments.total'
  | 'appointments.completed'
  | 'appointments.cancelled'
  | 'appointments.no_show'
  | 'revenue.total'
  | 'customers.new'
  | 'ai.messages_count'
  | 'reviews.avg_rating'
  // ── Dashboard KPI snapshot (`GET /analytics/dashboard`) — the literal
  // `metric_key` strings DashboardMetricService/AnalyticsAggregationService
  // already emit (see `METRIC_KEY` in analytics.constants.ts). ALL-TIME,
  // tenant-wide figures — deliberately distinct keys from the period-scoped
  // ones above (same underlying concept, different scope), never conflated.
  | 'total_customers'
  | 'total_appointments'
  | 'total_revenue'
  | 'total_paid_payments'
  | 'active_conversations'
  | 'ai_messages'
  | 'ai_tokens_used'
  | 'total_no_shows'
  | 'bookings_platform'
  | 'bookings_whatsapp_bot'
  | 'bookings_manual'
  | 'bookings_public_ai'
  // ── T145/T146 (US11, FR-A003–FR-A014) — advanced analytics (F11). Every
  // figure the 9 new routes return.
  | 'trends.appointments_daily'
  | 'trends.revenue_daily'
  | 'rates.cancellation'
  | 'rates.cancellation_by_patient'
  | 'rates.cancellation_by_clinic'
  | 'rates.no_show'
  | 'rates.completion'
  | 'retention.summary'
  | 'retention.repeat_distribution'
  | 'performance.services'
  | 'performance.staff'
  | 'performance.branches'
  | 'performance.channels'
  // ── Patient Journey plan (approved 2026-09-16). `GET /analytics/journey/
  // summary` and `/analytics/journey/breakdown` — figures over `queue_entries`
  // / `appointment_status_logs` / `scheduled_notifications`, never a second
  // definition of anything `AnalyticsAggregationService` already computes
  // (rates.no_show / rates.completion keep their existing definitions; only
  // their `source` gains a second caller below).
  | 'journey.booking_lead_time'
  | 'journey.arrival_offset'
  | 'journey.wait_for_call'
  | 'journey.call_to_start'
  | 'journey.wait_to_start'
  | 'journey.ready_delay'
  | 'journey.start_delay'
  | 'journey.consultation_duration'
  | 'journey.consultation_overrun'
  | 'journey.visit_time'
  | 'journey.queue_coverage'
  | 'journey.reminder_coverage'
  | 'journey.reminder_failure_rate'
  | 'journey.no_show_share_by_reminder'
  | 'journey.stage_counts'
  | 'journey.service_duration_suggestion'
  | 'journey.breakdown';

export interface MetricDefinition {
  key: MetricKey;
  /** Short, user-facing name (e.g. a dashboard card title). */
  label: string;
  /** Full prose: what it counts AND what it excludes (FR-A002). */
  definition: string;
  /** Where this figure is actually computed — the one place its logic lives. */
  source: string;
}

export const METRIC_REGISTRY: Record<MetricKey, MetricDefinition> = {
  'appointments.total': {
    key: 'appointments.total',
    label: 'Total appointments',
    definition:
      'Every appointment booked in the period, regardless of its outcome — includes cancelled and no-show appointments, not only completed ones.',
    source: 'AnalyticsAggregationService.countBranchAppointments',
  },
  'appointments.completed': {
    key: 'appointments.completed',
    label: 'Completed appointments',
    definition:
      'Appointments whose status reached COMPLETED in the period. Excludes cancelled, no-show, and appointments still pending/confirmed.',
    source:
      'AnalyticsAggregationService.computeDailyMetrics (status = COMPLETED)',
  },
  'appointments.cancelled': {
    key: 'appointments.cancelled',
    label: 'Cancelled appointments',
    definition:
      'Appointments whose status reached CANCELLED in the period, regardless of who cancelled them (staff or patient — see `AppointmentActionOrigin`, T019).',
    source:
      'AnalyticsAggregationService.computeDailyMetrics (status = CANCELLED)',
  },
  'appointments.no_show': {
    key: 'appointments.no_show',
    label: 'No-shows',
    definition:
      'Appointments whose status reached NO_SHOW in the period — the patient neither attended nor cancelled in advance.',
    source:
      'AnalyticsAggregationService.computeDailyMetrics (status = NO_SHOW)',
  },
  'revenue.total': {
    key: 'revenue.total',
    label: 'Revenue',
    definition:
      'Net collected money in the period (by `paid_at`; a legacy payment with no `paid_at` counts on its `created_at`): every PAID or PARTIALLY_REFUNDED clinic payment (purpose BOOKING/MANUAL), counted at `amount − refunded_amount`. Pending and failed payments are never counted; a fully refunded payment counts 0; a partial refund reduces its payment by the refunded amount. Gross of gateway/platform fees. Summed in ONE reporting currency (see `GET /analytics/currency`) — other currencies are excluded, never added in. A payment belongs to its own branch, else to the branch of the appointment it pays for. Never derived from `Appointment.total_amount` (a booking price, not money received).',
    source: 'AnalyticsAggregationService.sumBranchRevenue',
  },
  'customers.new': {
    key: 'customers.new',
    label: 'New customers',
    definition:
      'Customers whose record was first created in the period, tenant-wide.',
    source:
      'AnalyticsAggregationService.computeDailyMetrics (customers.created_at)',
  },
  'ai.messages_count': {
    key: 'ai.messages_count',
    label: 'AI messages',
    definition:
      'AI conversation messages attributed to the branch in the period.',
    source: 'AnalyticsAggregationService.countBranchAiMessages',
  },
  'reviews.avg_rating': {
    key: 'reviews.avg_rating',
    label: 'Average rating',
    definition:
      'Mean of all customer review ratings (1-5) submitted in the period. Null when no reviews were submitted — never rendered as 0.',
    source: 'AnalyticsAggregationService.avgRating / avgStaffRating',
  },

  // ─────────────────── Dashboard KPI snapshot (all-time) ──────────────────── //
  total_customers: {
    key: 'total_customers',
    label: 'Total customers (all time)',
    definition:
      'Every customer record that exists for the tenant right now, with no date bound — NOT the same figure as "New customers" (customers.new), which is period-scoped. Tenant-wide only; never shown per branch.',
    source:
      'AnalyticsAggregationService.computeDashboardKpis (customers.count)',
  },
  total_appointments: {
    key: 'total_appointments',
    label: 'Total appointments (all time)',
    definition:
      'Every appointment ever booked for the tenant, any status, with no date bound — the all-time counterpart of "Total appointments" (appointments.total), which is period- and branch-scoped.',
    source:
      'AnalyticsAggregationService.computeDashboardKpis (appointments.count)',
  },
  total_revenue: {
    key: 'total_revenue',
    label: 'Total revenue (all time)',
    definition:
      'Net collected money for the tenant with no date bound — the all-time counterpart of "Revenue" (revenue.total), same rule: PAID + PARTIALLY_REFUNDED clinic payments at `amount − refunded_amount`, in the reporting currency only. Recomputed hourly (snapshot).',
    source: 'AnalyticsAggregationService.sumTenantRevenue (no range)',
  },
  total_paid_payments: {
    key: 'total_paid_payments',
    label: 'Total paid payments (all time)',
    definition:
      'Count of collected clinic payments (PAID or PARTIALLY_REFUNDED, purpose BOOKING/MANUAL) for the tenant, any currency, with no date bound. A payment count, not a revenue amount; fully refunded, pending and failed payments are excluded.',
    source: 'AnalyticsAggregationService.computeDashboardKpis (payments.count)',
  },
  active_conversations: {
    key: 'active_conversations',
    label: 'Active conversations',
    definition: `Conversations with a message within the last ${1} week (ACTIVE_CONVERSATION_WINDOW_DAYS), as of now — a rolling snapshot, not period-filterable.`,
    source:
      'AnalyticsAggregationService.computeDashboardKpis (conversations.active)',
  },
  ai_messages: {
    key: 'ai_messages',
    label: 'AI messages (all time)',
    definition:
      'Every AI message for the tenant, with no date bound and INCLUDING messages with no branch attribution — the all-time, tenant-wide counterpart of "AI messages" (ai.messages_count), which is period- and branch-scoped and excludes branchless messages.',
    source:
      'AnalyticsAggregationService.computeDashboardKpis (aiMessages.count)',
  },
  ai_tokens_used: {
    key: 'ai_tokens_used',
    label: 'AI tokens used (all time)',
    definition:
      'Sum of `tokens_used` across every AI message for the tenant, with no date bound.',
    source: 'AnalyticsAggregationService.sumAiTokens',
  },
  total_no_shows: {
    key: 'total_no_shows',
    label: 'Total no-shows (all time)',
    definition:
      'Count of appointments whose CURRENT status is NO_SHOW, with no date bound — the all-time counterpart of "No-shows" (appointments.no_show).',
    source:
      'AnalyticsAggregationService.computeDashboardKpis (appointments.no_show.count)',
  },
  bookings_platform: {
    key: 'bookings_platform',
    label: 'Bookings — Platform (all time)',
    definition:
      'All-time appointment count with `source = PLATFORM`, no date bound.',
    source: 'AnalyticsAggregationService.countTenantBookingsBySource',
  },
  bookings_whatsapp_bot: {
    key: 'bookings_whatsapp_bot',
    label: 'Bookings — WhatsApp bot (all time)',
    definition:
      'All-time appointment count with `source = WHATSAPP_BOT`, no date bound.',
    source: 'AnalyticsAggregationService.countTenantBookingsBySource',
  },
  bookings_manual: {
    key: 'bookings_manual',
    label: 'Bookings — Manual (all time)',
    definition:
      'All-time appointment count with `source = MANUAL`, no date bound.',
    source: 'AnalyticsAggregationService.countTenantBookingsBySource',
  },
  bookings_public_ai: {
    key: 'bookings_public_ai',
    label: 'Bookings — Public AI (all time)',
    definition:
      'All-time appointment count with `source = PUBLIC_AI`, no date bound.',
    source: 'AnalyticsAggregationService.countTenantBookingsBySource',
  },

  // ───────────────── Advanced analytics (F11, T145/T146) ─────────────────── //
  'trends.appointments_daily': {
    key: 'trends.appointments_daily',
    label: 'Appointment volume trend',
    definition:
      'Appointment counts (total/completed/cancelled/no-show) bucketed by calendar day in the clinic reporting timezone (`GET /analytics/currency` → `timezone`), for every day in the requested [from, to] range and the requested branch (or the whole clinic) — never a fixed row count. Fixes R13: the previous UI read the last N *rows* of the per-branch daily report table, which silently mixed branches for a multi-branch clinic.',
    source: 'AnalyticsAggregationService.appointmentsTrend',
  },
  'trends.revenue_daily': {
    key: 'trends.revenue_daily',
    label: 'Revenue trend',
    definition:
      'Net collected money (revenue.total) bucketed by the clinic-local calendar day of `paid_at` (reporting timezone), for every day in the requested range and branch, in the reporting currency. Payments in other currencies are counted in a visible exclusion notice, never added in.',
    source: 'AnalyticsAggregationService.revenueTrend',
  },
  'rates.cancellation': {
    key: 'rates.cancellation',
    label: 'Cancellation rate',
    definition:
      'Appointments whose status reached CANCELLED, as a proportion of appointments SCHEDULED TO OCCUR in the period (i.e. `start_at` within [from, to], any status) — not a proportion of completed appointments. Distinct from the no-show rate.',
    source: 'AnalyticsAggregationService.computeRates',
  },
  'rates.cancellation_by_patient': {
    key: 'rates.cancellation_by_patient',
    label: 'Cancellations — by patient',
    definition:
      'Of the cancelled appointments counted in rates.cancellation, the subset whose `AppointmentCancellation.origin = PATIENT` (T019/T020). A count, not a rate.',
    source: 'AnalyticsAggregationService.computeRates',
  },
  'rates.cancellation_by_clinic': {
    key: 'rates.cancellation_by_clinic',
    label: 'Cancellations — by clinic',
    definition:
      'Of the cancelled appointments counted in rates.cancellation, the subset whose `AppointmentCancellation.origin = STAFF`. A count, not a rate.',
    source: 'AnalyticsAggregationService.computeRates',
  },
  'rates.no_show': {
    key: 'rates.no_show',
    label: 'No-show rate',
    definition:
      'Appointments whose status reached NO_SHOW, as a proportion of appointments scheduled to occur in the period — the same definition applies wherever a no-show rate is shown (tenant-wide, per-staff, per-channel), only the grouping changes.',
    source:
      'AnalyticsAggregationService.computeRates / computeStaffPerformance / channelPerformance / journey.JourneyAggregationService (counts.noShowRate — same population, proven equal by a parity test)',
  },
  'rates.completion': {
    key: 'rates.completion',
    label: 'Completion rate',
    definition:
      'Appointments whose status reached COMPLETED, as a proportion of appointments scheduled to occur in the period — the same definition applies tenant-wide and per booking channel, only the grouping changes.',
    source:
      'AnalyticsAggregationService.computeRates / channelPerformance / journey.JourneyAggregationService (counts.completionRate — same population, proven equal by a parity test)',
  },
  'retention.summary': {
    key: 'retention.summary',
    label: 'Patient retention',
    definition:
      'Of the distinct patients with a COMPLETED appointment in the period immediately preceding the requested range (same length, immediately before `from`), the proportion who ALSO have a COMPLETED appointment in the requested range itself. Reported with no meaningful comparison when the prior period has no completed activity to measure retention against (reported as `empty`, never a 0% that reads as a real result).',
    source: 'AnalyticsAggregationService.computeRetention',
  },
  'retention.repeat_distribution': {
    key: 'retention.repeat_distribution',
    label: 'Repeat-visit distribution',
    definition:
      'Within the requested period only: how many distinct patients had exactly 1, exactly 2, or 3-or-more COMPLETED appointments. Buckets are mutually exclusive and every patient with at least one completed appointment falls in exactly one.',
    source: 'AnalyticsAggregationService.computeRetention',
  },
  'performance.services': {
    key: 'performance.services',
    label: 'Service performance',
    definition:
      'Per service, in the requested period/branch: how many times it was booked (one count per appointment line item — an appointment with two services counts once for each, ANY outcome including cancelled and no-show), and its booked LINE-ITEM PRICE summed (`appointment_services.price`) — the existing top-services definition (used by the monthly report), extended and paginated. This is deliberately NOT the settled-payment revenue definition (revenue.total): a single payment can cover several services on one appointment, so there is no sound way to split a settled payment across service lines without inventing a new allocation rule.',
    source:
      'AnalyticsAggregationService.servicePerformance (extends topServices)',
  },
  'performance.staff': {
    key: 'performance.staff',
    label: 'Staff performance',
    definition:
      'Per practitioner, in the requested period/branch: appointment counts (total/completed/cancelled/no-show), net collected revenue (revenue.total) attributed via the appointment they staffed, average review rating, and no-show rate (rates.no_show, grouped by staff). Only staff with at least one appointment in the window appear.',
    source: 'AnalyticsAggregationService.computeStaffPerformance',
  },
  'performance.branches': {
    key: 'performance.branches',
    label: 'Branch performance',
    definition:
      'Per branch, in the requested period: appointment count (by `start_at`) and net collected revenue (by `paid_at`) — same definitions as appointments.total / revenue.total, grouped by branch instead of filtered to one. Revenue that belongs to no branch (no branch on the payment or its appointment) is reported separately as `unattributedRevenue`, so rows + unattributed = the revenue trend total. A branch-restricted caller sees only their own branch(es), never a clinic-wide comparison.',
    source: 'AnalyticsAggregationService.branchPerformance',
  },
  'performance.channels': {
    key: 'performance.channels',
    label: 'Channel performance',
    definition:
      'Per `AppointmentSource` (PLATFORM / WHATSAPP_BOT / MANUAL / PUBLIC_AI), in the requested period/branch: appointment count, completion rate (rates.completion, grouped by channel) and net collected revenue (revenue.total) of payments linked to a booking of that channel. Payments not linked to any booking are reported separately as `unattributedRevenue`. Every channel is listed even at zero, so a channel with no bookings is never silently omitted.',
    source: 'AnalyticsAggregationService.channelPerformance',
  },

  // ─────────────────────── Patient Journey (approved 2026-09-16) ─────────── //
  'journey.booking_lead_time': {
    key: 'journey.booking_lead_time',
    label: 'Booking lead time',
    definition:
      'Hours between when the appointment was created and its scheduled start, for every booked appointment in the period regardless of outcome. A lead time earlier than -60 minutes (a corrected/backfilled record) is excluded and counted separately; a small negative value within 1 minute of zero is treated as clock skew and clamped to 0.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.arrival_offset': {
    key: 'journey.arrival_offset',
    label: 'Arrival offset',
    definition:
      'Minutes between the scheduled start time and reception check-in (arrival and check-in are the same event in this system — there is no separate "arrival" timestamp). Negative means early. Only appointments that were checked in through the live queue are counted; a clinic that never uses the queue shows this as not tracked rather than 0.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.wait_for_call': {
    key: 'journey.wait_for_call',
    label: 'Wait for call',
    definition:
      'Minutes between check-in and being called by a doctor, from the live queue only. If the patient was skipped and recalled, this reflects the LAST call — the recall overwrites the earlier call time.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.call_to_start': {
    key: 'journey.call_to_start',
    label: 'Call to consultation start',
    definition:
      'Minutes between being called and the consultation actually starting, from the live queue only.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.wait_to_start': {
    key: 'journey.wait_to_start',
    label: 'Waiting time',
    definition:
      'Minutes between check-in and consultation start (the headline "how long did the patient wait" figure), from the live queue only. Covers every checked-in appointment that reached a consultation start, not only completed ones.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.ready_delay': {
    key: 'journey.ready_delay',
    label: 'Delay after ready',
    definition:
      'Minutes between consultation start and the LATER of the scheduled start time or check-in — the wait attributable to the clinic once the patient was actually available, excluding time the patient spent arriving early. From the live queue only.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.start_delay': {
    key: 'journey.start_delay',
    label: 'Start delay vs. scheduled time',
    definition:
      'Minutes between the scheduled start time and consultation start, from the live queue when available, else the first IN_PROGRESS status-log entry as a fallback for appointments where staff bypassed the queue. The response states how many came from each source.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.consultation_duration': {
    key: 'journey.consultation_duration',
    label: 'Consultation duration',
    definition:
      'Minutes of the actual consultation for COMPLETED appointments only — from the live queue (consultation start to completion) when a completed queue entry exists, else the status-log IN_PROGRESS-to-COMPLETED gap. Always one source per appointment, never a mix. A value under 1 minute or over 6 hours is excluded and counted separately.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.consultation_overrun': {
    key: 'journey.consultation_overrun',
    label: 'Consultation overrun',
    definition:
      "Consultation duration minus the appointment's own scheduled length (end minus start), for the same population as consultation duration. Positive means the consultation ran longer than booked.",
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.visit_time': {
    key: 'journey.visit_time',
    label: 'Total visit time',
    definition:
      'Minutes from check-in to consultation completion, from the live queue only, for appointments whose queue entry actually reached COMPLETED. This is NOT departure/checkout time — the platform records no checkout event.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.queue_coverage': {
    key: 'journey.queue_coverage',
    label: 'Queue coverage',
    definition:
      'Of completed appointments in the period, the proportion that went through the live queue at all. Every queue-derived wait figure on this page is suppressed as "not enough data" below 50% coverage, and reported as not tracked at 0% — a low number means the clinic mostly bypasses the queue, not that patients never wait.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.reminder_coverage': {
    key: 'journey.reminder_coverage',
    label: 'Reminder coverage',
    definition:
      'Of past, non-cancelled appointments, the proportion with at least one reminder message actually SENT before the scheduled start. Excludes appointments where reminders are disabled or no reminder rule/template is configured (those leave no row at all, counted separately as "not scheduled").',
    source: 'journey.JourneyAggregationService (buildReminderRowsQuery)',
  },
  'journey.reminder_failure_rate': {
    key: 'journey.reminder_failure_rate',
    label: 'Reminder failure rate',
    definition:
      'Of reminder messages that reached a terminal SENT or FAILED outcome, the proportion that failed (including a cancelled reminder that still carries a failure/skip reason). Pending and successfully cancelled reminders are excluded from this rate.',
    source: 'journey.JourneyAggregationService (buildReminderRowsQuery)',
  },
  'journey.no_show_share_by_reminder': {
    key: 'journey.no_show_share_by_reminder',
    label: 'No-show share, reminded vs. not reminded',
    definition:
      'Among appointments that reached COMPLETED or NO_SHOW, the no-show share computed separately for those that received a reminder and those that did not. This is an ASSOCIATION, not a causal claim — reminders are more likely to reach patients who were already going to attend, so a lower reminded no-show share does not by itself prove reminders reduce no-shows. Cancelled appointments are excluded from both groups. Shown as "not comparable" when either group has fewer than 30 appointments.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.stage_counts': {
    key: 'journey.stage_counts',
    label: 'Journey stage counts',
    definition:
      'How many of the period\'s appointments reached each journey stage (arrived, called, consultation started, completed). A stage count can be lower than an earlier one for reasons other than attrition — the queue can be bypassed entirely, so "arrived" only counts appointments checked in through the live queue.',
    source: 'journey.JourneyAggregationService (buildJourneyOverallQuery)',
  },
  'journey.service_duration_suggestion': {
    key: 'journey.service_duration_suggestion',
    label: 'Suggested service duration',
    definition:
      "For a single-service appointment, the 75th percentile of its actual consultation duration, rounded up to the nearest 5 minutes and clamped to 5-480 minutes, compared against the service's configured duration. Shown only for an active service with at least 20 timed consultations, at least 50% consultation-timing coverage, and a difference from the configured duration of at least 5 minutes or 15%, whichever is larger. Multi-service and zero-service appointments are excluded and counted separately (they cannot be attributed to one service's duration).",
    source:
      'journey.JourneyAggregationService (buildJourneyDimensionQuery, dimension="service")',
  },
  'journey.breakdown': {
    key: 'journey.breakdown',
    label: 'Journey breakdown',
    definition:
      "The same wait/consultation/reminder figures as the summary, grouped by branch, practitioner, service, day of week or hour of day (local time, using the appointment's booked timezone, else the branch timezone, else UTC). A branch-restricted caller sees only their own branch. Multi-service and zero-service appointments are excluded from the service grouping only.",
    source: 'journey.JourneyAggregationService (buildJourneyDimensionQuery)',
  },
};

export const METRIC_KEYS = Object.keys(METRIC_REGISTRY) as MetricKey[];

export function getMetricDefinition(key: MetricKey): MetricDefinition {
  return METRIC_REGISTRY[key];
}
