import { MigrationInterface, QueryRunner } from 'typeorm';
import { createCipheriv, randomBytes } from 'node:crypto';

/**
 * Hardens WhatsApp provider credentials for the multi-tenant Tech Provider model.
 *
 * Two independent fixes, both security-critical:
 *
 * 1. UNIQUE(phone_number_id) among live accounts.
 *    Inbound webhooks resolve the owning tenant solely from
 *    `metadata.phone_number_id`. Without uniqueness, one tenant could register
 *    another's number and receive their patients' messages. PARTIAL (`WHERE
 *    deleted_at IS NULL AND phone_number_id IS NOT NULL`) so soft-deleted rows
 *    don't block reconnecting a number, and unconfigured accounts (NULL) don't
 *    collide with each other.
 *
 * 2. Encrypt `access_token` at rest.
 *    Tokens were stored as plaintext `text`. This backfills existing rows into
 *    the AES-256-GCM envelope that EncryptionService reads
 *    (`enc:v1:<iv>:<tag>:<ct>`), using CREDENTIALS_ENCRYPTION_KEY.
 *
 *    The envelope prefix makes the rollout order-independent: EncryptionService
 *    passes unprefixed values through as legacy plaintext, so old code + new
 *    rows and new code + old rows both work. Encryption here is intentionally
 *    duplicated from EncryptionService rather than imported — a migration must
 *    stay pinned to the format it was written against, even if the service
 *    later moves to v2.
 *
 * The backfill is skipped (with a loud warning) when no key is configured, so a
 * key-less environment can still migrate schema. `down()` cannot restore
 * plaintext — it only drops the index; that is deliberate, since reverting to
 * plaintext credentials is not a state worth being able to roll back into.
 */
export class WhatsappCredentialSecurity1730003300000 implements MigrationInterface {
  name = 'WhatsappCredentialSecurity1730003300000';

  public async up(q: QueryRunner): Promise<void> {
    // ── 1. Trusted phone_number_id → tenant mapping ────────────────────────
    // Fail LOUDLY on pre-existing duplicates rather than silently picking a
    // winner: if two tenants already claim one number, that is a live incident
    // needing a human decision about who legitimately owns it.
    const duplicates = await q.query(`
      SELECT phone_number_id, COUNT(*)::int AS count
      FROM whatsapp_accounts
      WHERE deleted_at IS NULL AND phone_number_id IS NOT NULL
      GROUP BY phone_number_id
      HAVING COUNT(*) > 1
    `);
    if (duplicates.length > 0) {
      const list = duplicates
        .map((d: { phone_number_id: string; count: number }) => `${d.phone_number_id} (${d.count})`)
        .join(', ');
      throw new Error(
        `Cannot enforce UNIQUE(phone_number_id): these numbers are claimed by more than one live ` +
          `whatsapp_accounts row: ${list}. Resolve ownership (soft-delete the wrong rows) and re-run.`,
      );
    }

    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_whatsapp_account_phone_number_id_live"
      ON "whatsapp_accounts" ("phone_number_id")
      WHERE "deleted_at" IS NULL AND "phone_number_id" IS NOT NULL
    `);

    // ── 2. Encrypt existing plaintext access tokens ────────────────────────
    const key = loadKey();
    if (!key) {
      console.warn(
        '[WhatsappCredentialSecurity] CREDENTIALS_ENCRYPTION_KEY is not set — ' +
          'skipping access_token backfill. Existing tokens REMAIN PLAINTEXT. ' +
          'Set the key and re-run this migration to encrypt them.',
      );
      return;
    }

    const rows: { id: string; access_token: string }[] = await q.query(`
      SELECT "id", "access_token"
      FROM "whatsapp_accounts"
      WHERE "access_token" IS NOT NULL
        AND "access_token" <> ''
        AND "access_token" NOT LIKE 'enc:v1:%'
    `);

    for (const row of rows) {
      // Parameterized — never interpolate a credential into SQL text.
      await q.query(`UPDATE "whatsapp_accounts" SET "access_token" = $1 WHERE "id" = $2`, [
        encryptV1(row.access_token, key),
        row.id,
      ]);
    }

    if (rows.length > 0) {
      console.log(
        `[WhatsappCredentialSecurity] Encrypted ${rows.length} WhatsApp access token(s) at rest.`,
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    // Only the index is reversible. Decrypting tokens back to plaintext is NOT
    // performed: the encrypted values stay readable by EncryptionService, and
    // re-exposing credentials would be a security regression, not a rollback.
    await q.query(`DROP INDEX IF EXISTS "UQ_whatsapp_account_phone_number_id_live"`);
  }
}

// ─── Format-pinned copy of the EncryptionService v1 envelope ────────────────

const ENVELOPE_V1 = 'enc:v1:';

function loadKey(): Buffer | null {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (decoded.length !== 32) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${decoded.length}).`,
    );
  }
  return decoded;
}

function encryptV1(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    ENVELOPE_V1 + iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}
