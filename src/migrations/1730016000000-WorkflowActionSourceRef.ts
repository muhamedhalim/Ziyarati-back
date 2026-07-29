import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.11.
 *
 * Adds a `source_ref` column (nullable, partial-unique) to `notification_logs`
 * and `scheduled_notifications` — a caller-supplied BUSINESS key (e.g.
 * `workflow-action:{runId}:{actionIndex}`) that lets a side-effect-producing
 * write declare "this exact business operation, not just this exact content"
 * and have the DATABASE itself reject a second attempt via the unique index,
 * rather than relying purely on in-memory/check-then-act logic.
 *
 * This closes the residual double-execution window in the Workflow engine: the
 * action-level atomic claim (`WorkflowService.claimAction`) prevents two
 * CONCURRENT deliveries of the same action, but a crash AFTER the side effect
 * already ran and BEFORE the claim's terminal result was written leaves the
 * claim reclaimable once stale — at which point WHATSAPP (`sendSession`, no
 * persistence of its own) and NOTIFICATION (`schedule`, creates a fresh row
 * with no dedupe) had no floor stopping a second real send/schedule. EMAIL and
 * AI already have their own `idempotencyKey` plumbing (see
 * docs/CACHING_QUEUES_AUDIT.md §0.8.4); this gives WhatsApp/Notification the
 * equivalent floor via a DB constraint instead, since neither has a natural
 * content-addressable log table of its own to key off.
 *
 * Nullable + partial index (`WHERE source_ref IS NOT NULL`): every row that
 * predates this column, and every row from a caller that has no business key
 * to offer (e.g. a direct HTTP schedule/send, not routed through the workflow
 * engine), is entirely unaffected — only two rows that BOTH set the same
 * non-null `source_ref` collide.
 */
export class WorkflowActionSourceRef1730016000000 implements MigrationInterface {
  name = 'WorkflowActionSourceRef1730016000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'notification_logs' AND column_name = 'source_ref'
        ) THEN
          ALTER TABLE "notification_logs" ADD COLUMN "source_ref" VARCHAR(255) NULL;
        END IF;
      END $$;
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notification_logs_source_ref"
      ON "notification_logs" ("source_ref")
      WHERE "source_ref" IS NOT NULL;
    `);

    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'scheduled_notifications' AND column_name = 'source_ref'
        ) THEN
          ALTER TABLE "scheduled_notifications" ADD COLUMN "source_ref" VARCHAR(255) NULL;
        END IF;
      END $$;
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_scheduled_notifications_source_ref"
      ON "scheduled_notifications" ("source_ref")
      WHERE "source_ref" IS NOT NULL;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_scheduled_notifications_source_ref"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "source_ref"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_notification_logs_source_ref"`);
    await q.query(`ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "source_ref"`);
  }
}
