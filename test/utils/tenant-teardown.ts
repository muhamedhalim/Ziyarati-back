/**
 * FK-ordered, transactional teardown of synthetic test tenants.
 *
 * Why this exists. The hand-ordered `DELETE` lists in the audit fixtures missed tables
 * (`conversations`, `whatsapp_accounts`, `handover_requests`, ...) or listed them in an order the
 * foreign keys forbid (`customers` before `conversations`, `branches` before `whatsapp_accounts`).
 * Every statement was caught-and-continued, so the failure never reached the test: it surfaced only as
 * `update or delete on table "customers" violates foreign key constraint ...` in the Postgres log and a
 * clinic left behind. Order now comes from the DATABASE catalog — the same
 * `buildTenantDeletionPlan` the production offboarding path uses — so a new table cannot silently
 * break it.
 *
 * Guarantees:
 *  - tenant-scoped: every statement is bound to the given tenant ids; no other tenant is touched;
 *  - all-or-nothing: one transaction, so a failure leaves the tenant whole (never half-deleted);
 *  - idempotent: running it again on an already-deleted tenant deletes nothing and succeeds;
 *  - no constraint is disabled and no cascade rule is relied on — a row the plan cannot reach fails
 *    LOUDLY, naming the constraint.
 */
import type { DataSource, QueryRunner } from 'typeorm';

import { buildTenantDeletionPlan } from '../../src/modules/data-governance/tenant-offboarding.plan';
import { loadPlannerSchema } from '../../src/modules/data-governance/tenant-offboarding.catalog';

/**
 * Rows OWNED BY ANOTHER TENANT that point at the tenants being removed. A guest's "talk to a human"
 * links a DISCOVERY-tenant AI conversation (and a handover request) to a conversation the CLINIC
 * owns; the clinic's own plan cannot see them, and their foreign keys then block its conversations,
 * users and finally the tenant. Each statement is optional (a table or column may not exist in every
 * build) and is run under a savepoint so a missing one cannot abort the transaction.
 */
const CROSS_TENANT_PRE_STEPS: readonly string[] = [
  `DELETE FROM handover_requests WHERE "conversationId" IN (SELECT id FROM conversations WHERE "tenantId" = ANY($1))
      AND "tenantId" <> ALL($1)`,
  `DELETE FROM ai_messages WHERE ai_conversation_id::text IN (
      SELECT ac.id::text FROM ai_conversations ac JOIN conversations c ON c.id = ac."conversationId"
       WHERE c."tenantId" = ANY($1) AND ac."tenantId" <> ALL($1))`,
  `DELETE FROM ai_tool_calls WHERE ai_conversation_id::text IN (
      SELECT ac.id::text FROM ai_conversations ac JOIN conversations c ON c.id = ac."conversationId"
       WHERE c."tenantId" = ANY($1) AND ac."tenantId" <> ALL($1))`,
  `DELETE FROM ai_conversations WHERE id IN (
      SELECT ac.id FROM ai_conversations ac JOIN conversations c ON c.id = ac."conversationId"
       WHERE c."tenantId" = ANY($1) AND ac."tenantId" <> ALL($1))`,
];

export interface TenantTeardownResult {
  /** Rows deleted per table, summed over the given tenants (tables that deleted nothing are omitted). */
  deleted: Record<string, number>;
}

/**
 * Deletes every row the given tenants own, then the tenants. Throws (after rolling back) if any
 * foreign key still blocks it.
 */
export async function teardownTenants(
  ds: DataSource,
  tenantIds: readonly string[],
): Promise<TenantTeardownResult> {
  const deleted: Record<string, number> = {};
  const ids = [...new Set(tenantIds.filter(Boolean))];
  if (ids.length === 0) return { deleted };

  const plan = buildTenantDeletionPlan(await loadPlannerSchema(ds));
  const qr: QueryRunner = ds.createQueryRunner();
  await qr.connect();
  try {
    await qr.startTransaction();
    try {
      await qr.query(`SET LOCAL lock_timeout = '30s'`);

      for (const sql of CROSS_TENANT_PRE_STEPS) {
        await qr.query('SAVEPOINT cross_tenant_step');
        try {
          await qr.query(sql, [ids]);
          await qr.query('RELEASE SAVEPOINT cross_tenant_step');
        } catch {
          await qr.query('ROLLBACK TO SAVEPOINT cross_tenant_step');
        }
      }

      // One tenant at a time keeps every statement bound to a single `$1` tenant id, exactly as the
      // production executor runs the plan.
      for (const tenantId of ids) {
        for (const step of plan) {
          const result = (await qr.query(
            `DELETE FROM "${step.table}" WHERE ${step.predicate.replace(/:tenant\b/g, '$1')}`,
            [tenantId],
            true,
          )) as { affected?: number };
          if (result.affected) {
            deleted[step.table] = (deleted[step.table] ?? 0) + result.affected;
          }
        }
      }
      await qr.commitTransaction();
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  } finally {
    await qr.release();
  }
  return { deleted };
}
