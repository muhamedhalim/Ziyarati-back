/**
 * Usage metrics tracked per billing cycle, mapped to their `subscription_usage`
 * column and the corresponding `subscription_plans` limit column. Centralizing
 * the mapping keeps increment/limit logic in one place and type-safe.
 */
export const USAGE_METRIC = {
  AI_TOKENS: 'AI_TOKENS',
  WHATSAPP_MESSAGES: 'WHATSAPP_MESSAGES',
  APPOINTMENTS: 'APPOINTMENTS',
  CAMPAIGNS: 'CAMPAIGNS',
} as const;

export type UsageMetric = (typeof USAGE_METRIC)[keyof typeof USAGE_METRIC];

interface MetricMapping {
  /** Column on `subscription_usage` that accumulates this metric. */
  usageColumn:
    | 'ai_tokens_used'
    | 'whatsapp_messages_used'
    | 'appointments_used'
    | 'campaigns_used';
  /** Limit column on `subscription_plans` (null = no limit defined). */
  limitColumn:
    | 'max_ai_tokens'
    | 'max_whatsapp_messages'
    | 'max_appointments'
    | 'max_campaigns';
  /** bigint columns are stored/returned as strings by pg. */
  isBigInt: boolean;
}

export const USAGE_METRIC_MAP: Record<UsageMetric, MetricMapping> = {
  [USAGE_METRIC.AI_TOKENS]: {
    usageColumn: 'ai_tokens_used',
    limitColumn: 'max_ai_tokens',
    isBigInt: true,
  },
  [USAGE_METRIC.WHATSAPP_MESSAGES]: {
    usageColumn: 'whatsapp_messages_used',
    limitColumn: 'max_whatsapp_messages',
    isBigInt: false,
  },
  [USAGE_METRIC.APPOINTMENTS]: {
    usageColumn: 'appointments_used',
    limitColumn: 'max_appointments',
    isBigInt: false,
  },
  [USAGE_METRIC.CAMPAIGNS]: {
    usageColumn: 'campaigns_used',
    limitColumn: 'max_campaigns',
    isBigInt: false,
  },
};

// The metric → feature mapping that used to live here is now DERIVED from
// `FEATURE_REGISTRY` (see `featuresForMetric` in `feature-registry.ts`).
//
// It was a hand-maintained second list, and it is where the `ai` /
// `ai.assistant` drift had to be papered over by accepting BOTH keys — an
// accommodation that only worked for metering, never for the route guard,
// which still used the raw key. Deriving from the registry removes the
// possibility of the two lists disagreeing at all.
//
// This module stays a LEAF (no import back into the registry), so nothing here
// creates an import cycle.

/**
 * Plan limits that cap an ABSOLUTE count of a resource (not per-month usage).
 *
 * Unlike USAGE_METRIC there is no accumulator column on `subscription_usage` —
 * the current count is queried live from the resource's own table and compared
 * against the plan limit. Used by `UsageService.assertCountWithinLimit`.
 */
export const COUNT_LIMIT = {
  BRANCHES: 'max_branches',
  USERS: 'max_users',
} as const;

export type CountLimitColumn = (typeof COUNT_LIMIT)[keyof typeof COUNT_LIMIT];

/**
 * Count-based resource caps: an ABSOLUTE limit on the number of a resource,
 * compared against a LIVE count from the resource's own table (there is no
 * per-month accumulator). Every entry maps a stable metric key to its
 * `subscription_plans` column — the ONLY place these limits are defined, so the
 * plan stays the single source of truth. A null plan column = unlimited.
 *
 * `max_branches` / `max_users` predate this map (see COUNT_LIMIT) and are folded
 * in here so `UsageService` can resolve every count limit through one registry.
 * Metered metrics (USAGE_METRIC) are intentionally NOT included — they resolve
 * via `subscription_usage` + getBreakdown instead.
 */
export const RESOURCE_LIMIT_MAP = {
  aiRequests: 'max_ai_requests',
  customers: 'max_customers',
  crmContacts: 'max_crm_contacts',
  conversations: 'max_conversations',
  employees: 'max_users',
  branches: 'max_branches',
  storageBytes: 'max_storage_bytes',
  uploadedFiles: 'max_uploaded_files',
  apiCalls: 'max_api_calls',
  emails: 'max_emails',
  invoices: 'max_invoices',
  payments: 'max_payments',
  transactions: 'max_transactions',
  knowledgeBaseFiles: 'max_knowledge_base_files',
  trainingFiles: 'max_training_files',
} as const;

export type ResourceMetric = keyof typeof RESOURCE_LIMIT_MAP;
export type ResourceLimitColumn = (typeof RESOURCE_LIMIT_MAP)[ResourceMetric];

/** Metered metric → its getBreakdown key (used by the unified breakdown). */
export const METERED_BREAKDOWN_KEY = {
  aiTokens: 'aiTokens',
  whatsappMessages: 'whatsappMessages',
  appointments: 'appointments',
  campaigns: 'campaigns',
} as const;

export type MeteredMetric = keyof typeof METERED_BREAKDOWN_KEY;

/** A single unified usage line — the shape every metric resolves to. */
export interface UnifiedUsageLine {
  used: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  exceeded: boolean;
  unlimited: boolean;
  /** Enforced AND exceeded — a write of this resource would be rejected. */
  blocked: boolean;
}

/** Current billing period key, e.g. "2026-06". */
export function currentPeriodMonth(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
