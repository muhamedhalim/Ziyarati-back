import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D7 — replaces `users`' TENANT-SCOPED email uniqueness
 * (`UQ_7346b08032078107fce81e014f6 UNIQUE ("tenantId", "email")`) with a
 * GLOBAL invariant: at most one live user row per email, across every tenant
 * AND the platform scope (`tenantId IS NULL`).
 *
 * WHY: `AuthService.validateCredentials` called without a `tenantSlug` —
 * which is what the single login form always does — matches by email across
 * EVERY scope and lets the password disambiguate. Two live users sharing an
 * email is therefore an authentication-correctness bug, not a UX wrinkle.
 * Postgres treats NULLs as distinct in a unique constraint, so the old
 * composite constraint left the entire platform scope (`tenantId IS NULL`)
 * completely unconstrained — nothing prevented two Super Admins, or a
 * platform staff member and a Super Admin, from sharing an email.
 *
 * PREDICATE CHOICE: `deleted_at IS NULL`, not `is_active = true`. The
 * literal "active user" reading would be `deleted_at IS NULL AND is_active`,
 * but that has a trap: deactivate user A, create user B on the freed email,
 * then REACTIVATING A raises a unique violation on an unrelated action. The
 * `deleted_at` predicate is monotonic (no such trap), strictly stronger than
 * not constraining at all, and still leaves soft-delete as the way to
 * genuinely release an email for reuse. The application-layer check in
 * `AuthService.createUserWithRole` uses the IDENTICAL predicate (a plain
 * `manager.findOne(User, { where: { email } })`, which TypeORM's
 * `@DeleteDateColumn` already excludes soft-deleted rows from) so the two
 * layers can never disagree and produce an unmapped 500.
 *
 * NORMALIZATION: `AuthService.normalizeEmail` already lowercases on every
 * known write path, so a plain (non-`lower()`) index is sufficient AND
 * serves login's `WHERE email = $1` lookup directly — the dropped composite
 * constraint could not, since `tenantId` was its leading column. The
 * `ck_user_email_lowercase` CHECK constraint turns "already lowercase" into
 * an enforced DB invariant so the plain index can never silently diverge
 * from `normalizeEmail`'s behaviour. Existing rows are defensively
 * normalized before the CHECK is added, in case any write path bypassed
 * `normalizeEmail` historically.
 *
 * ACCEPTED BEHAVIOUR CHANGE (D7, "no production data yet, prefer the
 * correct invariant"): the same email can no longer be reused across two
 * different clinics — a real product change a clinic-onboarding owner
 * should be aware of.
 *
 * PRODUCTION LOCK RISK: mirrors CustomerTenantScopedEmail
 * (1730019000000) — `CREATE UNIQUE INDEX CONCURRENTLY` avoids an
 * `ACCESS EXCLUSIVE` lock on `users`, so `transaction = false` disables
 * TypeORM's per-migration transaction wrapper for this migration only.
 */
export class GlobalUserEmailUniqueness1730035000000 implements MigrationInterface {
  name = 'GlobalUserEmailUniqueness1730035000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    // 0. Defensive normalization — bring any row a bypassing write path may
    //    have left mixed-case into compliance BEFORE the CHECK constraint
    //    would otherwise refuse to be added.
    await q.query(
      `UPDATE "users" SET "email" = lower("email") WHERE "email" IS NOT NULL AND "email" <> lower("email")`,
    );

    // 1. Pre-flight — refuse to run rather than silently produce an INVALID
    //    index. Runs AFTER normalization so a same-email-different-case pair
    //    is correctly caught here, not later as a surprise CONCURRENTLY
    //    build failure.
    const duplicates: { email: string; rows: string }[] = await q.query(`
      SELECT "email", count(*)::text AS rows
      FROM "users"
      WHERE "deleted_at" IS NULL AND "email" IS NOT NULL
      GROUP BY "email"
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 50
    `);
    if (duplicates.length > 0) {
      throw new Error(
        `D7: refused — ${duplicates.length} email(s) are shared by more than one live user ` +
          `(e.g. "${duplicates[0].email}" x ${duplicates[0].rows} rows). Resolve these ` +
          '(merge, deactivate + soft-delete, or change one address) before re-running this migration.',
      );
    }

    // 2. Normalization becomes a DB invariant.
    await q.query(
      `ALTER TABLE "users" ADD CONSTRAINT "ck_user_email_lowercase" CHECK ("email" IS NULL OR "email" = lower("email"))`,
    );

    // 3. Build the new global partial unique index WITHOUT locking
    //    concurrent reads/writes on `users`. `IF NOT EXISTS` makes a re-run
    //    after a partial failure safe.
    await q.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_user_email_global"
      ON "users" ("email")
      WHERE "deleted_at" IS NULL AND "email" IS NOT NULL
    `);

    // 4. Verify the index actually built successfully — a CONCURRENTLY build
    //    that fails partway leaves an INVALID index behind that silently
    //    enforces nothing.
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"uq_user_email_global"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        'D7: "uq_user_email_global" was created but is NOT valid — a CONCURRENTLY build failed ' +
          'partway. Investigate, drop the invalid index, resolve the underlying data, and re-run ' +
          'this migration. The old tenant-scoped constraint has deliberately NOT been dropped.',
      );
    }

    // 5. Only now drop the old composite constraint — brief ACCESS
    //    EXCLUSIVE, unavoidable for a constraint drop, but the new index is
    //    already valid and enforcing by this point, so there is no window
    //    with weaker-than-intended uniqueness in effect.
    await q.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_7346b08032078107fce81e014f6"`,
    );
  }

  /**
   * ASYMMETRIC ROLLBACK — NOT fully reversible, and never described as such.
   * Restoring the tenant-scoped constraint fails outright once two DIFFERENT
   * tenants (or a tenant and the platform scope) share an email — exactly
   * what this migration exists to forbid globally while still permitting
   * per-tenant, so nothing new should exist to conflict; this only guards
   * against a same-tenant duplicate that could theoretically slip in while
   * only the (weaker) global constraint was enforcing.
   */
  public async down(q: QueryRunner): Promise<void> {
    const conflicts: {
      tenantId: string | null;
      email: string;
      rows: string;
    }[] = await q.query(`
      SELECT "tenantId", "email", count(*)::text AS rows
      FROM "users"
      GROUP BY "tenantId", "email"
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 50
    `);
    if (conflicts.length > 0) {
      throw new Error(
        `D7 rollback refused: ${conflicts.length} (tenant, email) pair(s) are now duplicated ` +
          `(e.g. tenant "${conflicts[0].tenantId}" / "${conflicts[0].email}" x ${conflicts[0].rows} rows) ` +
          '— restoring UNIQUE ("tenantId", "email") would fail. Resolve the conflicting rows manually ' +
          'before retrying.',
      );
    }

    await q.query(
      `ALTER TABLE "users" ADD CONSTRAINT "UQ_7346b08032078107fce81e014f6" UNIQUE ("tenantId", "email")`,
    );
    await q.query(`DROP INDEX IF EXISTS "uq_user_email_global"`);
    await q.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "ck_user_email_lowercase"`,
    );
  }
}
