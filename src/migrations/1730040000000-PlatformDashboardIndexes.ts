import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes backing the Platform Control Center (`/platform/dashboard`).
 *
 * Every predicate the dashboard puts on a hot path gets an index here, because
 * the landing page of the admin console must never become the slowest query in
 * the product. None of these existed: `tenants` carried only the unique `slug`
 * index, `subscriptions` only `(tenantId)`, and `audit_logs` had no index at all.
 *
 * Environment note — these indexes exist ONLY here, never as `@Index()` on the
 * entities, matching the precedent `PlatformHardening1730001000000` set for
 * operational/reporting indexes. The consequence is worth knowing: a dev box
 * running `TYPEORM_SYNCHRONIZE=true` skips migrations entirely
 * (`typeorm.config.ts` — `if (!synchronize) await runMigrationsWithAdvisoryLock`),
 * so these indexes are ABSENT in dev and query plans there will not resemble
 * production. Declaring them on the entities instead would make `synchronize`
 * create them under TypeORM's own generated `IDX_<hash>` names, leaving two
 * indexes covering the same columns — which is why they live only here.
 *
 * Deployment note — `audit_logs` is the one table here that can be genuinely
 * large. `CREATE INDEX` takes a lock that blocks writes for the duration, and
 * `CONCURRENTLY` cannot run inside the transaction the migration runner opens.
 * On a large installation, create `IX_audit_logs_created_at` out-of-band with
 * `CREATE INDEX CONCURRENTLY` first; this migration's `IF NOT EXISTS` then makes
 * the corresponding statement a no-op. Every other table here is small enough
 * that the inline lock is immaterial.
 *
 * Idempotent, matching `PlatformHardening1730001000000`.
 */
export class PlatformDashboardIndexes1730040000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ── Tenant lifecycle counts + growth series ──────────────────────────
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_tenants_approval_status" ON "tenants" ("approval_status")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_tenants_created_at" ON "tenants" ("created_at")`,
    );

    // ── Subscription distribution + "expiring soon" ──────────────────────
    // The composite serves the status distribution and the expiry window from
    // one scan; the single-column index serves an expiry lookup that does not
    // constrain status (renewals across every state).
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_subscriptions_ends_at" ON "subscriptions" ("ends_at")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_subscriptions_status_ends_at" ON "subscriptions" ("status", "ends_at")`,
    );

    // ── Integration health (expired / revoked Meta tokens) ───────────────
    // Partial: disconnected rows are the minority and the only ones ever
    // queried here, so the index stays small.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_whatsapp_accounts_connection_status"
         ON "whatsapp_accounts" ("connection_status")
       WHERE "deleted_at" IS NULL`,
    );

    // ── Verification queue ───────────────────────────────────────────────
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_verification_docs_pending"
         ON "tenant_verification_documents" ("tenantId")
       WHERE "status" = 'PENDING' AND "deleted_at" IS NULL`,
    );

    // ── Recent activity feed ─────────────────────────────────────────────
    // `tenant_approval_events` already has ("tenantId", created_at), but the
    // dashboard's feed is global and unfiltered by tenant, so that index's
    // leading column is the wrong one for this access path.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_tenant_approval_events_created_at"
         ON "tenant_approval_events" ("created_at")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_audit_logs_created_at" ON "audit_logs" ("created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."IX_audit_logs_created_at"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_tenant_approval_events_created_at"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_verification_docs_pending"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_whatsapp_accounts_connection_status"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_subscriptions_status_ends_at"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_subscriptions_ends_at"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_tenants_created_at"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_tenants_approval_status"`);
  }
}
