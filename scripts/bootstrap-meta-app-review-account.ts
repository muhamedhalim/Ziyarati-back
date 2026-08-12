/**
 * ONE-OFF, App-Review-only bootstrap for the WhatsApp credential
 * `WhatsappAccountService` deliberately refuses to accept over the API (see
 * its class doc: "access_token / waba_id / phone_number_id are set
 * exclusively by MetaEmbeddedSignupService, which proves ownership with Meta
 * first"). Embedded Signup itself needs Meta's FB.login popup, which refuses
 * to run on a non-HTTPS page — this local dev frontend is http://localhost,
 * so Embedded Signup cannot complete here. This script exists ONLY to attach
 * Meta's own App-Review test WABA/number (owned by our Meta App, not a third
 * party) to the demo clinic tenant, mirroring exactly what
 * MetaEmbeddedSignupService.persist() writes — same fields, same encryption.
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
 *   META_APP_REVIEW_ACCESS_TOKEN     the temporary token from
 *                                    Meta Developers -> WhatsApp -> Basic setup -> Try it out
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { IsNull } from 'typeorm';

import { SeedDataSource } from '../src/seed/data-source';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { User } from '../src/entities/Auth&RBAC/User';
import { FeatureFlag } from '../src/entities/SaaS-Core/FeatureFlag';
import { WhatsappAccount } from '../src/entities/WhatsApp/WhatsappAccount';
import {
  WHATSAPP_ACCOUNT_MODE,
  WHATSAPP_CONNECTION_STATUS,
  WHATSAPP_PROVIDER,
} from '../src/modules/whatsapp/whatsapp.constants';

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

      const claimedByOther = await manager.findOne(WhatsappAccount, {
        where: { phone_number_id: phoneNumberId },
        relations: { tenant: true },
      });
      if (claimedByOther && claimedByOther.tenant?.id !== tenant.id) {
        throw new Error(
          `phone_number_id ${phoneNumberId} is already connected to a different tenant — refusing to reassign it.`,
        );
      }

      const account =
        claimedByOther ??
        (await manager.findOne(WhatsappAccount, {
          where: { tenant: { id: tenant.id }, phone_number_id: IsNull() },
        })) ??
        manager.create(WhatsappAccount, { tenant });

      account.provider = WHATSAPP_PROVIDER.META_CLOUD;
      account.mode = WHATSAPP_ACCOUNT_MODE.CUSTOM;
      account.waba_id = wabaId;
      account.phone_number_id = phoneNumberId;
      account.access_token = encryption.encrypt(accessToken);
      // Meta's "Try it out" temporary token is short-lived (~24h); refresh by
      // re-running this script with a fresh token copied the same way.
      account.token_expires_at = new Date(Date.now() + 23 * 60 * 60 * 1000);
      account.connection_status = WHATSAPP_CONNECTION_STATUS.CONNECTED;
      account.connected_at = new Date();
      account.is_active = true;
      account.branch = null;

      const saved = await manager.save(WhatsappAccount, account);

      const hasDefault = await manager.exists(WhatsappAccount, {
        where: { tenant: { id: tenant.id }, is_default: true },
      });
      if (!hasDefault) {
        saved.is_default = true;
        await manager.save(WhatsappAccount, saved);
      }

      console.log(
        `OK: WhatsappAccount ${saved.id} for tenant ${tenant.id} (${email}) ` +
          `now CONNECTED — waba=${wabaId}, phone_number_id=${phoneNumberId}. Token stored encrypted, not printed.`,
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
