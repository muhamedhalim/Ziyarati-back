import * as fs from 'fs';
import * as path from 'path';

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
  'platform/system-setting.controller.ts',
  'platform-ai-monitoring/platform-ai-monitoring.controller.ts',
  'platform-dashboard/platform-dashboard.controller.ts',
  'platform-finance/platform-finance.controller.ts',
  'platform-monitoring/platform-monitoring.controller.ts',
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
  'public-discovery/public-discovery.controller.ts',
  'integration-platform/inbound/inbound-webhook.controller.ts',
  'notifications/notification-webhook.controller.ts',
  'payments/payment-webhook.controller.ts',
  'whatsapp/whatsapp-webhook.controller.ts',
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
        src.includes('@NoEntitlementRequired()');
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
        src.includes('@NoEntitlementRequired()')
      );
    });

    expect(stale).toEqual([]);
  });

  it('only ever names real registry keys in @RequireFeature', () => {
    // The typed decorator already makes this a compile error; this catches a
    // key smuggled in via a cast or a string literal.
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const [, arg] of src.matchAll(/@RequireFeature\(([^)]*)\)/g)) {
        if (!arg.trim().startsWith('FeatureKey.')) {
          offenders.push(`${relative(file)}: ${arg.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
