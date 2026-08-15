/**
 * ONE-OFF, App-Review-only tool that reconnects Meta's "Try it out" test WABA +
 * phone number to a specific clinic tenant for LOCAL WhatsApp testing.
 *
 * `WhatsappAccountService` deliberately refuses to accept credentials over the
 * API (see its class doc: "access_token / waba_id / phone_number_id are set
 * exclusively by MetaEmbeddedSignupService, which proves ownership with Meta
 * first"). Embedded Signup itself needs Meta's FB.login popup, which refuses
 * to run on a non-HTTPS page — this local dev frontend is http://localhost,
 * so Embedded Signup cannot complete here. This script exists ONLY to attach
 * the already-existing Meta App Review test asset (fixed WABA id + phone
 * number id, owned by the Meta App itself, not by any clinic's own Meta
 * Business) to a resolved tenant, using MetaGraphClient + EncryptionService
 * exactly the way MetaEmbeddedSignupService.persist() does — same fields,
 * same encryption, same connection_status semantics.
 *
 * CREATE-OR-UPDATE, tenant-resolved, Meta-validated, transfer-aware:
 *   1. Resolve the tenant from META_APP_REVIEW_CLINIC_EMAIL via the real
 *      User -> Tenant relation. Never a hardcoded tenant id.
 *   2. Verify the tenant is APPROVED + active, is not administratively
 *      suspended on the 'whatsapp' feature, and has WhatsApp access under the
 *      CURRENT AccessControlService precedence (platform free mode -> admin
 *      free-access override -> active/usable subscription whose plan
 *      includes 'whatsapp' -> super-admin feature override). See
 *      `resolveWhatsappAccess` below — it mirrors
 *      `AccessControlService.resolveBase` / `.decide()`
 *      (src/modules/subscription-billing/access-control.service.ts), the
 *      single documented source of truth for that precedence. Kept as a
 *      read-only reimplementation rather than booting the full Nest app
 *      context, consistent with this script's existing "independent of the
 *      NestJS DI container" convention (see SeedDataSource).
 *   3. Validate the temporary access token against Meta BEFORE touching the
 *      database: debug_token (valid, unexpired, issued for OUR app, carries
 *      whatsapp_business_management + whatsapp_business_messaging), the WABA
 *      is readable with this token, and the phone number is actually
 *      registered on that WABA.
 *   4. Only then write: update the existing row for this tenant+number if one
 *      exists; else, if the number is currently claimed by ANOTHER tenant
 *      (e.g. the previous demo clinic), print that account's status, confirm
 *      it is this same test WABA/number, and SOFT-DISCONNECT it (frees the
 *      partial-unique phone_number_id index, preserves all its history —
 *      never a hard delete) before creating a fresh row for the new tenant;
 *      else create a new row outright.
 *
 * Never run against production. Refuses if NODE_ENV=production.
 *
 * The access token is read from env at call time only — never logged, never
 * written to disk in plaintext outside the encrypted DB column, never
 * hardcoded here. Meta error messages are surfaced as-is (MetaGraphClient
 * already strips query strings and never includes the token in its errors).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/bootstrap-meta-app-review-account.ts
 *
 * Required env:
 *   META_APP_REVIEW_CLINIC_EMAIL     e.g. owner@inovra.com
 *   META_APP_REVIEW_WABA_ID          Meta's test WABA id
 *   META_APP_REVIEW_PHONE_NUMBER_ID  Meta's test phone number id
 *   META_APP_REVIEW_ACCESS_TOKEN     the fresh temporary token from
 *                                    Meta Developers -> WhatsApp -> Basic setup -> Try it out
 *   Also reads the platform's existing META_APP_ID / META_APP_SECRET /
 *   META_GRAPH_API_VERSION (MetaConfig) and CREDENTIALS_ENCRYPTION_KEY.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { EntityManager, IsNull } from 'typeorm';

import { SeedDataSource } from '../src/seed/data-source';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { User } from '../src/entities/Auth&RBAC/User';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { TenantApprovalStatus, SubscriptionStatus } from '../src/entities/enums';
import { FeatureFlag, AUTHORITATIVE_FLAG_SOURCES } from '../src/entities/SaaS-Core/FeatureFlag';
import { FeatureDefinition } from '../src/entities/SaaS-Core/FeatureDefinition';
import { FeaturePlan } from '../src/entities/SaaS-Core/FeaturePlan';
import { Subscription } from '../src/entities/SaaS-Core/Subscription';
import { SystemSetting } from '../src/entities/System&Lookup/SystemSetting';
import { WhatsappAccount } from '../src/entities/WhatsApp/WhatsappAccount';
import { MetaConfig } from '../src/modules/whatsapp/meta/meta.config';
import { MetaGraphClient } from '../src/modules/whatsapp/meta/meta-graph.client';
import {
  WHATSAPP_ACCOUNT_MODE,
  WHATSAPP_CONNECTION_STATUS,
  WHATSAPP_PROVIDER,
} from '../src/modules/whatsapp/whatsapp.constants';

/** Same requirement MetaEmbeddedSignupService enforces on real onboarding. */
const REQUIRED_SCOPES = ['whatsapp_business_management', 'whatsapp_business_messaging'];

