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
  | 'reviews.avg_rating';

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
    source: 'AnalyticsAggregationService.computeDailyMetrics (status = COMPLETED)',
  },
  'appointments.cancelled': {
    key: 'appointments.cancelled',
    label: 'Cancelled appointments',
    definition:
      'Appointments whose status reached CANCELLED in the period, regardless of who cancelled them (staff or patient — see `AppointmentActionOrigin`, T019).',
    source: 'AnalyticsAggregationService.computeDailyMetrics (status = CANCELLED)',
  },
  'appointments.no_show': {
    key: 'appointments.no_show',
    label: 'No-shows',
    definition:
      'Appointments whose status reached NO_SHOW in the period — the patient neither attended nor cancelled in advance.',
    source: 'AnalyticsAggregationService.computeDailyMetrics (status = NO_SHOW)',
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
    definition: 'Customers whose record was first created in the period, tenant-wide.',
    source: 'AnalyticsAggregationService.computeDailyMetrics (customers.created_at)',
  },
  'ai.messages_count': {
    key: 'ai.messages_count',
    label: 'AI messages',
    definition: 'AI conversation messages attributed to the branch in the period.',
    source: 'AnalyticsAggregationService.countBranchAiMessages',
  },
  'reviews.avg_rating': {
    key: 'reviews.avg_rating',
    label: 'Average rating',
    definition:
      'Mean of all customer review ratings (1-5) submitted in the period. Null when no reviews were submitted — never rendered as 0.',
    source: 'AnalyticsAggregationService.avgRating / avgStaffRating',
  },
};

export const METRIC_KEYS = Object.keys(METRIC_REGISTRY) as MetricKey[];

export function getMetricDefinition(key: MetricKey): MetricDefinition {
  return METRIC_REGISTRY[key];
}
