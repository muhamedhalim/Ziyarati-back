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
  | 'performance.channels';

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
      'The sum of SETTLED (PAID) `Payment` rows in the period. Excludes pending, failed and refunded payments, and is never derived from `Appointment.total_amount` (a booking price, not a settled payment).',
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
      'Sum of every SETTLED (PAID) payment for the tenant, with no date bound — the all-time counterpart of "Revenue" (revenue.total), which is period- and branch-scoped. Same settled-payment-only rule; excludes pending/failed/refunded.',
    source: 'AnalyticsAggregationService.sumTenantRevenue (no range)',
  },
  total_paid_payments: {
    key: 'total_paid_payments',
    label: 'Total paid payments (all time)',
    definition:
      'Count of PAID payment rows for the tenant, with no date bound. A payment count, not a revenue amount.',
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
      'Appointment counts (total/completed/cancelled/no-show) bucketed by UTC calendar day, for every day in the requested [from, to] range and the requested branch (or the whole clinic) — never a fixed row count. Fixes R13: the previous UI read the last N *rows* of the per-branch daily report table, which silently mixed branches for a multi-branch clinic.',
    source: 'AnalyticsAggregationService.appointmentsTrend',
  },
  'trends.revenue_daily': {
    key: 'trends.revenue_daily',
    label: 'Revenue trend',
    definition:
      'SETTLED (PAID) payment amounts bucketed by UTC calendar day (by `paid_at`), for every day in the requested range and branch — same settled-payment definition as revenue.total, never `Appointment.total_amount`.',
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
      'AnalyticsAggregationService.computeRates / computeStaffPerformance / channelPerformance',
  },
  'rates.completion': {
    key: 'rates.completion',
    label: 'Completion rate',
    definition:
      'Appointments whose status reached COMPLETED, as a proportion of appointments scheduled to occur in the period — the same definition applies tenant-wide and per booking channel, only the grouping changes.',
    source: 'AnalyticsAggregationService.computeRates / channelPerformance',
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
      'Per service, in the requested period/branch: how many times it was booked (one count per appointment line item — an appointment with two services counts once for each), and its booked LINE-ITEM PRICE summed (`appointment_services.price`) — the existing top-services definition (used by the monthly report), extended and paginated. This is deliberately NOT the settled-payment revenue definition (revenue.total): a single payment can cover several services on one appointment, so there is no sound way to split a settled payment across service lines without inventing a new allocation rule.',
    source:
      'AnalyticsAggregationService.servicePerformance (extends topServices)',
  },
  'performance.staff': {
    key: 'performance.staff',
    label: 'Staff performance',
    definition:
      'Per practitioner, in the requested period/branch: appointment counts (total/completed/cancelled/no-show), SETTLED (PAID) revenue attributed via the appointment they staffed, average review rating, and no-show rate (rates.no_show, grouped by staff). Only staff with at least one appointment in the window appear.',
    source: 'AnalyticsAggregationService.computeStaffPerformance',
  },
  'performance.branches': {
    key: 'performance.branches',
    label: 'Branch performance',
    definition:
      'Per branch, in the requested period: appointment count (by `start_at`) and SETTLED (PAID) revenue (by `paid_at`) — same definitions as appointments.total / revenue.total, grouped by branch instead of filtered to one. A branch-restricted caller sees only their own branch(es), never a clinic-wide comparison.',
    source: 'AnalyticsAggregationService.branchPerformance',
  },
  'performance.channels': {
    key: 'performance.channels',
    label: 'Channel performance',
    definition:
      'Per `AppointmentSource` (PLATFORM / WHATSAPP_BOT / MANUAL / PUBLIC_AI), in the requested period/branch: appointment count, completion rate (rates.completion, grouped by channel) and SETTLED (PAID) revenue. Every channel is listed even at zero, so a channel with no bookings is never silently omitted.',
    source: 'AnalyticsAggregationService.channelPerformance',
  },
};

export const METRIC_KEYS = Object.keys(METRIC_REGISTRY) as MetricKey[];

export function getMetricDefinition(key: MetricKey): MetricDefinition {
  return METRIC_REGISTRY[key];
}
