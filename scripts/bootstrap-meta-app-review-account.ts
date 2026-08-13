/**
 * ONE-OFF, App-Review-only credential REFRESH for the WhatsApp account
 * `WhatsappAccountService` deliberately refuses to accept over the API (see
 * its class doc: "access_token / waba_id / phone_number_id are set
 * exclusively by MetaEmbeddedSignupService, which proves ownership with Meta
 * first"). Embedded Signup itself needs Meta's FB.login popup, which refuses
 * to run on a non-HTTPS page — this local dev frontend is http://localhost,
 * so Embedded Signup cannot complete here. This script exists ONLY to rotate
 * the short-lived "Try it out" token on the demo clinic's existing App-Review
 * WhatsappAccount row, encrypting it exactly the way
 * MetaEmbeddedSignupService.persist() does — same field, same encryption.
 *
 * REFRESH-ONLY, not create-or-update: it requires a WhatsappAccount that
 * already exists for the resolved tenant with the given waba_id AND
 * phone_number_id, and updates only that row's access_token + expiry. If no
 * such row exists it stops and reports the problem — it never creates a new
 * account, so accidentally rerunning it (e.g. with a newer token) can only
 * ever update the same row, never produce a duplicate.
 *
 * Never run against production. Refuses if NODE_ENV=production.
 *
 * The access token is read from env at call time only — never logged, never
 * written to disk in plaintext, never hardcoded here.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/bootstrap-meta-app-review-account.ts
 *
 * Required env:
 *   META_APP_REVIEW_CLINIC_EMAIL     e.g. text1@gmail.com
 *   META_APP_REVIEW_WABA_ID          Meta's test WABA id
 *   META_APP_REVIEW_PHONE_NUMBER_ID  Meta's test phone number id
 *   META_APP_REVIEW_ACCESS_TOKEN     the fresh temporary token from
 *                                    Meta Developers -> WhatsApp -> Basic setup -> Try it out
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';

import { SeedDataSource } from '../src/seed/data-source';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { User } from '../src/entities/Auth&RBAC/User';
import { FeatureFlag } from '../src/entities/SaaS-Core/FeatureFlag';
import { WhatsappAccount } from '../src/entities/WhatsApp/WhatsappAccount';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run bootstrap-meta-app-review-account against production.');
  }

  const email = requireEnv('META_APP_REVIEW_CLINIC_EMAIL');
  const wabaId = requireEnv('META_APP_REVIEW_WABA_ID');
  const phoneNumberId = requireEnv('META_APP_REVIEW_PHONE_NUMBER_ID');
  const accessToken = requireEnv('META_APP_REVIEW_ACCESS_TOKEN');

  const encryption = new EncryptionService(
    new ConfigService(process.env as Record<string, unknown>),
  );
  encryption.onModuleInit();
  if (!encryption.configured) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is not configured — aborting.');
  }

  await SeedDataSource.initialize();
  try {
    await SeedDataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { email },
        relations: { tenant: true },
      });
      if (!user?.tenant) {
        throw new Error(`No user with tenant found for email ${email}`);
      }
      const tenant = user.tenant;

      if (tenant.approval_status !== 'APPROVED' || !tenant.is_active) {
        throw new Error(
          `Tenant ${tenant.id} is not an active, approved clinic ` +
            `(approval_status=${tenant.approval_status}, is_active=${tenant.is_active}) — refusing to attach credentials.`,
        );
      }

      const flag = await manager.findOne(FeatureFlag, {
        where: { tenant: { id: tenant.id }, feature_key: 'whatsapp' },
      });
      if (!flag?.is_enabled) {
        throw new Error(
          `Tenant ${tenant.id} does not have the 'whatsapp' feature flag enabled — refusing to attach credentials.`,
        );
      }

      // REFRESH-ONLY: the row must already exist for this tenant with this
      // exact waba_id + phone_number_id. Never create — a missing row means
      // the App Review asset was never bootstrapped (or was bootstrapped
      // under a different tenant/number), which is a setup problem this
      // script must surface, not paper over with a new row.
      const existing = await manager.findOne(WhatsappAccount, {
        where: { tenant: { id: tenant.id }, phone_number_id: phoneNumberId },
        relations: { tenant: true },
      });

      if (!existing) {
        const claimedByOther = await manager.findOne(WhatsappAccount, {
          where: { phone_number_id: phoneNumberId },
          relations: { tenant: true },
        });
        if (claimedByOther) {
          throw new Error(
            `phone_number_id ${phoneNumberId} belongs to a different tenant ` +
              `(${claimedByOther.tenant?.id}), not ${tenant.id} (${email}) — refusing to touch it.`,
          );
        }
        throw new Error(
          `No existing WhatsappAccount found for tenant ${tenant.id} (${email}) with ` +
            `waba_id=${wabaId} phone_number_id=${phoneNumberId}. This script only refreshes ` +
            `an already-connected App Review asset — it will not create a new account. ` +
            `Bootstrap it first (Embedded Signup, or the original create flow) before refreshing.`,
        );
      }
      if (existing.waba_id !== wabaId) {
        throw new Error(
          `WhatsappAccount ${existing.id} for tenant ${tenant.id} has waba_id=${existing.waba_id}, ` +
            `not the expected ${wabaId} — refusing to refresh a mismatched account.`,
        );
      }

      // Touch only what a token refresh needs to change. Everything else on
      // the row (provider, mode, waba_id, phone_number_id, connection_status,
      // connected_at, is_active, is_default, branch) is left exactly as-is —
      // `updated_at` still advances via TypeORM's @UpdateDateColumn.
      existing.access_token = encryption.encrypt(accessToken);
      // Meta's "Try it out" temporary token is short-lived (~24h); refresh by
      // re-running this script with a fresh token copied the same way.
      existing.token_expires_at = new Date(Date.now() + 23 * 60 * 60 * 1000);

      const saved = await manager.save(WhatsappAccount, existing);

      console.log(
        `OK: WhatsappAccount ${saved.id} for tenant ${tenant.id} (${email}) ` +
          `token refreshed — waba=${wabaId}, phone_number_id=${phoneNumberId}, ` +
          `expires ${saved.token_expires_at?.toISOString()}. Token stored encrypted, not printed.`,
      );
    });
  } finally {
    await SeedDataSource.destroy();
  }
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
