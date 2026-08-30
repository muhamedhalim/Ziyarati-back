import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `audit_logs` currently declares NO index at all — every read (the S7
 * activity log, T191/T192) would be a full table scan. Adds the three
 * indexes the activity log's list/filter surface needs (see
 * activity-log.controller.ts, added in Phase 16).
 *
 * `CONCURRENTLY` + `transaction = false` (mirrors
 * CrmCustomerSoftDeleteAwareUniqueness1730059000000): `audit_logs` is written
 * on hot paths by ten-plus services, so a locking build would stall
 * authentication and payments.
 */
export class AuditLogIndexes1730062000000 implements MigrationInterface {
  name = 'AuditLogIndexes1730062000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_tenant_created" ON "audit_logs" ("tenantId", "created_at" DESC)`,
    );
    await this.assertValid(q, 'IDX_audit_logs_tenant_created');

    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_tenant_action_created" ON "audit_logs" ("tenantId", "action", "created_at" DESC)`,
    );
    await this.assertValid(q, 'IDX_audit_logs_tenant_action_created');

    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_tenant_entity" ON "audit_logs" ("tenantId", "entity_type", "entity_id")`,
    );
    await this.assertValid(q, 'IDX_audit_logs_tenant_entity');
  }

  private async assertValid(q: QueryRunner, indexName: string): Promise<void> {
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"${indexName}"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        `AuditLogIndexes: "${indexName}" was created but is NOT valid — a CONCURRENTLY build ` +
          'failed partway. Investigate, drop the invalid index, and re-run this migration.',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_audit_logs_tenant_entity"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_audit_logs_tenant_action_created"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_audit_logs_tenant_created"`);
  }
}
