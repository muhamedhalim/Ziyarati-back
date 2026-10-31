import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P0.5 (TSF-03): TOTP multi-factor authentication storage. Additive only:
 * two new tables, no existing column touched. Idempotent.
 */
export class UserMfa1730140000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "user_mfa" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "secret_enc" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "enrolled_at" TIMESTAMP WITH TIME ZONE,
        "last_used_step" bigint,
        "failed_attempts" integer NOT NULL DEFAULT 0,
        "locked_until" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_mfa" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_mfa_user" UNIQUE ("user_id"),
        CONSTRAINT "FK_user_mfa_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "user_mfa_recovery_codes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "code_hash" text NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_mfa_recovery_codes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_mfa_recovery_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_mfa_recovery_user" ON "user_mfa_recovery_codes" ("user_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "user_mfa_recovery_codes"`);
    await q.query(`DROP TABLE IF EXISTS "user_mfa"`);
  }
}
