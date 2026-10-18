import * as fs from 'fs';
import * as path from 'path';

import { FEATURE_KEYS, FEATURE_REGISTRY, FeatureKey } from './feature-registry';

const MODULES_DIR = path.join(__dirname, '..');

/**
 * Controllers that legitimately carry NO capability annotation.
 *
 * Every entry is a decision, not an omission — which is the point of keeping
 * the list here rather than inferring it from a path pattern. Before this
 * existed, 17 clinic-facing controllers were reachable with no billing gate at
 * all (WhatsApp Embedded Signup, workflows, every integration endpoint,
 * uploads, branches) purely because nobody had added one, and nothing in the
 * build could tell that apart from a deliberate exemption.
 *
 * A clinic-facing controller does NOT belong here. Use
 * `@NoEntitlementRequired()` on the controller instead, so the decision lives
 * next to the code it governs.
 */
/**
 * Entitlement decision table for spec 014 "Clinic Platform Completion"
 * (T026A). Recorded here so every later controller task applies the same
 * decision rather than re-deriving one; each task below also carries this
 * table inline where it lands the annotation or the exemption-set entry.
 *
 * | New controller                                    | Policy                                    |
 * |----------------------------------------------------|--------------------------------------------|
 * | medical-records/clinical.controller.ts              | @RequireFeature(FeatureKey.CRM)            |
 * | crm/customer-segment.controller.ts                   | @RequireFeature(FeatureKey.CRM)            |
 * | patient-queue/patient-queue.controller.ts            | @RequireFeature(FeatureKey.APPOINTMENTS)   |
 * | waitlist/waitlist.controller.ts                      | @RequireFeature(FeatureKey.APPOINTMENTS)   |
 * | report-export/report-export.controller.ts            | @RequireFeature(FeatureKey.ANALYTICS)      |
 * | activity-log/activity-log.controller.ts              | @NoEntitlementRequired(FeatureKey.CORE_WORKSPACE) |
 * | patient-actions/patient-action.controller.ts         | PLATFORM_AND_PUBLIC_SURFACES (neither decorator — @Public(), no tenant principal) |
 * | public-booking/public-booking.controller.ts          | PLATFORM_AND_PUBLIC_SURFACES (neither decorator — @Public(), anonymous visitor) |
 * | email/unsubscribe.controller.ts                      | PLATFORM_AND_PUBLIC_SURFACES (neither decorator — must work regardless of billing state) |
 *
 * No new FeatureKey is introduced — every key above already exists in the
 * registry. The three PLATFORM_AND_PUBLIC_SURFACES rows are added to the set
 * below by the task that creates that controller file, not here, since an
 * entry naming a file that does not yet exist fails the stale-entry check.
 */
