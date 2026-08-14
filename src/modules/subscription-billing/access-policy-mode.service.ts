import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TenantAccessDecision } from './tenant-access-decision';

export const ACCESS_POLICY_MODE = {
  /** Evaluate the real policy, record what WOULD have been denied, block nothing. */
  SHADOW: 'shadow',
  /** Evaluate the real policy and act on it. */
  ENFORCE: 'enforce',
} as const;

export type AccessPolicyMode =
  (typeof ACCESS_POLICY_MODE)[keyof typeof ACCESS_POLICY_MODE];

/** Where a denial was observed — a route, a job name, a socket event, a seam. */
export interface DenialSite {
  /** `http` | `worker` | `websocket` | `service` — the execution surface. */
  surface: string;
  /** A stable identifier within that surface, e.g. `POST /campaigns`. */
  detail: string;
}

/**
 * Rollout control for the tenant access policy (plan §18).
 *
 * The policy this codebase now enforces is materially stricter than what
 * production ran before it: 128 controllers gained a capability annotation,
 * background jobs gained an entitlement gate, and the platform is still in FREE
 * billing mode, so NONE of it has ever been exercised against real traffic. A
 * hard cutover would surface every registry under-grant simultaneously, as
 * customer-visible 403s.
 *
 * `ACCESS_POLICY_MODE=shadow` resolves the decision exactly as `enforce` does —
 * same reads, same precedence, same `quotaPolicy` — and then declines to act on
 * a denial, logging it instead. The deny log IS the regression list: run it for
 * a period, review what it names, fix the registry/plan matrix, then flip to
 * `enforce`. Rollback is the same env var back to `shadow`.
 *
 * TWO THINGS SHADOW MODE DELIBERATELY DOES NOT DO:
 *
 *  1. It does not touch `quotaPolicy`. Metering is not authorization — a
 *     shadow-admitted tenant is still metered exactly as the truthful decision
 *     says, so no counter drifts and no paying tenant is silently unmetered
 *     while the flag is on.
 *  2. It does not weaken any check that is not part of THIS policy. Tenant
 *     lifecycle (`ActiveTenantGuard`), authentication, RBAC permissions,
 *     rate limits, provider caps and the grace-expired billable-write gate all
 *     continue to block in shadow mode. Shadow covers entitlement only.
 *
 * Default is `enforce`. An unrecognised value is treated as `enforce` and
 * logged: a typo in an env var must not silently disable authorization.
 */
@Injectable()
export class AccessPolicyModeService {
  private readonly logger = new Logger('AccessPolicy');
  private readonly mode: AccessPolicyMode;

  /**
   * Dedupes the shadow log per (tenant, feature, site) so a hot route cannot
   * flood the log with the same finding thousands of times a minute. The point
   * of the log is the DISTINCT set of things that would break, not the volume.
   */
  private readonly seen = new Map<string, number>();
  private static readonly REPEAT_AFTER_MS = 60_000;
  private static readonly MAX_TRACKED = 5_000;

  constructor(private readonly config: ConfigService) {
    const raw = (
      this.config.get<string>('ACCESS_POLICY_MODE') ??
      ACCESS_POLICY_MODE.ENFORCE
    )
      .trim()
      .toLowerCase();

    if (raw === ACCESS_POLICY_MODE.SHADOW) {
      this.mode = ACCESS_POLICY_MODE.SHADOW;
      this.logger.warn(
        'ACCESS_POLICY_MODE=shadow — entitlement denials will be LOGGED BUT NOT ENFORCED. ' +
          'Authentication, RBAC, tenant lifecycle, rate limits and quota metering are unaffected. ' +
          'Set ACCESS_POLICY_MODE=enforce (the default) before relying on feature entitlement.',
      );
      return;
    }

    if (raw !== ACCESS_POLICY_MODE.ENFORCE) {
      this.logger.error(
        `Unrecognised ACCESS_POLICY_MODE="${raw}" — falling back to "enforce". ` +
          `Valid values: ${Object.values(ACCESS_POLICY_MODE).join(', ')}.`,
      );
    }
    this.mode = ACCESS_POLICY_MODE.ENFORCE;
  }

  get current(): AccessPolicyMode {
    return this.mode;
  }

  get isShadow(): boolean {
    return this.mode === ACCESS_POLICY_MODE.SHADOW;
  }

  /**
   * THE single question every enforcement point asks about a denial: "do I act
   * on this?".
   *
   * Returns `true` in enforce mode (the caller throws/refuses as it always
   * has). Returns `false` in shadow mode, having first recorded the denial.
   * Callers must not branch on the mode themselves — routing every refusal
   * through here is what keeps shadow mode a single switch rather than a
   * condition sprinkled across guards, workers, gateways and seams.
   */
  shouldBlock(decision: TenantAccessDecision, site: DenialSite): boolean {
    if (!this.isShadow) return true;
    this.record(decision, site);
    return false;
  }

  /**
   * Logs one would-be denial, deduped.
   *
   * Payload is deliberately narrow: tenant id, feature key, access source and
   * the call site. No principal, no request body, no subscription identifiers,
   * no `decision.reason` (which names subscription status) — a rollout log runs
   * for weeks at info level and must not become a place tenant billing state
   * accumulates.
   */
  private record(decision: TenantAccessDecision, site: DenialSite): void {
    const key = `${decision.tenantId}|${decision.featureKey ?? '-'}|${site.surface}|${site.detail}`;
    const now = Date.now();
    const last = this.seen.get(key);
    if (
      last !== undefined &&
      now - last < AccessPolicyModeService.REPEAT_AFTER_MS
    ) {
      return;
    }
    // Bounded: a pathological cardinality (e.g. per-id detail strings) must not
    // grow this map without limit. Dropping the oldest costs at most a repeated
    // log line.
    if (this.seen.size >= AccessPolicyModeService.MAX_TRACKED) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    this.seen.set(key, now);

    this.logger.warn(
      `SHADOW-DENY surface=${site.surface} at=${site.detail} tenant=${decision.tenantId} ` +
        `feature=${decision.featureKey ?? '-'} source=${decision.source} — allowed through because ` +
        'ACCESS_POLICY_MODE=shadow. This request WOULD be refused in enforce mode.',
    );
  }
}
