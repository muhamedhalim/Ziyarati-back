import { MigrationInterface, QueryRunner } from 'typeorm';
import { slugify } from '../common/utils/slugify.util';

/**
 * Marketplace BE-2 (T060) — `staff_profiles.public_slug`: a stable, globally
 * unique identifier for the flat `/doctors/[doctorSlug]` route. Added
 * nullable first so the backfill can run without violating NOT NULL, then
 * tightened once every row has a value — the standard safe-column-addition
 * shape for a table that may already hold data.
 *
 * Backfill: name-derived (`users.full_name`) via the same `slugify()` the
 * live `StaffService` uses for new rows, with deterministic numeric
 * disambiguation (`dr-ahmed-ali`, `dr-ahmed-ali-2`, ...) tracked in-memory
 * across the whole backfill pass so two colliding names in the same run
 * never both claim the base slug.
 */
export class StaffPublicSlug1730096000000 implements MigrationInterface {
  name = 'StaffPublicSlug1730096000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "staff_profiles" ADD COLUMN IF NOT EXISTS "public_slug" varchar(160)`,
    );

    // LEFT JOIN, not JOIN: a `staff_profiles` row whose `user_id` matches no
    // live `users` row (a pre-existing data-integrity gap, orphaned test
    // fixture, or similar) must still get a slug — `slugify(null, 'doctor')`
    // already falls back cleanly — or the "cover every existing row" accept
    // criterion silently fails for exactly the rows most likely to need it.
    const rows: { id: string; full_name: string | null }[] = await q.query(
      `SELECT sp.id, u.full_name
         FROM "staff_profiles" sp
         LEFT JOIN "users" u ON u.id = sp."user_id"
        WHERE sp."public_slug" IS NULL
        ORDER BY sp.created_at ASC`,
    );

    if (rows.length > 0) {
      const existing: { public_slug: string }[] = await q.query(
        `SELECT "public_slug" FROM "staff_profiles" WHERE "public_slug" IS NOT NULL`,
      );
      const taken = new Set(existing.map((r) => r.public_slug));

      for (const row of rows) {
        const base = slugify(row.full_name ?? '', 'doctor');
        let candidate = base;
        let n = 2;
        while (taken.has(candidate)) {
          candidate = `${base}-${n}`;
          n += 1;
        }
        taken.add(candidate);
        await q.query(
          `UPDATE "staff_profiles" SET "public_slug" = $1 WHERE id = $2`,
          [candidate, row.id],
        );
      }
    }

    // Prove the backfill left nothing behind before tightening the column —
    // a NOT NULL/unique add that fails partway is worse than one that never
    // ran (Constitution — never ship a partial state silently).
    const [{ c: stillNull }] = (await q.query(
      `SELECT COUNT(*)::int AS c FROM "staff_profiles" WHERE "public_slug" IS NULL`,
    )) as [{ c: number }];
    if (Number(stillNull) > 0) {
      throw new Error(
        `${StaffPublicSlug1730096000000.name}: ${stillNull} staff_profiles row(s) still have a NULL ` +
          'public_slug after the backfill loop — investigate before tightening the column.',
      );
    }

    await q.query(
      `ALTER TABLE "staff_profiles" ALTER COLUMN "public_slug" SET NOT NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_staff_profiles_public_slug" ON "staff_profiles" ("public_slug")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "public"."UQ_staff_profiles_public_slug"`,
    );
    await q.query(
      `ALTER TABLE "staff_profiles" ALTER COLUMN "public_slug" DROP NOT NULL`,
    );
    await q.query(
      `ALTER TABLE "staff_profiles" DROP COLUMN IF EXISTS "public_slug"`,
    );
  }
}
