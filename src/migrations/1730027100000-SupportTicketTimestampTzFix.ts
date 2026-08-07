import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fixes a latent timezone bug on Support Tickets: `created_at`/`updated_at`
 * were plain `TIMESTAMP` (no zone) while `resolved_at`/`closed_at` are
 * `TIMESTAMPTZ`. The `pg` driver decodes a naive `timestamp` as if it were
 * already expressed in the Node process's local zone, so on any deployment
 * not running in UTC, a duration computed as `resolvedAt - createdAt`
 * (this feature's "resolution time" / "total lifecycle time") comes out
 * wrong by the process's UTC offset — reproduced locally in Asia/Riyadh
 * (UTC+3): a 4-minute resolution showed as "3 hours 4 minutes".
 *
 * The existing naive values were always written by Postgres's own `now()`
 * (server timezone `Etc/UTC` in every environment that matters here), so
 * `... AT TIME ZONE 'UTC'` reinterprets the stored digits as UTC and yields
 * the exact same instant, just correctly tagged — a lossless, additive
 * backfill for every existing row.
 */
export class SupportTicketTimestampTzFix1730027100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "support_tickets"
      ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC',
      ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'
    `);
    await q.query(`
      ALTER TABLE "support_ticket_events"
      ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "support_ticket_events"
      ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC'
    `);
    await q.query(`
      ALTER TABLE "support_tickets"
      ALTER COLUMN "updated_at" TYPE TIMESTAMP USING "updated_at" AT TIME ZONE 'UTC',
      ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC'
    `);
  }
}
