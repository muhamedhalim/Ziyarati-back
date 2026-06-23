import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Campaign execution redesign.
 *
 *  - campaigns: single `status` → business `lifecycle`.
 *  - new `campaign_runs` execution aggregate (state + materialized counters).
 *  - campaign_recipients: single `status` → `processing` (worker) + `delivery`
 *    (webhook), plus UNIQUE `provider_ref`, attempts, failure classification.
 *  - new `outbox_jobs` (transactional outbox).
 *
 * Backward compatible: existing campaigns/recipients are mapped onto the new
 * model and a synthetic COMPLETED run is created per campaign that has history.
 * Idempotent where practical; `down()` reverses the structural changes.
 */
export class CampaignExecutionRedesign1730000700000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ── Enum types ──────────────────────────────────────────────────────────
    await q.query(`CREATE TYPE "public"."campaigns_lifecycle_enum" AS ENUM('DRAFT','SCHEDULED','ACTIVE','PAUSED','ARCHIVED')`);
    await q.query(`CREATE TYPE "public"."campaign_runs_execution_enum" AS ENUM('IDLE','ENQUEUEING','PROCESSING','DRAINING','COMPLETED','FAILED')`);
    await q.query(`CREATE TYPE "public"."campaign_recipients_processing_enum" AS ENUM('PENDING','DISPATCHING','DISPATCHED','FAILED','SKIPPED')`);
    await q.query(`CREATE TYPE "public"."campaign_recipients_delivery_enum" AS ENUM('NONE','ACCEPTED','DELIVERED','READ','BOUNCED')`);
    await q.query(`CREATE TYPE "public"."campaign_recipients_failure_class_enum" AS ENUM('TRANSIENT','PERMANENT')`);
    await q.query(`CREATE TYPE "public"."outbox_jobs_status_enum" AS ENUM('PENDING','PUBLISHED','FAILED')`);

    // ── campaigns: lifecycle ────────────────────────────────────────────────
    await q.query(`ALTER TABLE "campaigns" ADD COLUMN "lifecycle" "public"."campaigns_lifecycle_enum" NOT NULL DEFAULT 'DRAFT'`);
    await q.query(`
      UPDATE "campaigns" SET "lifecycle" = CASE "status"
        WHEN 'DRAFT' THEN 'DRAFT'
        WHEN 'SCHEDULED' THEN 'SCHEDULED'
        WHEN 'RUNNING' THEN 'ACTIVE'
        WHEN 'PAUSED' THEN 'PAUSED'
        WHEN 'COMPLETED' THEN 'ARCHIVED'
        WHEN 'CANCELLED' THEN 'ARCHIVED'
        ELSE 'DRAFT' END::"public"."campaigns_lifecycle_enum"
    `);
    await q.query(`DROP INDEX IF EXISTS "public"."IDX_07da9db483388fb0565e8b5fa3"`);
    await q.query(`CREATE INDEX "IDX_campaigns_tenant_lifecycle" ON "campaigns" ("tenantId", "lifecycle")`);
    await q.query(`ALTER TABLE "campaigns" DROP COLUMN "status"`);
    await q.query(`DROP TYPE IF EXISTS "public"."campaigns_status_enum"`);

    // ── campaign_runs ───────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "campaign_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "execution" "public"."campaign_runs_execution_enum" NOT NULL DEFAULT 'IDLE',
        "total_recipients" integer NOT NULL DEFAULT 0,
        "queued" integer NOT NULL DEFAULT 0,
        "sent" integer NOT NULL DEFAULT 0,
        "delivered" integer NOT NULL DEFAULT 0,
        "read" integer NOT NULL DEFAULT 0,
        "failed" integer NOT NULL DEFAULT 0,
        "skipped" integer NOT NULL DEFAULT 0,
        "idempotency_key" uuid NOT NULL,
        "version" integer NOT NULL,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP DEFAULT now(),
        "tenantId" uuid,
        "campaignId" uuid,
        CONSTRAINT "PK_campaign_runs" PRIMARY KEY ("id")
      )
    `);
    await q.query(`CREATE INDEX "IDX_campaign_runs_tenant_campaign_created" ON "campaign_runs" ("tenantId", "campaignId", "created_at")`);
    await q.query(`CREATE INDEX "IDX_campaign_runs_execution" ON "campaign_runs" ("execution")`);
    await q.query(`ALTER TABLE "campaign_runs" ADD CONSTRAINT "FK_campaign_runs_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await q.query(`ALTER TABLE "campaign_runs" ADD CONSTRAINT "FK_campaign_runs_campaign" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

    // Synthetic COMPLETED run per campaign that has recipients.
    await q.query(`
      INSERT INTO "campaign_runs" ("id","execution","idempotency_key","version","tenantId","campaignId","started_at","finished_at")
      SELECT uuid_generate_v4(), 'COMPLETED', uuid_generate_v4(), 1, c."tenantId", c."id", now(), now()
      FROM "campaigns" c
      WHERE EXISTS (SELECT 1 FROM "campaign_recipients" r WHERE r."campaignId" = c."id")
    `);

    // ── campaign_recipients: split status → processing + delivery ───────────
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "runId" uuid`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "processing" "public"."campaign_recipients_processing_enum" NOT NULL DEFAULT 'PENDING'`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "delivery" "public"."campaign_recipients_delivery_enum" NOT NULL DEFAULT 'NONE'`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "provider_ref" character varying(255)`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "failure_class" "public"."campaign_recipients_failure_class_enum"`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "failure_reason" text`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "attempts" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "dispatched_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "delivered_at" TIMESTAMP WITH TIME ZONE`);

    // Map legacy status → processing/delivery.
    await q.query(`
      UPDATE "campaign_recipients" SET
        "processing" = CASE "status"
          WHEN 'QUEUED' THEN 'PENDING'
          WHEN 'SENT' THEN 'DISPATCHED'
          WHEN 'DELIVERED' THEN 'DISPATCHED'
          WHEN 'READ' THEN 'DISPATCHED'
          WHEN 'FAILED' THEN 'FAILED'
          WHEN 'SKIPPED' THEN 'SKIPPED'
          ELSE 'PENDING' END::"public"."campaign_recipients_processing_enum",
        "delivery" = CASE "status"
          WHEN 'DELIVERED' THEN 'DELIVERED'
          WHEN 'READ' THEN 'READ'
          ELSE 'NONE' END::"public"."campaign_recipients_delivery_enum",
        "dispatched_at" = "sent_at"
    `);

    // Attach recipients to their campaign's synthetic run.
    await q.query(`
      UPDATE "campaign_recipients" r
      SET "runId" = (SELECT cr."id" FROM "campaign_runs" cr WHERE cr."campaignId" = r."campaignId" ORDER BY cr."created_at" ASC LIMIT 1)
      WHERE r."runId" IS NULL
    `);

    // Recompute counters on the synthetic runs from migrated processing states.
    await q.query(`
      UPDATE "campaign_runs" cr SET
        "total_recipients" = sub.total,
        "sent" = sub.sent, "failed" = sub.failed, "skipped" = sub.skipped,
        "delivered" = sub.delivered, "read" = sub.read,
        "queued" = sub.pending
      FROM (
        SELECT "runId",
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE "processing" = 'DISPATCHED') AS sent,
          COUNT(*) FILTER (WHERE "processing" = 'FAILED') AS failed,
          COUNT(*) FILTER (WHERE "processing" = 'SKIPPED') AS skipped,
          COUNT(*) FILTER (WHERE "processing" = 'PENDING') AS pending,
          COUNT(*) FILTER (WHERE "delivery" = 'DELIVERED') AS delivered,
          COUNT(*) FILTER (WHERE "delivery" = 'READ') AS read
        FROM "campaign_recipients" GROUP BY "runId"
      ) sub
      WHERE cr."id" = sub."runId"
    `);

    // De-dup any pre-existing identical provider refs is unnecessary (all NULL).
    await q.query(`CREATE UNIQUE INDEX "UQ_campaign_recipients_provider_ref" ON "campaign_recipients" ("provider_ref") WHERE "provider_ref" IS NOT NULL`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD CONSTRAINT "FK_campaign_recipients_run" FOREIGN KEY ("runId") REFERENCES "campaign_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

    // Swap the uniqueness/index from (campaign,customer)+status to run-based.
    await q.query(`DROP INDEX IF EXISTS "public"."IDX_3f28c2b1ce5590ea0892267033"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP CONSTRAINT IF EXISTS "UQ_60e8fbccdf8ccd204d395156be7"`);
    await q.query(`CREATE UNIQUE INDEX "uq_recipient_run_customer" ON "campaign_recipients" ("runId", "customerId")`);
    await q.query(`CREATE INDEX "ix_recipient_run_processing" ON "campaign_recipients" ("runId", "processing")`);
    await q.query(`CREATE INDEX "ix_recipient_campaign_customer" ON "campaign_recipients" ("campaignId", "customerId")`);

    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "status"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "sent_at"`);
    await q.query(`DROP TYPE IF EXISTS "public"."campaign_recipients_status_enum"`);

    // ── outbox_jobs ─────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "outbox_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "queue" character varying(64) NOT NULL,
        "job_name" character varying(96) NOT NULL,
        "dedupe_key" character varying(255) NOT NULL,
        "payload" jsonb NOT NULL,
        "status" "public"."outbox_jobs_status_enum" NOT NULL DEFAULT 'PENDING',
        "publish_attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "published_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outbox_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_outbox_jobs_dedupe_key" UNIQUE ("dedupe_key")
      )
    `);
    await q.query(`CREATE INDEX "ix_outbox_status_created" ON "outbox_jobs" ("status", "created_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "outbox_jobs"`);
    await q.query(`DROP TYPE IF EXISTS "public"."outbox_jobs_status_enum"`);

    // Restore campaign_recipients.status.
    await q.query(`CREATE TYPE "public"."campaign_recipients_status_enum" AS ENUM('QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED')`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "status" "public"."campaign_recipients_status_enum" NOT NULL DEFAULT 'QUEUED'`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "sent_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`
      UPDATE "campaign_recipients" SET
        "status" = CASE
          WHEN "delivery" = 'READ' THEN 'READ'
          WHEN "delivery" = 'DELIVERED' THEN 'DELIVERED'
          WHEN "processing" = 'DISPATCHED' THEN 'SENT'
          WHEN "processing" = 'FAILED' THEN 'FAILED'
          WHEN "processing" = 'SKIPPED' THEN 'SKIPPED'
          ELSE 'QUEUED' END::"public"."campaign_recipients_status_enum",
        "sent_at" = "dispatched_at"
    `);
    await q.query(`DROP INDEX IF EXISTS "public"."ix_recipient_campaign_customer"`);
    await q.query(`DROP INDEX IF EXISTS "public"."ix_recipient_run_processing"`);
    await q.query(`DROP INDEX IF EXISTS "public"."uq_recipient_run_customer"`);
    await q.query(`DROP INDEX IF EXISTS "public"."UQ_campaign_recipients_provider_ref"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP CONSTRAINT IF EXISTS "FK_campaign_recipients_run"`);
    await q.query(`ALTER TABLE "campaign_recipients" ADD CONSTRAINT "UQ_60e8fbccdf8ccd204d395156be7" UNIQUE ("campaignId", "customerId")`);
    await q.query(`CREATE INDEX "IDX_3f28c2b1ce5590ea0892267033" ON "campaign_recipients" ("campaignId", "status")`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "runId"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "processing"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "delivery"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "provider_ref"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "failure_class"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "failure_reason"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "attempts"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "dispatched_at"`);
    await q.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "delivered_at"`);
    await q.query(`DROP TYPE IF EXISTS "public"."campaign_recipients_processing_enum"`);
    await q.query(`DROP TYPE IF EXISTS "public"."campaign_recipients_delivery_enum"`);
    await q.query(`DROP TYPE IF EXISTS "public"."campaign_recipients_failure_class_enum"`);

    await q.query(`DROP TABLE IF EXISTS "campaign_runs"`);
    await q.query(`DROP TYPE IF EXISTS "public"."campaign_runs_execution_enum"`);

    // Restore campaigns.status.
    await q.query(`CREATE TYPE "public"."campaigns_status_enum" AS ENUM('DRAFT','SCHEDULED','RUNNING','PAUSED','COMPLETED','CANCELLED')`);
    await q.query(`ALTER TABLE "campaigns" ADD COLUMN "status" "public"."campaigns_status_enum" NOT NULL DEFAULT 'DRAFT'`);
    await q.query(`
      UPDATE "campaigns" SET "status" = CASE "lifecycle"
        WHEN 'DRAFT' THEN 'DRAFT'
        WHEN 'SCHEDULED' THEN 'SCHEDULED'
        WHEN 'ACTIVE' THEN 'RUNNING'
        WHEN 'PAUSED' THEN 'PAUSED'
        WHEN 'ARCHIVED' THEN 'CANCELLED'
        ELSE 'DRAFT' END::"public"."campaigns_status_enum"
    `);
    await q.query(`DROP INDEX IF EXISTS "public"."IDX_campaigns_tenant_lifecycle"`);
    await q.query(`CREATE INDEX "IDX_07da9db483388fb0565e8b5fa3" ON "campaigns" ("tenantId", "status")`);
    await q.query(`ALTER TABLE "campaigns" DROP COLUMN "lifecycle"`);
    await q.query(`DROP TYPE IF EXISTS "public"."campaigns_lifecycle_enum"`);
  }
}
