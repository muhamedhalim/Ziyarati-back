import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T130).
 *
 * NUMBERING NOTE: tasks.md names this migration `1730070000000-...`, but that
 * exact timestamp is already taken on disk by
 * `1730070000000-InAppNotifications.ts` (a real, prior-committed migration —
 * this is a known, expected stale-timestamp collision in tasks.md, per the
 * precedent already documented in `1730071000000-CustomerSegments.ts` and
 * `1730077000000-ClinicalPermissionsAndRoles.ts`). The highest COMMITTED
 * migration timestamp on disk was `1730077000000` (`ClinicalPermissionsAndRoles`),
 * so this migration was first written as `1730078000000`; a second, UNCOMMITTED,
 * concurrently-in-progress migration (`1730078000000-WaitlistEntriesAndOffers.ts`,
 * a different feature phase's work-in-progress) was found already sitting on
 * that exact same timestamp, so this migration was renumbered again, to
 * `1730079000000`, to avoid the collision. Check `ls src/migrations/` for the
 * true highest timestamp — including untracked files — before adding the next one.
 *
 * Creates:
 *  - `email_suppressions` — a PER-TENANT marketing-suppression list
 *    (data-model.md §1.7). `UNIQUE (tenant_id, email)` — email is always
 *    lowercased by `EmailSuppressionService` before every write, so this
 *    constraint is effectively case-insensitive. Per-tenant, never global:
 *    a clinic's bad list (or one patient's unsubscribe from one clinic) must
 *    never suppress a DIFFERENT clinic's marketing to the same address.
 *  - `campaigns.channel` — varchar(16) NOT NULL DEFAULT 'WHATSAPP', so every
 *    existing campaign reads back unchanged (this migration's own
 *    `migration:verify` assertion).
 *  - `campaigns.email_subject` / `campaigns.email_body` — nullable,
 *    clinic-authored marketing content for an EMAIL-channel campaign (T131/
 *    T132). Additive-only; no existing column is touched.
 *  - `campaign_recipients.email` — nullable varchar, the resolved address a
 *    dispatch actually sent to (T138 analytics + T136 webhook resolution).
 */
export class EmailSuppressionAndCampaignChannel1730079000000 implements MigrationInterface {
  name = 'EmailSuppressionAndCampaignChannel1730079000000';

  public async up(q: QueryRunner): Promise<void> {
    // IF NOT EXISTS guards throughout — mirrors CustomerNationalId1730053000000:
    // a dev environment running with TYPEORM_SYNCHRONIZE=true can have already
    // created every one of these objects from the entity definitions before
    // this migration ever runs.
    await q.query(`
      CREATE TABLE IF NOT EXISTS "email_suppressions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "email" varchar(255) NOT NULL,
        "reason" varchar(32) NOT NULL,
        "source" varchar(32),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_suppressions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_email_suppressions_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_suppressions_tenant_email"
      ON "email_suppressions" ("tenant_id", "email")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_suppressions_tenant"
      ON "email_suppressions" ("tenant_id")
    `);

    await q.query(
      `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "channel" varchar(16) NOT NULL DEFAULT 'WHATSAPP'`,
    );
    await q.query(
      `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "email_subject" varchar(200)`,
    );
    await q.query(
      `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "email_body" text`,
    );

    await q.query(
      `ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "email" varchar(255)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "campaign_recipients" DROP COLUMN IF EXISTS "email"`,
    );
    await q.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "email_body"`);
    await q.query(
      `ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "email_subject"`,
    );
    await q.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "channel"`);
    await q.query(`DROP TABLE IF EXISTS "email_suppressions"`);
  }
}
