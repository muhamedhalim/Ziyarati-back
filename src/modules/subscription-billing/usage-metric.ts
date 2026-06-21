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

/** Current billing period key, e.g. "2026-06". */
export function currentPeriodMonth(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