const WHATSAPP_FEATURE_KEY = 'whatsapp';
const BILLING_MODE_SETTING_KEY = 'billing.mode';
const DEFAULT_SUBSCRIPTION_GRACE_DAYS = 14;

interface WhatsappAccessResult {
  allowed: boolean;
  source: 'PLATFORM_FREE_MODE' | 'ADMIN_FREE_ACCESS' | 'ACTIVE_SUBSCRIPTION' | 'FEATURE_OVERRIDE' | 'DENIED';
  reason?: string;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run bootstrap-meta-app-review-account against production.');
  }

  const email = requireEnv('META_APP_REVIEW_CLINIC_EMAIL');
  const wabaId = requireEnv('META_APP_REVIEW_WABA_ID');
  const phoneNumberId = requireEnv('META_APP_REVIEW_PHONE_NUMBER_ID');
  const accessToken = requireEnv('META_APP_REVIEW_ACCESS_TOKEN');

  const configService = new ConfigService(process.env as Record<string, unknown>);

  const encryption = new EncryptionService(configService);
  encryption.onModuleInit();
  if (!encryption.configured) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is not configured — aborting.');
  }

  const metaConfig = new MetaConfig(configService);
  const graph = new MetaGraphClient(metaConfig);

  await SeedDataSource.initialize();
  try {
    // ── Phase 1: resolve + verify the tenant (read-only) ───────────────────
    const user = await SeedDataSource.manager.findOne(User, {
      where: { email },
      relations: { tenant: true },
    });
    if (!user?.tenant) {
      throw new Error(`No user with a tenant found for email ${email}.`);
    }
    const tenant = user.tenant;

    if (tenant.approval_status !== TenantApprovalStatus.APPROVED || !tenant.is_active) {
      throw new Error(
        `Tenant ${tenant.id} (${email}) is not an active, approved clinic ` +
          `(approval_status=${tenant.approval_status}, is_active=${tenant.is_active}) — refusing to attach credentials.`,
      );
    }

    const access = await resolveWhatsappAccess(SeedDataSource.manager, tenant.id);
    if (!access.allowed) {
      throw new Error(
        `Tenant ${tenant.id} (${email}) does not have WhatsApp access under the current ` +
          `access-control architecture (${access.reason}) — refusing to attach credentials.`,
      );
    }

    console.log(
      `Tenant resolved: ${tenant.id} (${tenant.name}, ${email}) — APPROVED, active, ` +
        `WhatsApp access granted via ${access.source}.`,
    );

    // ── Phase 2: validate the token/WABA/number against Meta BEFORE any write ─
    const debug = await graph.debugToken(accessToken);
    if (!debug.isValid) {
      throw new Error('Meta reports this access token as invalid.');
    }
    if (debug.appId !== metaConfig.requireAppId()) {
      throw new Error(
        'This access token was not issued for this platform\'s Meta App (possible token from a different app) — refusing to use it.',
      );
    }
    if (debug.expiresAt && debug.expiresAt > 0 && debug.expiresAt * 1000 <= Date.now()) {
      throw new Error('This Meta access token has already expired — request a fresh one from Meta Developers.');
    }
    const missingScopes = REQUIRED_SCOPES.filter((s) => !debug.scopes.includes(s));
    if (missingScopes.length > 0) {
      throw new Error(
        `This access token is missing required permissions: ${missingScopes.join(', ')}.`,
      );
    }

    const waba = await graph.getWaba(wabaId, accessToken);
    const phoneNumbers = await graph.listPhoneNumbers(wabaId, accessToken);
    const phone = phoneNumbers.find((p) => p.id === phoneNumberId);
    if (!phone) {
      throw new Error(
        `Phone number ${phoneNumberId} is not registered on WABA ${wabaId} ` +
          `(Meta returned ${phoneNumbers.length} number(s) on this WABA) — refusing to attach it.`,
      );
    }

    console.log(
      `Meta validation OK — token valid & unexpired, issued for this app, required scopes present, ` +
        `WABA ${waba.id} readable, phone ${phone.id} (${phone.displayPhoneNumber ?? 'n/a'}) confirmed on that WABA.`,
    );

    // ── Phase 3: locate existing rows (read-only) ──────────────────────────
    const rowForTenant = await SeedDataSource.manager.findOne(WhatsappAccount, {
      where: { tenant: { id: tenant.id }, phone_number_id: phoneNumberId, deleted_at: IsNull() },
    });
    const rowClaimedByOther = rowForTenant
      ? null
      : await SeedDataSource.manager.findOne(WhatsappAccount, {
          where: { phone_number_id: phoneNumberId, deleted_at: IsNull() },
          relations: { tenant: true },
        });

    if (rowClaimedByOther) {
      console.log(
        `Phone number ${phoneNumberId} is currently linked to a different tenant — status before transfer:\n` +
          `  tenant_id=${rowClaimedByOther.tenant?.id} contact_email=${rowClaimedByOther.tenant?.contact_email ?? 'n/a'}\n` +
          `  connection_status=${rowClaimedByOther.connection_status} is_active=${rowClaimedByOther.is_active} ` +
          `is_default=${rowClaimedByOther.is_default}\n` +
          `  waba_id=${rowClaimedByOther.waba_id} phone_number_id=${rowClaimedByOther.phone_number_id} ` +
          `updated_at=${rowClaimedByOther.updated_at?.toISOString()}`,
      );
      if (rowClaimedByOther.waba_id !== wabaId) {
        throw new Error(
          `The account currently holding phone_number_id=${phoneNumberId} has waba_id=${rowClaimedByOther.waba_id}, ` +
            `not the expected test WABA ${wabaId} — this does not look like the App Review test asset. Refusing to transfer.`,
        );
      }
      console.log(
        'This matches the expected App Review test WABA/number — treating it as the same test asset ' +
          'and safely transferring the link (soft-disconnect the old row, preserving its history; no data deleted).',
      );
    }

    const statusBeforeLabel = rowForTenant ? rowForTenant.connection_status : '(none)';

    // ── Phase 4: write transaction ──────────────────────────────────────────
    const saved = await SeedDataSource.transaction(async (manager) => {
      if (rowClaimedByOther) {
        rowClaimedByOther.connection_status = WHATSAPP_CONNECTION_STATUS.DISCONNECTED;
        rowClaimedByOther.is_default = false;
        await manager.save(WhatsappAccount, rowClaimedByOther);
        await manager.softRemove(WhatsappAccount, rowClaimedByOther);
      }

      const account =
        rowForTenant ?? manager.create(WhatsappAccount, { tenant: { id: tenant.id } as Tenant });

      account.provider = WHATSAPP_PROVIDER.META_CLOUD;
      account.mode = WHATSAPP_ACCOUNT_MODE.CUSTOM;
      account.meta_business_id = waba.ownerBusinessId ?? account.meta_business_id;
      account.waba_id = waba.id;
      account.phone_number_id = phone.id;
      account.display_phone_number = phone.displayPhoneNumber;
      account.verified_name = phone.verifiedName;
      account.access_token = encryption.encrypt(accessToken);
      account.token_expires_at = resolveExpiry(debug.expiresAt);
      account.connection_status = WHATSAPP_CONNECTION_STATUS.CONNECTED;
      account.connected_at = new Date();
      account.is_active = true;

      const savedAccount = await manager.save(WhatsappAccount, account);
      await ensureTenantHasDefault(manager, tenant.id, savedAccount);
      return savedAccount;
    });

    console.log(
      `OK: WhatsappAccount ${saved.id} for tenant ${tenant.id} (${email}) — ` +
        `${rowForTenant ? 'UPDATED existing row' : 'CREATED new row'}. ` +
        `waba=${saved.waba_id}, phone_number_id=${saved.phone_number_id}, ` +
        `status: ${statusBeforeLabel} -> ${saved.connection_status}. ` +
        `Token stored encrypted (${encryption.isEncrypted(saved.access_token) ? 'enc:v1' : 'UNVERIFIED'}), not printed. ` +
        `expires ${saved.token_expires_at?.toISOString() ?? 'never (long-lived token)'}.`,
    );
  } finally {
    await SeedDataSource.destroy();
  }
}

