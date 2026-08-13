import { SetMetadata } from '@nestjs/common';

export const NO_ENTITLEMENT_REQUIRED_KEY = 'noEntitlementRequired';

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
 */
export const NoEntitlementRequired = () =>
  SetMetadata(NO_ENTITLEMENT_REQUIRED_KEY, true);