const PLATFORM_AND_PUBLIC_SURFACES = new Set([
  // Super-admin / platform-operator consoles. Tenant billing state never gates
  // a platform operator — `SubscriptionAccessGuard` bypasses principals with
  // no tenant id.
  'admin-notifications/admin-notification.controller.ts',
  'billing-upgrades/platform-billing-upgrade.controller.ts',
  'email/email-log.controller.ts',
  'payments/merchant-account-admin.controller.ts',
  'payments/payment-gateway.controller.ts',
  'payments/payments-ops.controller.ts',
  // Tap Phase 5: the reconciliation queue — super admin only (RolesGuard), platform-wide data.
  'payments/reconciliation/platform-reconciliation.controller.ts',
  'platform/platform-specialties.controller.ts',
  'platform/system-setting.controller.ts',
  'platform-ai-monitoring/platform-ai-monitoring.controller.ts',
  'platform-dashboard/platform-dashboard.controller.ts',
  'platform-finance/platform-finance.controller.ts',
  'platform-monitoring/platform-monitoring.controller.ts',
  'platform-sales/clinic-import.controller.ts',
  'platform-sales/sales-activities.controller.ts',
  'platform-sales/sales-assignment-import.controller.ts',
  'platform-sales/sales-assignments.controller.ts',
  'platform-sales/sales-bonuses.controller.ts',
  'platform-sales/sales-employees.controller.ts',
  'platform-sales/sales-self.controller.ts',
  'platform-sales/sales-targets.controller.ts',
  'platform-staff/platform-staff.controller.ts',
  'platform-support/platform-support-actions.controller.ts',
  'platform-support/platform-support-clinic.controller.ts',
  'platform-support/platform-support-jobs.controller.ts',
  'platform-usage/platform-usage.controller.ts',
  'platform-usage/usage-report.controller.ts',
  'rbac-audit/rbac-audit.controller.ts',
  'support-tickets/platform-support-ticket.controller.ts',
  'subscription-billing/platform-billing-admin.controller.ts',
  'subscription-billing/platform-feature-flag.controller.ts',
  'resource-pricing/platform-resource-catalog.controller.ts',

  // Authentication and RBAC administration — reached before, or independently
  // of, any entitlement.
  'auth/auth.controller.ts',
  'auth/permissions.controller.ts',
  'auth/roles.controller.ts',

  // The tenant's own billing surface. Gating these would strand a blocked
  // clinic with no way to see or buy a plan — the denial would have no exit.
  'subscription-billing/billing.controller.ts',
  'subscription-billing/subscription.controller.ts',
  'subscription-billing/usage.controller.ts',
  'subscription-billing/feature-flag.controller.ts',

  // `@Public()` ingress: authenticated by HMAC / provider signature / guest
  // token, with no tenant principal to resolve a decision against. The tenant's
  // entitlement is enforced downstream, at the execution seam these feed.
  'guest-chat/guest-chat.controller.ts',
  // T026A/T031 (spec 014) — authorised by the action-link token itself
  // (constant-time digest match), with no tenant principal at all to
  // resolve an entitlement against. Abuse is bounded by the T025 per-route
  // throttles, not a subscription gate.
  'patient-actions/patient-action.controller.ts',
  'public-discovery/public-discovery.controller.ts',
  // T065-T068 (spec 014, S4) — the deterministic step-by-step counterpart to
  // the public AI booking flow. Same reasoning as guest-chat above: an
  // anonymous visitor has no tenant principal until a clinic is selected, and
  // what the flow eventually costs is metered at `AppointmentsService.create`
  // (the same write path the AI tool dispatcher uses), not gated here.
  'public-booking/public-booking.controller.ts',
  'integration-platform/inbound/inbound-webhook.controller.ts',
  'notifications/notification-webhook.controller.ts',
  'payments/payment-webhook.controller.ts',
  // Tap migration Phase 4 — the patient pay page API. A patient has no tenant
  // principal to evaluate an entitlement against, and a payment must be possible
  // (and a clinic's money must reach the clinic) regardless of the clinic's own
  // billing state; the link token is the credential and abuse is bounded by the
  // per-route throttles, not a subscription gate.
  'payments/public-payment.controller.ts',
  // The Tap clinic-onboarding callback: posted by Tap, authenticated by the
  // unguessable per-session URL token, no tenant principal at all.
  'payments/tap-onboarding-callback.controller.ts',
  'whatsapp/whatsapp-webhook.controller.ts',
  // Phase 11 (US7, T134/T136, spec 014) — a recipient must be able to
  // unsubscribe regardless of the clinic's billing state (see the table
  // above). Bounce/complaint feedback no longer has an HTTP endpoint: it
  // arrives through the SES → SNS → SQS consumer on the worker.
  'email/unsubscribe.controller.ts',
]);

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) controllerFiles(full, out);
    else if (
      entry.name.endsWith('.controller.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

const relative = (file: string) =>
  path.relative(MODULES_DIR, file).split(path.sep).join('/');

/** `FeatureKey.BRANCHES` → `'branches'`; anything unrecognised → null. */
function resolveMember(expression: string): FeatureKey | null {
  const member = expression.trim().replace(/^FeatureKey\./, '');
  const value = (FeatureKey as Record<string, string>)[member];
  return value !== undefined ? (value as FeatureKey) : null;
}

/** Every `@RequireFeature(...)` argument in the tree, with its file. */
function requireFeatureArgs(files: string[]): { file: string; arg: string }[] {
  const out: { file: string; arg: string }[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, arg] of src.matchAll(/@RequireFeature\(([^)]*)\)/g)) {
      out.push({ file: relative(file), arg: arg.trim() });
    }
  }
  return out;
}

/** Every `@NoEntitlementRequired(...)` rationale in the tree, with its file. */
function ungatedRationales(files: string[]): { file: string; arg: string }[] {
  const out: { file: string; arg: string }[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, arg] of src.matchAll(/@NoEntitlementRequired\(([^)]*)\)/g)) {
      out.push({ file: relative(file), arg: arg.trim() });
    }
  }
  return out;
}