// ──────────────────────────── Access control (read-only mirror) ────────────

/**
 * Mirrors `AccessControlService.resolveBase` + `.decide()`'s documented
 * precedence for ONE feature key ('whatsapp'):
 *   suspension (outranks everything) -> platform free mode -> tenant-wide
 *   admin free-access override -> usable subscription whose plan includes
 *   'whatsapp' and which is switched on -> super-admin feature override -> denied.
 * See src/modules/subscription-billing/access-control.service.ts for the
 * authoritative implementation this must stay consistent with.
 */
async function resolveWhatsappAccess(
  manager: EntityManager,
  tenantId: string,
): Promise<WhatsappAccessResult> {
  const flag = await manager.findOne(FeatureFlag, {
    where: { tenant: { id: tenantId }, feature_key: WHATSAPP_FEATURE_KEY },
  });

  if (flag?.is_suspended) {
    return {
      allowed: false,
      source: 'DENIED',
      reason: flag.suspended_reason ?? 'WhatsApp is administratively suspended for this tenant',
    };
  }

  const modeRow = await manager.findOne(SystemSetting, { where: { key: BILLING_MODE_SETTING_KEY } });
  const isPaidMode = (modeRow?.value as { mode?: string } | undefined)?.mode === 'paid';
  if (!isPaidMode) {
    return { allowed: true, source: 'PLATFORM_FREE_MODE' };
  }

  const overrideRows: unknown[] = await manager.query(
    `SELECT 1 FROM free_access_overrides
     WHERE tenant_id = $1 AND status = 'ACTIVE' AND starts_at <= now()
       AND (ends_at IS NULL OR ends_at > now()) LIMIT 1`,
    [tenantId],
  );
  if (overrideRows.length > 0) {
    return { allowed: true, source: 'ADMIN_FREE_ACCESS' };
  }

  const subscription = await manager.findOne(Subscription, {
    where: { tenant: { id: tenantId }, deleted_at: IsNull() },
    relations: { plan: true },
    order: { created_at: 'DESC' },
  });
  if (subscription) {
    const status = effectiveSubscriptionStatus(subscription, manager);
    const usable = status !== SubscriptionStatus.CANCELLED && status !== SubscriptionStatus.SUSPENDED;
    if (usable) {
      const planRows = await manager.find(FeaturePlan, { where: { feature_key: WHATSAPP_FEATURE_KEY } });
      const planIncludes =
        planRows.length === 0 || planRows.some((p) => p.plan_id === subscription.plan?.id);
      const isOn =
        (flag?.is_enabled && AUTHORITATIVE_FLAG_SOURCES.includes(flag.source)) ||
        (await defaultEnabled(manager));
      if (planIncludes && isOn) {
        return { allowed: true, source: 'ACTIVE_SUBSCRIPTION' };
      }
    }
  }

  if (
    flag?.is_enabled &&
    AUTHORITATIVE_FLAG_SOURCES.includes(flag.source) &&
    !flag.is_suspended
  ) {
    return { allowed: true, source: 'FEATURE_OVERRIDE' };
  }

  return {
    allowed: false,
    source: 'DENIED',
    reason: subscription
      ? `subscription status is ${effectiveSubscriptionStatus(subscription, manager)} and no override grants WhatsApp`
      : 'no active subscription, free-access override, or free platform mode grants WhatsApp',
  };
}

