import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Merchant accounts — Tap onboarding (Tap migration, Phase 4 / plan §17 M1,
 * the `merchant_accounts` half that Phase 2 deliberately left out).
 *
 * ADDS four nullable columns to `merchant_accounts` (additive; nothing renamed,
 * nothing deleted, no Moyasar recipient id rewritten):
 *
 *   provider_lead_id               varchar(64)  — Tap `led_…` created for the clinic
 *   provider_capabilities          jsonb        — what Tap told us (claim from the
 *                                                  onboarding callback); NEVER raw
 *                                                  payloads, NEVER a credential
 *   provider_callback_token_hash   varchar(64)  — sha256 of the secret in the URL Tap
 *                                                  posts onboarding events to
 *   provider_onboarding_claimed_at timestamptz  — atomic claim so two concurrent
 *                                                  "connect" clicks create ONE lead
 *
 * WHY a token hash: Tap documents no signature for onboarding (Connect) events,
 * so the callback URL is the only thing that can authenticate them. Only the
 * SHA-256 is stored, so a database leak does not yield a usable callback URL.
 * The partial UNIQUE index makes the lookup by token one indexed probe.
 *
 * The `provider` column default is deliberately NOT changed (plan §17 listed
 * `moyasar` → `tap`): `MerchantAccountService.getOrCreate` always sets the
 * provider explicitly from `PAYMENT_PROVIDER`, so the default is never used by
 * application code, and rewriting a default buys nothing but risk.
 *
 * Every object below is ALSO declared on the `MerchantAccount` entity (same
 * names), so a schema built from metadata carries it and `synchronize` does not
 * drop it.
 *
 * REVERSIBLE.
 */
export class MerchantAccountTapOnboarding1730109000000 implements MigrationInterface {
  name = 'MerchantAccountTapOnboarding1730109000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "merchant_accounts"
         ADD COLUMN IF NOT EXISTS "provider_lead_id" varchar(64),
         ADD COLUMN IF NOT EXISTS "provider_capabilities" jsonb,
         ADD COLUMN IF NOT EXISTS "provider_callback_token_hash" varchar(64),
         ADD COLUMN IF NOT EXISTS "provider_onboarding_claimed_at" timestamptz`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_merchant_accounts_callback_token_hash"
         ON "merchant_accounts" ("provider_callback_token_hash")
         WHERE "provider_callback_token_hash" IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "UQ_merchant_accounts_callback_token_hash"`,
    );
    await q.query(
      `ALTER TABLE "merchant_accounts"
         DROP COLUMN IF EXISTS "provider_onboarding_claimed_at",
         DROP COLUMN IF EXISTS "provider_callback_token_hash",
         DROP COLUMN IF EXISTS "provider_capabilities",
         DROP COLUMN IF EXISTS "provider_lead_id"`,
    );
  }
}
