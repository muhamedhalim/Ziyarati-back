import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Production hardening for verification documents:
 *  - `content_hash` on documents (SHA-256) for same-type dedup.
 *  - `verification_audit_logs`: immutable trail (upload/replace/delete/view/
 *    approve/reject/submit) with actor, IP and user agent.
 *  - `admin_notifications`: in-app super-admin notifications (unread badge).
 */
export class VerificationAuditAndAdminNotifications1730001500000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "tenant_verification_documents" ADD COLUMN IF NOT EXISTS "content_hash" character varying`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "verification_audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "document_id" uuid,
        "action" character varying NOT NULL,
        "doc_type" character varying,
        "actor_id" uuid,
        "actor_role" character varying,
        "ip_address" character varying,
        "user_agent" text,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_verification_audit_logs" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_verif_audit_tenant" ON "verification_audit_logs" ("tenant_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_verif_audit_tenant_created" ON "verification_audit_logs" ("tenant_id", "created_at")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "admin_notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" character varying NOT NULL,
        "title" character varying NOT NULL,
        "body" text,
        "tenant_id" uuid,
        "data" jsonb,
        "is_read" boolean NOT NULL DEFAULT false,
        "read_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_notifications" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_admin_notif_read_created" ON "admin_notifications" ("is_read", "created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "admin_notifications"`);
    await q.query(`DROP TABLE IF EXISTS "verification_audit_logs"`);
    await q.query(
      `ALTER TABLE "tenant_verification_documents" DROP COLUMN IF EXISTS "content_hash"`,
    );
  }
}