async function defaultEnabled(manager: EntityManager): Promise<boolean> {
  const def = await manager.findOne(FeatureDefinition, { where: { feature_key: WHATSAPP_FEATURE_KEY } });
  return def?.default_enabled ?? false;
}

/** Mirrors AccessControlService.effective()'s PAST_DUE/GRACE_EXPIRED derivation. */
function effectiveSubscriptionStatus(subscription: Subscription, _manager: EntityManager): SubscriptionStatus {
  const now = new Date();
  if (
    subscription.status === SubscriptionStatus.CANCELLED ||
    subscription.status === SubscriptionStatus.SUSPENDED ||
    subscription.status === SubscriptionStatus.GRACE_EXPIRED
  ) {
    return subscription.status;
  }
  if (subscription.status === SubscriptionStatus.PAST_DUE) {
    if (subscription.grace_started_at) {
      const graceDays = Number(process.env.SUBSCRIPTION_GRACE_DAYS ?? DEFAULT_SUBSCRIPTION_GRACE_DAYS);
      const graceEndsAt = new Date(
        subscription.grace_started_at.getTime() + graceDays * 86_400_000,
      );
      if (graceEndsAt < now) return SubscriptionStatus.GRACE_EXPIRED;
    }
    return SubscriptionStatus.PAST_DUE;
  }
  if (subscription.ends_at < now) return SubscriptionStatus.PAST_DUE;
  return subscription.status;
}

// ──────────────────────────── WhatsApp account helpers ─────────────────────

/** Same default-selection logic as MetaEmbeddedSignupService.ensureTenantHasDefault. */
async function ensureTenantHasDefault(
  manager: EntityManager,
  tenantId: string,
  account: WhatsappAccount,
): Promise<void> {
  if (account.is_default) return;
  const hasDefault = await manager.exists(WhatsappAccount, {
    where: { tenant: { id: tenantId }, is_default: true, deleted_at: IsNull() },
  });
  if (hasDefault) return;
  account.is_default = true;
  await manager.save(WhatsappAccount, account);
}

/**
 * Meta's "Try it out" temporary token is short-lived (~24h) and debug_token
 * sometimes returns no expiry for it; prefer the introspected value
 * (authoritative) and fall back to a conservative 23h assumption for this
 * known token type rather than treating it as never-expiring.
 */
function resolveExpiry(expiresAtUnix?: number): Date {
  if (expiresAtUnix && expiresAtUnix > 0) return new Date(expiresAtUnix * 1000);
  return new Date(Date.now() + 23 * 60 * 60 * 1000);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
