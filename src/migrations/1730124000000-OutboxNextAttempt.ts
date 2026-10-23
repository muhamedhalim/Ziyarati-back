import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CR-09 - time-based retry backoff for the transactional outbox.
 *
 * Adds `outbox_jobs.next_attempt_at`: the earliest instant the relay may claim a row again after a
 * failed publish. Before this, a failed row went straight back to PENDING and was re-claimed on the
 * next 1 s tick, so the whole attempt budget was burnt in seconds and rows were parked FAILED
 * during any Redis failover.
 *
 * EXPAND-only: one nullable column, no default, metadata-only on Postgres 11+ (no table rewrite).
 * Old relay code ignores it, new relay code treats NULL as "due now", so a rolling deploy is safe
 * in either order.
 */
export class OutboxNextAttempt1730124000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "outbox_jobs" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "outbox_jobs" DROP COLUMN IF EXISTS "next_attempt_at"`);
  }
}
