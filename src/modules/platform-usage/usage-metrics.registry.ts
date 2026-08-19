/**
 * Platform-usage metric registry.
 *
 * Declares EVERY metric surfaced on the super-admin usage dashboard together with
 * where its number comes from. The dashboard never fabricates data: each metric
 * is one of three kinds —
 *
 *   • `quota`    — metered against a plan limit per billing period. Used/limit
 *                  come from `UsageService` (`subscription_usage` + plan).
 *   • `count`    — an absolute plan cap on a live-counted resource. The limit
 *                  comes from the plan (via `RESOURCE_LIMIT_MAP`); the current
 *                  count is queried live from the resource's own table.
 *   • `activity` — real usage with NO plan limit and no meaningful cap
 *                  (informational). Rendered as "unlimited/untracked".
 *
 * Since the resource-limit extension (migration 1730002000000) almost everything
 * is now quota-aware; only truly uncappable/not-integrated signals stay activity.
 *
 * `source` drives batched aggregation + drill-down. `tenantColumn` captures the
 * FK-column convention (relation FKs are camelCase `"tenantId"`; a couple of
 * tables use an explicit `tenant_id`). Limit RESOLUTION lives in `UsageService`
 * (single source of truth) — this registry only supplies counts + presentation.
 */

import { RESOURCE_LIMIT_MAP } from '../subscription-billing/usage-metric';

export type MetricKind = 'quota' | 'count' | 'activity';
export type MetricUnit = 'tokens' | 'count' | 'bytes';

/**
 * Metric → its `subscription_plans` limit column (metered + count-based), the
 * ONE mapping reused wherever a metric's plan limit is needed (cell builder,
 * platform summary, upgrade recommendation). Metered columns are literal; the
 * count-based ones come from the Subscription Module's `RESOURCE_LIMIT_MAP` so
 * there is a single source for those too.
 */
export const PLAN_LIMIT_COLUMN: Record<string, string> = {
  aiTokens: 'max_ai_tokens',
  whatsappMessages: 'max_whatsapp_messages',
  appointments: 'max_appointments',
  campaigns: 'max_campaigns',
  ...RESOURCE_LIMIT_MAP,
};

export interface MetricSource {
  table: string;
  tenantColumn: string;
  measure: string;
  timeColumn: string | null;
  periodColumn?: string;
  where?: string;
  tenantIsText?: boolean;
}

export interface UsageMetricDef {
  key: string;
  label: string;
  kind: MetricKind;
  unit: MetricUnit;
  /** For `quota`: the key inside `getBreakdown().metrics` (metered metrics). */
  breakdownKey?: 'aiTokens' | 'whatsappMessages' | 'appointments' | 'campaigns';
  /** For `count`/`activity`: the live data source. */
  source?: MetricSource;
  /** Whether a time-series drill-down is available. */
  drilldown: boolean;
  /** True when the metric is NOT metered (its live count feeds the breakdown). */
  countable: boolean;
}

// Relation FK convention (TypeORM default): `@ManyToOne(() => Tenant)` → "tenantId".
const T = '"tenantId"';

export const USAGE_METRICS: Record<string, UsageMetricDef> = {
  // ── Metered quotas (subscription_usage accumulators) ─────────────────────
  aiTokens: {
    key: 'aiTokens', label: 'AI Tokens', kind: 'quota', unit: 'tokens', breakdownKey: 'aiTokens',
    drilldown: true, countable: false,
    source: { table: 'ai_usage_logs', tenantColumn: T, measure: 'SUM(total_tokens)', timeColumn: null, periodColumn: 'period_month' },
  },
  whatsappMessages: {
    key: 'whatsappMessages', label: 'WhatsApp Messages', kind: 'quota', unit: 'count', breakdownKey: 'whatsappMessages',
    drilldown: true, countable: false,
    source: { table: 'messages', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at', where: 'wa_message_id IS NOT NULL' },
  },
  appointments: {
    key: 'appointments', label: 'Appointments', kind: 'quota', unit: 'count', breakdownKey: 'appointments',
    drilldown: true, countable: false,
    source: { table: 'appointments', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  campaigns: {
    key: 'campaigns', label: 'Campaigns', kind: 'quota', unit: 'count', breakdownKey: 'campaigns',
    drilldown: true, countable: false,
    source: { table: 'campaigns', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },

  // ── Count-based caps (plan limit via RESOURCE_LIMIT_MAP + live count) ─────
  aiRequests: {
    key: 'aiRequests', label: 'AI Requests', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'ai_usage_logs', tenantColumn: T, measure: 'SUM(total_requests)', timeColumn: null, periodColumn: 'period_month' },
  },
  branches: {
    key: 'branches', label: 'Branches', kind: 'count', unit: 'count', drilldown: false, countable: true,
    source: { table: 'branches', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  employees: {
    key: 'employees', label: 'Employees', kind: 'count', unit: 'count', drilldown: false, countable: true,
    source: { table: 'users', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  customers: {
    key: 'customers', label: 'Active Customers', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'customers', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  crmContacts: {
    key: 'crmContacts', label: 'CRM Contacts', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'whatsapp_contacts', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  conversations: {
    key: 'conversations', label: 'Conversations', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'conversations', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  storageBytes: {
    key: 'storageBytes', label: 'Storage Used', kind: 'count', unit: 'bytes', drilldown: true, countable: true,
    source: { table: 'file_uploads', tenantColumn: T, measure: 'COALESCE(SUM(file_size),0)', timeColumn: 'created_at' },
  },
  uploadedFiles: {
    key: 'uploadedFiles', label: 'Uploaded Files', kind: 'count', unit: 'bytes', drilldown: true, countable: true,
    source: { table: 'file_uploads', tenantColumn: T, measure: 'COALESCE(SUM(file_size),0)', timeColumn: 'created_at' },
  },
  apiCalls: {
    key: 'apiCalls', label: 'API Calls', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'api_logs', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  invoices: {
    key: 'invoices', label: 'Invoices', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'invoices', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  payments: {
    key: 'payments', label: 'Payments', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'payments', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  transactions: {
    key: 'transactions', label: 'Transactions', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'transactions', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  emails: {
    key: 'emails', label: 'Emails', kind: 'count', unit: 'count', drilldown: true, countable: true,
    // email_logs stores tenant_id as a uuid column (matching the other FKs).
    source: { table: 'email_logs', tenantColumn: 'tenant_id', measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  knowledgeBaseFiles: {
    key: 'knowledgeBaseFiles', label: 'Knowledge Base Files', kind: 'count', unit: 'count', drilldown: true, countable: true,
    source: { table: 'ai_knowledge_bases', tenantColumn: T, measure: 'COUNT(*)', timeColumn: 'created_at' },
  },
  trainingFiles: {
    key: 'trainingFiles', label: 'Training Files', kind: 'count', unit: 'bytes', drilldown: true, countable: true,
    source: { table: 'ai_training_files', tenantColumn: T, measure: 'COALESCE(SUM(file_size),0)', timeColumn: 'created_at' },
  },
};

/** Ordered metric keys for stable dashboard rendering. */
export const USAGE_METRIC_ORDER: string[] = [
  'aiTokens',
  'aiRequests',
  'whatsappMessages',
  'appointments',
  'campaigns',
  'branches',
  'employees',
  'customers',
  'crmContacts',
  'conversations',
  'storageBytes',
  'uploadedFiles',
  'apiCalls',
  'invoices',
  'payments',
  'transactions',
  'emails',
  'knowledgeBaseFiles',
  'trainingFiles',
];
