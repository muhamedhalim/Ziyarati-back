import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 0 outbox hardening (see docs/CACHING_QUEUES_AUDIT.md §0.5 items 4-5):
 *
 *  - `opts` column: lets a writer attach per-job BullMQ options (attempts,
 *    backoff, delay) that the relay passes through at publish time — needed
 *    once the outbox covers domains whose direct-enqueue call sites used
 *    non-default options (e.g. webhook delivery's custom attempts/backoff).
 *  - `PUBLISHING` enum value: the relay's new claim → publish → mark sequence
 *    (fixing the prior "publish inside the DB transaction" bug) needs a
 *    third state between PENDING and PUBLISHED/FAILED to represent "claimed,
 *    publish in flight" — a row stuck here past a threshold is how a crashed
 *    relay's in-flight publish is detected and recovered.
 *
 * `ALTER TYPE ... ADD VALUE` is safe inside this migration's transaction on
 * Postgres 12+ as long as the new value is not USED in the same transaction
 * (it isn't — no data is written here). Note this safety is per-migration, not
 * structural: `typeorm.config.ts` sets `migrationsTransactionMode: 'each'`
 * (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.3/§0.9) precisely
 * so a FUTURE migration that both adds and uses an enum value in one deploy
 * can never be grouped into the same transaction as this one by TypeORM's
 * default all-pending-migrations-in-one-transaction behaviour.
 *
 * Current-data safety: both ADD COLUMNs are nullable with no default, which
 * Postgres 11+ applies as a metadata-only change (no table rewrite) — safe on
 * a populated `outbox_jobs` table.
 */
export class OutboxHardening1730014000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TYPE "public"."outbox_jobs_status_enum" ADD VALUE IF NOT EXISTS 'PUBLISHING'`);
    await q.query(`ALTER TABLE "outbox_jobs" ADD COLUMN IF NOT EXISTS "opts" jsonb`);
    // Set the instant a row was claimed (PENDING -> PUBLISHING). Distinct from
    // `created_at` (which a row keeps from insertion) because a row can sit
    // PENDING for a while before being claimed — the recovery sweep needs to
    // know how long THIS claim has been in flight, not how old the row is.
    await q.query(`ALTER TABLE "outbox_jobs" ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz`);
  }

  /**
   * Rollback safety (gap-closure pass): refuses to drop `claimed_at` while any
   * row is still `PUBLISHING` — that column is the ONLY signal the relay's
   * recovery sweep uses to tell "mid-flight" from "stuck"; dropping it out from
   * under an in-flight claim would silently orphan those rows with no
   * automated way back to PENDING. Resolve them first (wait for the relay to
   * finish, or run the recovery sweep / reset manually) before rolling back.
   *
   * Postgres cannot DROP a single enum value; reversing PUBLISHING would
   * require rebuilding the type. Left in place on down() — an added enum
   * value with no rows using it is harmless, and every other migration in
   * this set treats enum additions the same way (see e.g. campaign lifecycle
   * enums, which are never shrunk on down()). This is a permanent, accepted
   * Postgres limitation, not an oversight.
   */
  public async down(q: QueryRunner): Promise<void> {
    const stuck = await q.query(
      `SELECT count(*)::int AS count FROM "outbox_jobs" WHERE "status" = 'PUBLISHING'`,
    );
    const count = stuck?.[0]?.count ?? 0;
    if (count > 0) {
      throw new Error(
        `Refusing to roll back OutboxHardening: ${count} outbox row(s) are currently PUBLISHING. ` +
          `Dropping "claimed_at" now would orphan them with no automated recovery path. ` +
          `Wait for them to drain (or reset them to PENDING manually) and retry.`,
      );
    }
    await q.query(`ALTER TABLE "outbox_jobs" DROP COLUMN IF EXISTS "claimed_at"`);
    await q.query(`ALTER TABLE "outbox_jobs" DROP COLUMN IF EXISTS "opts"`);
  }
}
