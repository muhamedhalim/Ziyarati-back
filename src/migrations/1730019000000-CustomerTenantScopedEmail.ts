import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M-01 (FND-040) — replaces `customers`' GLOBAL email uniqueness with
 * TENANT-SCOPED uniqueness, matching the sibling pattern already proven on
 * this table: `IDX_4c0d50bb04cf7976e922b5781d UNIQUE ("tenantId", phone)`.
 *
 * Verified live (data-model.md §D-1, §M-01) before writing this migration:
 *  - `email` is `NOT NULL` — there are no NULLs to special-case, so this is a
 *    plain unique index, not a partial one;
 *  - the current constraint is `UQ_8536b8b85c06969f84f0c098b03 UNIQUE (email)`,
 *    case-sensitive (`btree (email)`, no `lower()`) — that exact semantic is
 *    preserved, not "improved" to case-insensitive (out of this finding's scope);
 *  - structurally the change is strictly RELAXING: global uniqueness implies
 *    `(tenantId, email)` uniqueness for any existing dataset, so the forward
 *    migration cannot fail on data. The empirical duplicate assessment
 *    (T023, quickstart §3.1) found zero cross-tenant duplicates in the local
 *    dev DB — which proves nothing about production and MUST be re-run
 *    against production-like data before this deploys there (R-DB9).
 *
 * PRODUCTION LOCK RISK: step 1 uses `CREATE UNIQUE INDEX CONCURRENTLY` to
 * avoid taking an `ACCESS EXCLUSIVE` lock on a potentially large table.
 * `CONCURRENTLY` cannot run inside a transaction block, so `transaction =
 * false` below disables TypeORM's per-migration transaction wrapper for
 * this migration only — every other migration keeps running inside its own
 * transaction (`migrationsTransactionMode: 'each'`, see
 * run-migrations-with-lock.ts). Step 3 (dropping the old constraint) DOES
 * take a brief `ACCESS EXCLUSIVE` lock — unavoidable for a constraint drop,
 * but short since it touches no rows.
 *
 * APPLICATION COMPATIBILITY: the backend must tolerate BOTH constraint
 * shapes before this migration runs (see Customer.ts / customer.service.ts,
 * FND-040) — the deploy is migration → backend → frontend, and mapping a
 * unique-violation from either constraint to the same client error removes
 * the ordering sensitivity a naive rollout would have.
 */
export class CustomerTenantScopedEmail1730019000000 implements MigrationInterface {
  name = 'CustomerTenantScopedEmail1730019000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    // 1. Build the new tenant-scoped unique index WITHOUT locking concurrent
    //    reads/writes on `customers`. `IF NOT EXISTS` makes a re-run after a
    //    partial failure safe.
    await q.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_customers_tenant_email" ON "customers" ("tenantId", "email")`,
    );

    // 2. Verify the index actually built successfully. A CONCURRENTLY build
    //    that fails partway (e.g. a duplicate found mid-build, or the
    //    connection dropped) leaves an INVALID index behind that silently
    //    enforces nothing — never assume success, confirm it.
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"UQ_customers_tenant_email"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        'M-01: "UQ_customers_tenant_email" was created but is NOT valid — a CONCURRENTLY build failed ' +
          'partway (likely a pre-existing duplicate (tenantId, email) pair). Investigate, drop the ' +
          'invalid index, resolve the underlying data, and re-run this migration. The old global ' +
          'constraint has deliberately NOT been dropped.',
      );
    }

    // 3. Only now drop the old global constraint — brief ACCESS EXCLUSIVE,
    //    unavoidable, but the new index is already valid and enforcing by
    //    this point, so there is no window with no uniqueness enforced at all.
    await q.query(
      `ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "UQ_8536b8b85c06969f84f0c098b03"`,
    );
  }

  /**
   * ASYMMETRIC ROLLBACK — NOT fully reversible, and never described as such.
   * Restoring global `UNIQUE (email)` fails outright once two tenants share
   * an email (exactly what this migration exists to allow). Rather than let
   * that fail opaquely, this pre-checks for conflicts and reports them.
   */
  public async down(q: QueryRunner): Promise<void> {
    const conflicts: { email: string; rows: string }[] = await q.query(
      `SELECT email, count(*)::text AS rows FROM "customers" GROUP BY email HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 50`,
    );
    if (conflicts.length > 0) {
      throw new Error(
        `M-01 rollback refused: ${conflicts.length} email(s) are now shared across tenants (e.g. ` +
          `"${conflicts[0].email}" × ${conflicts[0].rows} rows) — restoring UNIQUE (email) would fail. ` +
          'This is the documented asymmetry (data-model.md M-01): rollback is safe only BEFORE any ' +
          'cross-tenant duplicate exists. Resolve the conflicting rows manually before retrying.',
      );
    }

    await q.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "UQ_8536b8b85c06969f84f0c098b03" UNIQUE ("email")`,
    );
    await q.query(`DROP INDEX IF EXISTS "UQ_customers_tenant_email"`);
  }
}
