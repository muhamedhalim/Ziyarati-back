import { FeatureKey } from './feature-registry';

/**
 * Where a granted (or refused) access decision came from.
 *
 * The STRING VALUES are unchanged from the original `AccessSource` in
 * `platform-billing.constants.ts` — they are returned to clients in
 * `publicContext.source` and in `GET /feature-flags/effective`'s
 * `subscription.source`, and they are already written into
 * `platform_admin_audit` rows. Only the member NAMES changed, to say what the
 * source is rather than how it was implemented (`FREE_OVERRIDE` was routinely
 * confused with the per-feature override, which is a different thing entirely).
 */
export enum AccessSource {
  /** Platform-wide FREE mode — nobody is gated. */
  PLATFORM_FREE_MODE = 'platform_free_mode',
  /** A super-admin `free_access_overrides` grant: tenant-wide, time-boxed. */
  ADMIN_FREE_ACCESS = 'free_override',
  /** A usable paid subscription — the only source that carries plan quotas. */
  ACTIVE_SUBSCRIPTION = 'subscription',
  /** A super-admin per-feature grant via `/platform/feature-flags`. */
  FEATURE_OVERRIDE = 'feature_override',
  /** No access path resolved, or an explicit administrative suspension. */
  DENIED = 'none',
}

/**
 * How usage is treated once access has been granted.
 *
 * This is the piece that was missing: enforcement used to be a bare boolean
 * (`isEnforced`) that every caller re-interpreted, and three of them
 * re-derived it WITHOUT the feature scope — which is why a tenant admitted by
 * a feature override then hit `No active subscription found for this tenant`
 * from the usage layer. Making it an explicit part of the decision means a
 * caller can only ask "what does the policy say?", never "let me work it out
 * again".
 */
export enum QuotaPolicy {
  /** A plan exists: its limits apply (raised, never lowered, by overrides). */
  PLAN_ENFORCED = 'plan_enforced',
  /**
   * Access came from a per-feature admin grant. There is no plan, so there is
   * no limit to enforce — but usage is still RECORDED, so the platform can see
   * what an override tenant consumes instead of being blind to it.
   * Deliberately not "unlimited": infrastructure controls (rate limiting,
   * provider caps, concurrency) still apply.
   */
  UNMETERED_BY_PLAN = 'unmetered_by_plan',
  /** Platform-wide FREE mode. Recorded, not capped. */
  UNMETERED_PLATFORM_FREE = 'unmetered_platform_free',
  /** Tenant-wide super-admin free access. Recorded, not capped. */
  UNMETERED_ADMIN_GRANT = 'unmetered_admin_grant',
  /** Access refused — nothing may be consumed or recorded. */
  BLOCKED = 'blocked',
}

/** Quota policies under which no plan limit exists to compare against. */
export const UNMETERED_POLICIES: readonly QuotaPolicy[] = [
  QuotaPolicy.UNMETERED_BY_PLAN,
  QuotaPolicy.UNMETERED_PLATFORM_FREE,
  QuotaPolicy.UNMETERED_ADMIN_GRANT,
];

export function isUnmetered(policy: QuotaPolicy): boolean {
  return UNMETERED_POLICIES.includes(policy);
}

/** Why a feature-override grant applied — the key itself, or its closure. */
export interface GrantProvenance {
  /** The override was set on the feature that was asked about. */
  directly: boolean;
  /** Set on this feature instead; the asked-about key is in its closure. */
  viaDependencyOf?: FeatureKey;
}

/**
 * The single answer every protected action resolves. Nothing downstream should
 * ask "does this tenant have a subscription?" — it should ask for this and read
 * `allowed` and `quotaPolicy`.
 */
export interface TenantAccessDecision {
  allowed: boolean;
  tenantId: string;
  /** The capability that was asked about; null for a tenant-wide check. */
  featureKey: FeatureKey | null;
  source: AccessSource;
  /** Present only when `source === ACTIVE_SUBSCRIPTION`. */
  subscriptionId?: string;
  /** Present only when `source === ACTIVE_SUBSCRIPTION`. */
  planId?: string;
  quotaPolicy: QuotaPolicy;
  /** Present only when `source === FEATURE_OVERRIDE`. */
  grantedVia?: GrantProvenance;
  /**
   * Technical explanation for a denial. SERVER-SIDE ONLY — it names
   * subscription state, so it goes to `internalContext`/logs and never to a
   * client, which sees the friendly NO_ACTIVE_SUBSCRIPTION copy instead.
   */
  reason?: string;
  /** When the grant lapses (override end / subscription end), if bounded. */
  expiresAt?: Date | null;
}

/**
 * Fail-closed constructor. Used wherever a decision cannot be resolved — an
 * unknown feature key, an unreadable tenant, an error inside the chain — so
 * "we don't know" can never be mistaken for "yes".
 */
export function deniedDecision(
  tenantId: string,
  featureKey: FeatureKey | null,
  reason: string,
): TenantAccessDecision {
  return {
    allowed: false,
    tenantId,
    featureKey,
    source: AccessSource.DENIED,
    quotaPolicy: QuotaPolicy.BLOCKED,
    reason,
  };
}
