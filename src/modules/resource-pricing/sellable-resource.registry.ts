import {
  USAGE_METRIC,
  USAGE_METRIC_MAP,
  RESOURCE_LIMIT_MAP,
  UsageMetric,
  ResourceMetric,
} from '../subscription-billing/usage-metric';
import { FeatureKey, RESOURCE_LIMIT_FEATURE } from '../subscription-billing/feature-registry';

/**
 * The sellable-resource registry — Pricing Catalog plan, Phase 1.1.
 *
 * The ONLY place a paid add-on item may be declared. The catalog, ledger and
 * purchase modules (Phase 2+) read this array rather than hand-listing item
 * keys, so a sellable item can never exist without a real plan column, a
 * real feature and a real enforcement seam already wired for it —
 * `sellable-resource.registry.spec.ts` asserts all three at load time.
 *
 * Items are either:
 *   - `credit`   — a metered {@link UsageMetric} (`subscription_usage`
 *                  accumulator). Purchased units become a non-expiring
 *                  prepaid balance, spent only after the plan's monthly
 *                  allowance is exhausted (plan §9 — Phase 1.3's
 *                  `TenantMetricCreditsService`).
 *   - `capacity` — a {@link ResourceMetric} count cap on `subscription_plans`.
 *                  Purchased units are a permanent additive delta on top of
 *                  the plan limit, independent of plan changes (plan §6
 *                  decision 2 — Phase 1.3's `TenantEntitlementLedgerService`).
 *
 * A capacity item is sellable only when it is BOTH enforced
 * (`UsageService.assertResourceWithinLimit` THROWS at call time for any
 * `ResourceMetric` not in `ENFORCED_RESOURCE_LIMITS` — see that set's doc
 * comment in `feature-registry.ts` for the reviewed 7-of-15 split) and free
 * of an independent architectural blocker. As of this file only
 * `storageBytes` carries such a blocker — see its entry below.
 *
 * Phase 0.1 (already shipped) exposed the 13 previously-unwritable `max_*`
 * plan columns via the admin DTO/service. That closes the ONLY reason
 * `customers`, `uploadedFiles`, `knowledgeBaseFiles` and `trainingFiles` were
 * excluded from the plan's original "V1 ships 6" table — they are full
 * registry members here, on equal footing with the original 6. The
 * distinction was about implementation ORDER, not a permanent restriction;
 * this registry has no notion of "V1 vs V2" at all, only genuinely
 * structural blocks (`eligibility: 'blocked'`).
 *
 * The 8 reporting-only `ResourceMetric` entries (`aiRequests`,
 * `crmContacts`, `conversations`, `apiCalls`, `emails`, `invoices`,
 * `payments`, `transactions`) are not represented here — not even as a
 * `blocked` row. They refuse nothing at any mutation seam by deliberate,
 * reviewed design; selling one would first require adding real enforcement,
 * which is out of this registry's scope.
 *
 * Boolean feature add-ons (`whatsapp`, `campaigns`, `ai.assistant`) are a
 * structurally different kind of sale — granting one currently ALSO sets
 * `QuotaPolicy.UNMETERED_BY_PLAN` on its whole dependency closure, forever
 * (plan §10) — and are intentionally absent from this registry.
 */

export const SELLABLE_KIND = {
  CREDIT: 'credit',
  CAPACITY: 'capacity',
} as const;
export type SellableKind = (typeof SELLABLE_KIND)[keyof typeof SELLABLE_KIND];

type CreditPlanColumn = (typeof USAGE_METRIC_MAP)[UsageMetric]['limitColumn'];
type CapacityPlanColumn = (typeof RESOURCE_LIMIT_MAP)[ResourceMetric];
/** Every `subscription_plans` limit column reachable through either metric map. */
export type PlanLimitColumn = CreditPlanColumn | CapacityPlanColumn;

export type UnitLabel =
  | 'tokens_1k'
  | 'message'
  | 'appointment'
  | 'campaign'
  | 'branch'
  | 'seat'
  | 'customer'
  | 'uploaded_file'
  | 'knowledge_base_file'
  | 'training_file'
  | 'storage_byte';

/**
 * A human-readable `file.ts:Class.method` pointer at the seam that actually
 * refuses the write (capacity) or admits the increment (credit). This is
 * documentation, not a compiler-checked reference — kept honest by
 * `sellable-resource.registry.spec.ts` being the place a future call-site
 * move gets reflected.
 */
export type EnforcementSeam = string;

export interface SellableResourceSpec {
  /**
   * Catalog + ledger + purchase key. Deliberately the metric's OWN canonical
   * identifier (the `UsageMetric` value for credits, the `ResourceMetric` key
   * for capacity) rather than a second name invented for the same thing.
   */
  itemKey: string;
  kind: SellableKind;
  meteredMetric?: UsageMetric;
  resourceMetric?: ResourceMetric;
  planColumn: PlanLimitColumn;
  /**
   * True for the 3 bigint-backed plan columns (`max_ai_tokens`,
   * `max_storage_bytes`, `max_api_calls`) — pg returns these as strings.
   * Mirrors the `bigint` flag Phase 0.1 added to `PlanAdminService`'s
   * `PLAN_LIMIT_FIELDS`; `apiCalls` never appears here because it is
   * reporting-only (excluded above), so only `AI_TOKENS` and `storageBytes`
   * actually carry `true`.
   */
  isBigInt: boolean;
  feature: FeatureKey;
  unitLabel: UnitLabel;
  /**
   * Raw plan-column units per one purchasable unit. 1000 for AI tokens (the
   * "priced per 1,000, linear scaling" requirement); 1 for everything else.
   */
  unitSize: number;
  enforcement: EnforcementSeam;
  eligibility: 'sellable' | 'blocked';
  blockedReason?: string;
}

