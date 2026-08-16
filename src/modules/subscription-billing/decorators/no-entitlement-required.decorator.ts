import { SetMetadata } from '@nestjs/common';

import { FeatureKey } from '../feature-registry';

export const NO_ENTITLEMENT_REQUIRED_KEY = 'noEntitlementRequired';

/**
 * WHY a clinic-facing route carries no capability gate.
 *
 * Either it belongs to an `alwaysOn` capability — one the registry declares can
 * never be gated, so `@RequireFeature` there would be a gate that always opens
 * — or it is reached before a tenant has any entitlement to resolve at all.
 *
 * Requiring the answer as a TYPED value is what turns "every clinic-facing
 * capability is either controllable by a super-admin or documented as always-on"
 * from a claim in a report into something the build checks. A bare
 * `@NoEntitlementRequired()` recorded that a decision had been made but not
 * which one, so the two categories were indistinguishable from each other and
 * from a key someone had simply never added to the registry.
 */
export type UngatedRationale = FeatureKey | 'PRE_ENTITLEMENT';

/**
 * Declares that a route is DELIBERATELY not gated by any capability.
 *
 * This is not the same as forgetting to annotate, and that distinction is the
 * whole point: a structural test requires every clinic-facing controller to
 * carry either `@RequireFeature(...)` or this decorator, so "ungated" becomes a
 * recorded decision rather than an oversight. 17 clinic-facing controllers —
 * including WhatsApp Embedded Signup, workflows and every integration
 * endpoint — were reachable with no billing gate at all simply because nobody
 * had added one.
 *
 * Legitimate uses, all of them cases where gating would be actively harmful:
 *  - billing / subscription / usage — a DENIED tenant must still be able to pay
 *  - support tickets — a blocked tenant must still be able to ask for help
 *  - auth, onboarding and verification — reached before entitlement exists
 *  - cross-cutting infrastructure whose callers are themselves gated
 *  - super-admin and platform-operator surfaces, which tenant billing never gates
 *
 * `rationale` names the always-on {@link FeatureKey} the routes belong to, or
 * `'PRE_ENTITLEMENT'` when they are reached before any entitlement exists. It
 * is METADATA ONLY — no guard reads it, so annotating a controller cannot
 * change its runtime behaviour. Its job is to make the exemption legible and
 * testable (`controller-entitlement-coverage.spec.ts`).
 */
export const NoEntitlementRequired = (rationale: UngatedRationale) =>
  SetMetadata(NO_ENTITLEMENT_REQUIRED_KEY, rationale);
