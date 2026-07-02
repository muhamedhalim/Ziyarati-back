import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email delivery log — backs delivery-error logging, observability and
 * idempotent sending for the new email infrastructure.
 */
export class EmailLogs1730001900000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "email_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid,
        "to_address" character varying NOT NULL,
        "template" character varying NOT NULL,
        "subject" character varying,
        "locale" character varying NOT NULL DEFAULT 'en',
        "status" character varying NOT NULL DEFAULT 'QUEUED',
        "provider" character varying,
        "provider_message_id" character varying,
        "error" text,
        "idempotency_key" character varying,
        "attempts" integer NOT NULL DEFAULT 0,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "sent_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_email_logs" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_logs_idempotency" ON "email_logs" ("idempotency_key")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_email_logs_status_created" ON "email_logs" ("status", "created_at")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_email_logs_tenant_created" ON "email_logs" ("tenant_id", "created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "email_logs"`);
  }
}