function creditItem(
  metric: UsageMetric,
  feature: FeatureKey,
  unitLabel: UnitLabel,
  unitSize: number,
  enforcement: EnforcementSeam,
): SellableResourceSpec {
  return {
    itemKey: metric,
    kind: SELLABLE_KIND.CREDIT,
    meteredMetric: metric,
    planColumn: USAGE_METRIC_MAP[metric].limitColumn,
    isBigInt: USAGE_METRIC_MAP[metric].isBigInt,
    feature,
    unitLabel,
    unitSize,
    enforcement,
    eligibility: 'sellable',
  };
}

function capacityItem(
  metric: ResourceMetric,
  unitLabel: UnitLabel,
  enforcement: EnforcementSeam,
  opts: { isBigInt?: boolean; eligibility?: 'sellable' | 'blocked'; blockedReason?: string } = {},
): SellableResourceSpec {
  return {
    itemKey: metric,
    kind: SELLABLE_KIND.CAPACITY,
    resourceMetric: metric,
    planColumn: RESOURCE_LIMIT_MAP[metric],
    isBigInt: opts.isBigInt ?? false,
    feature: RESOURCE_LIMIT_FEATURE[metric],
    unitLabel,
    unitSize: 1,
    enforcement,
    eligibility: opts.eligibility ?? 'sellable',
    ...(opts.blockedReason ? { blockedReason: opts.blockedReason } : {}),
  };
}

export const SELLABLE_RESOURCE_REGISTRY: readonly SellableResourceSpec[] = [
  // ── Credits — prepaid, non-expiring; spent only after the plan's monthly
  // allowance is exhausted (plan §9) ─────────────────────────────────────
  creditItem(
    USAGE_METRIC.AI_TOKENS,
    FeatureKey.AI_ASSISTANT,
    'tokens_1k',
    1000,
    'ai/ai-execution.service.ts:AiExecutionService.sendMessage:256 / streamMessage:1100 (admission via UsageService.incrementIfWithinLimit)',
  ),
  creditItem(
    USAGE_METRIC.WHATSAPP_MESSAGES,
    FeatureKey.WHATSAPP,
    'message',
    1,
    'whatsapp/whatsapp-messaging.service.ts:85 + whatsapp/whatsapp-execution.service.ts:204 (via UsageService.incrementIfWithinLimit)',
  ),
  creditItem(
    USAGE_METRIC.APPOINTMENTS,
    FeatureKey.APPOINTMENTS,
    'appointment',
    1,
    'appointment/appointment.service.ts:351 (via UsageService.incrementIfWithinLimit)',
  ),
  creditItem(
    USAGE_METRIC.CAMPAIGNS,
    FeatureKey.CAMPAIGNS,
    'campaign',
    1,
    'campaigns/campaign.service.ts:64 (via UsageService.incrementIfWithinLimit)',
  ),

  // ── Capacity — permanent additive deltas, independent of the plan
  // (plan §6 decision 2) ──────────────────────────────────────────────────
  capacityItem(
    'branches',
    'branch',
    'tenant/branch.service.ts:60 (via UsageService.assertCountWithinLimit)',
  ),
  capacityItem(
    'employees',
    'seat',
    'staff/staff.service.ts:412 + auth/auth.service.ts:235 (via UsageService.assertUserSeatWithinLimit)',
  ),
  capacityItem(
    'customers',
    'customer',
    'crm/customer.service.ts:49 (via UsageService.assertResourceWithinLimit)',
  ),
  capacityItem(
    'uploadedFiles',
    'uploaded_file',
    'platform/file-upload.service.ts:78 (via UsageService.assertResourceWithinLimit)',
  ),
  capacityItem(
    'knowledgeBaseFiles',
    'knowledge_base_file',
    'ai/ai-knowledge-base.service.ts:44 (via UsageService.assertResourceWithinLimit)',
  ),
  capacityItem(
    'trainingFiles',
    'training_file',
    'ai/ai-training-file.service.ts:64 (via UsageService.assertResourceWithinLimit)',
  ),
  capacityItem(
    'storageBytes',
    'storage_byte',
    'platform/file-upload.service.ts:84 (via UsageService.assertResourceWithinLimit)',
    {
      isBigInt: true,
      eligibility: 'blocked',
      blockedReason:
        'file_uploads.file_size is client-claimed and the real object store (R2) is unmetered — billing against it would charge for a number the buyer supplies (plan §11). Unblock requires server-measured byte accounting on the R2 upload path.',
    },
  ),
];

export const SELLABLE_ITEM_KEYS: readonly string[] = SELLABLE_RESOURCE_REGISTRY.map(
  (r) => r.itemKey,
);

export function findSellableResource(itemKey: string): SellableResourceSpec | undefined {
  return SELLABLE_RESOURCE_REGISTRY.find((r) => r.itemKey === itemKey);
}
