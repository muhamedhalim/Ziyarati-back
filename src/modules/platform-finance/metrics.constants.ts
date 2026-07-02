/**
 * KPI metric registry — the single source of truth that maps each dashboard KPI
 * to the base filter + measure used for its drill-down. One registry drives one
 * parameterized drill-down endpoint, so there is exactly ONE aggregation code
 * path (no duplicated SQL / no 20 near-identical endpoints).
 */
export type MetricKind = 'payments' | 'settlements' | 'subscriptions' | 'clinics';

export type MetricMeasure =
  | 'gross'
  | 'net'
  | 'netOfGateway'
  | 'platformFee'
  | 'gatewayFee'
  | 'refunded'
  | 'count'
  | 'avg';

export interface MetricDef {
  label: string;
  kind: MetricKind;
  /** For `payments` kind: the value expression used in summary/charts/breakdowns. */
  measure?: MetricMeasure;
  base?: {
    status?: string;
    settlementStatus?: string;
    /** Restrict to rows with a positive refunded amount. */
    refunded?: boolean;
    /** Constrain `paid_at` to today / current month. */
    period?: 'today' | 'month';
  };
  /** For `settlements` kind. */
  settlementStatuses?: string[];
  /** For `subscriptions` kind. */
  subscriptionScope?: 'active' | 'expired';
}

/** SQL value expression per measure (payments alias `p`). */
export const MEASURE_SQL: Record<MetricMeasure, string> = {
  gross: 'SUM(p.amount)',
  net: 'SUM(COALESCE(p.net_amount, p.amount))',
  netOfGateway: 'SUM(p.amount - p.gateway_fee)',
  platformFee: 'SUM(p.platform_fee)',
  gatewayFee: 'SUM(p.gateway_fee)',
  refunded: 'SUM(p.refunded_amount)',
  count: 'COUNT(DISTINCT p.id)',
  avg: 'AVG(p.amount)',
};

export const FINANCE_METRICS: Record<string, MetricDef> = {
  // Revenue
  todayRevenue: { label: "Today's Revenue", kind: 'payments', measure: 'gross', base: { status: 'PAID', period: 'today' } },
  monthlyRevenue: { label: 'Monthly Revenue', kind: 'payments', measure: 'gross', base: { status: 'PAID', period: 'month' } },
  platformRevenue: { label: 'Platform Revenue', kind: 'payments', measure: 'platformFee', base: { status: 'PAID' } },
  clinicRevenue: { label: 'Clinic Revenue', kind: 'payments', measure: 'net', base: { status: 'PAID' } },
  netRevenue: { label: 'Net Revenue', kind: 'payments', measure: 'netOfGateway', base: { status: 'PAID' } },
  // Fees
  gatewayFees: { label: 'Gateway Fees', kind: 'payments', measure: 'gatewayFee', base: { status: 'PAID' } },
  platformFees: { label: 'Platform Fees', kind: 'payments', measure: 'platformFee', base: { status: 'PAID' } },
  // Transactions
  todayTransactions: { label: "Today's Transactions", kind: 'payments', measure: 'count', base: { status: 'PAID', period: 'today' } },
  failedPayments: { label: 'Failed Payments', kind: 'payments', measure: 'count', base: { status: 'FAILED' } },
  refunds: { label: 'Refunds', kind: 'payments', measure: 'refunded', base: { refunded: true } },
  // Split & settlement
  moneyWaitingSplit: { label: 'Waiting Split', kind: 'payments', measure: 'net', base: { status: 'PAID', settlementStatus: 'UNSETTLED' } },
  moneyWaitingPayout: { label: 'Waiting Payout', kind: 'settlements', settlementStatuses: ['PENDING', 'PROCESSING'] },
  completedPayouts: { label: 'Completed Payouts', kind: 'settlements', settlementStatuses: ['PAID'] },
  pendingSettlements: { label: 'Pending Settlements', kind: 'settlements', settlementStatuses: ['PENDING', 'PROCESSING'] },
  // Subscription
  activeSubscriptions: { label: 'Active Subscriptions', kind: 'subscriptions', subscriptionScope: 'active' },
  expiredSubscriptions: { label: 'Expired Subscriptions', kind: 'subscriptions', subscriptionScope: 'expired' },
  monthlyRecurringRevenue: { label: 'Monthly Recurring Revenue', kind: 'subscriptions', subscriptionScope: 'active' },
  // Clinics
  totalClinics: { label: 'Total Clinics', kind: 'clinics' },
  averageClinicRevenue: { label: 'Avg Clinic Revenue', kind: 'clinics' },
  // Booking
  averageBookingValue: { label: 'Avg Booking Value', kind: 'payments', measure: 'avg', base: { status: 'PAID' } },
};

export const FINANCE_METRIC_KEYS = Object.keys(FINANCE_METRICS);
