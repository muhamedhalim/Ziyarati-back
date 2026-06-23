import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-tenant timezone readiness. `branches.timezone` already exists (IANA id);
 * this makes the SaaS default `Asia/Riyadh` (KSA-first) for NEW branches and
 * backfills branches that were never explicitly set away from the old `UTC`
 * default. Branches that already carry a real zone are left untouched.
 *
 * Each branch can hold its own IANA zone (e.g. `Asia/Riyadh`, `Africa/Cairo`,
 * `Asia/Beirut`) for the Arab-region expansion — DST is handled at evaluation
 * time by the engine, not the schema.
 */
export class BranchTimezoneDefault1730001200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "branches" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Riyadh'`);
    await q.query(`UPDATE "branches" SET "timezone" = 'Asia/Riyadh' WHERE "timezone" IS NULL OR "timezone" = 'UTC'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "branches" ALTER COLUMN "timezone" SET DEFAULT 'UTC'`);
    // Data backfill is intentionally not reverted (no record of prior values).
  }
}