describe('every controller has an explicit entitlement policy', () => {
  const files = controllerFiles(MODULES_DIR);

  it('finds the controllers to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('leaves no controller silently ungated', () => {
    const unaccounted = files.filter((file) => {
      const src = fs.readFileSync(file, 'utf8');
      const annotated =
        src.includes('@RequireFeature(') ||
        src.includes('@NoEntitlementRequired(');
      return !annotated && !PLATFORM_AND_PUBLIC_SURFACES.has(relative(file));
    });

    expect(unaccounted.map(relative)).toEqual([]);
  });

  it('keeps the exemption list free of stale entries', () => {
    // A controller that has since been annotated (or deleted) must drop out of
    // the list, or the list slowly stops meaning anything.
    const present = new Set(files.map(relative));
    const stale = [...PLATFORM_AND_PUBLIC_SURFACES].filter((rel) => {
      if (!present.has(rel)) return true;
      const src = fs.readFileSync(path.join(MODULES_DIR, rel), 'utf8');
      return (
        src.includes('@RequireFeature(') ||
        src.includes('@NoEntitlementRequired(')
      );
    });

    expect(stale).toEqual([]);
  });

  it('only ever names real registry keys in @RequireFeature', () => {
    // The typed decorator already makes this a compile error; this catches a
    // key smuggled in via a cast or a string literal, AND a member name that
    // compiles but no longer exists in the registry.
    const offenders = requireFeatureArgs(files)
      .filter(
        ({ arg }) => !arg.startsWith('FeatureKey.') || !resolveMember(arg),
      )
      .map(({ file, arg }) => `${file}: ${arg}`);

    expect(offenders).toEqual([]);
  });

  it('records WHY every ungated clinic-facing controller is ungated', () => {
    // A bare `@NoEntitlementRequired()` said a decision had been made but not
    // which one, so "belongs to an always-on capability" and "reached before
    // entitlement exists" were indistinguishable from each other — and from a
    // capability nobody had added to the registry. The rationale must name a
    // real always-on key or the PRE_ENTITLEMENT literal.
    const offenders = ungatedRationales(files)
      .filter(({ arg }) => {
        if (arg === `'PRE_ENTITLEMENT'` || arg === `"PRE_ENTITLEMENT"`) {
          return false;
        }
        const key = arg.startsWith('FeatureKey.') ? resolveMember(arg) : null;
        // Naming a GATEABLE key here would be a contradiction: if the capability
        // can be gated, the controller should carry `@RequireFeature` instead.
        return !key || FEATURE_REGISTRY[key].alwaysOn !== true;
      })
      .map(({ file, arg }) => `${file}: ${arg || '(no rationale)'}`);

    expect(offenders).toEqual([]);
  });

  it('leaves no registry capability without a surface that uses it', () => {
    // The other direction of the same guarantee. Every key a super-admin can
    // toggle in `/platform/feature-flags` must correspond to something real:
    // either routes gate on it, or it is always-on and named as the rationale
    // for the controllers it covers. A key matching neither is a toggle that
    // does nothing — which is exactly how `@RequireFeature('ai')` came to gate
    // 10 controllers while the catalog only ever published `ai.assistant`.
    const gated = new Set(
      requireFeatureArgs(files)
        .map(({ arg }) => resolveMember(arg))
        .filter((k): k is FeatureKey => k !== null),
    );
    const documentedAlwaysOn = new Set(
      ungatedRationales(files)
        .map(({ arg }) => resolveMember(arg))
        .filter((k): k is FeatureKey => k !== null),
    );

    const orphans = FEATURE_KEYS.filter((key) => {
      const spec = FEATURE_REGISTRY[key];
      // A deprecated key is retained only so pre-existing rows still resolve;
      // it is not expected to gate anything.
      if (spec.isDeprecated) return false;
      // A service-enforced capability qualifies HOW an already-authorized
      // request executes rather than guarding a surface a caller reaches, so
      // there is no route to annotate. The flag is the author's explicit
      // assertion of where enforcement lives (see FeatureSpec.serviceEnforced)
      // — an unflagged key with no gating route is still an orphan.
      if (spec.serviceEnforced) return false;
      return spec.alwaysOn ? !documentedAlwaysOn.has(key) : !gated.has(key);
    });

    expect(orphans).toEqual([]);
  });
});
