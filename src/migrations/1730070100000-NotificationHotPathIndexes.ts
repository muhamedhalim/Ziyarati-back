import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two purely-additive indexes on the EXISTING outbound notification tables.
 * No column, constraint or row is touched — this migration cannot change
 * behaviour, only cost.
 *
 * 1. `notification_rules` has **no index at all** today (verify: the entity
 *    carries no `@Index`, and neither `NotificationsHardening1730000800000`
 *    nor `NotificationsWhatsappIntegration1730000900000` creates one — those
 *    two only index `scheduled_notifications` and `notification_logs`).
 *    `NotificationRuleService.findActiveByTrigger` filters on exactly
 *    `(tenantId, trigger_event, is_active)` and is called by
 *    `NotificationEventListener` on EVERY appointment, payment, subscription
 *    and handover event across every tenant — so the hottest read in the
 *    notification pipeline is a sequential scan that grows with the table.
 *
 * 2. `scheduled_notifications` is indexed on `(status, scheduled_at)` for the
 *    worker's due-row sweep, but the tenant-facing list
 *    (`NotificationSchedulerService.findAll`, `GET /scheduled-notifications`)
 *    always filters by tenant first and orders by `scheduled_at`. That query
 *    has no supporting index and degrades as the outbox accumulates history.
 *
 * PRODUCTION LOCK RISK: both are built `CONCURRENTLY` so no `ACCESS
 * EXCLUSIVE` lock is taken on a live table. `CONCURRENTLY` cannot run inside
 * a transaction block, hence `transaction = false` — the same pattern as
 * `SubscriptionInvoiceOpenUniqueness1730020000000`. Neither index is unique,
 * so unlike that migration there is no data precondition that can make the
 * build fail partway; the validity check below is kept anyway, because a
 * `CONCURRENTLY` build can still be interrupted and leave an INVALID index
 * that silently never gets used.
 */
export class NotificationHotPathIndexes1730070100000
  implements MigrationInterface
{
  name = 'NotificationHotPathIndexes1730070100000';
  public transaction = false;

  private static readonly INDEXES = [
    'IX_notification_rules_tenant_trigger_active',
    'IX_scheduled_notifications_tenant_status_scheduled',
  ];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IX_notification_rules_tenant_trigger_active"
        ON "notification_rules" ("tenantId", "trigger_event", "is_active")
    `);

    await q.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IX_scheduled_notifications_tenant_status_scheduled"
        ON "scheduled_notifications" ("tenantId", "status", "scheduled_at")
    `);

    // An interrupted CONCURRENTLY build leaves an INVALID index behind: it is
    // maintained on write but never used for reads, so the performance problem
    // silently persists. Fail loudly instead.
    for (const index of NotificationHotPathIndexes1730070100000.INDEXES) {
      const [row] = await q.query(
        `SELECT indisvalid FROM pg_index WHERE indexrelid = $1::regclass`,
        [`"${index}"`],
      );
      if (!row?.indisvalid) {
        throw new Error(
          `"${index}" was created but is NOT valid — a CONCURRENTLY build was interrupted. ` +
            'Remove the invalid index and re-run this migration.',
        );
      }
    }
  }

  /** Fully reversible — these are pure performance indexes over no constraint. */
  public async down(q: QueryRunner): Promise<void> {
    for (const index of NotificationHotPathIndexes1730070100000.INDEXES) {
      await q.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
    }
  }
}
