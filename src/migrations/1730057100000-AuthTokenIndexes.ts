import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AUTH-006 remediation — the authentication token tables carried NO index
 * beyond their primary key, on tables that grow monotonically (AUTH-005).
 * Measured before this migration (docs/AUTH_CONCURRENCY_GC_AUDIT.md §9):
 *
 *   EXPLAIN UPDATE refresh_tokens SET revoked_at = now()
 *            WHERE "userId" = $1 AND revoked_at IS NULL;
 *    ->  Seq Scan on refresh_tokens ... Rows Removed by Filter: 822
 *
 * That statement runs on every logout-all, password change and password reset
 * — and, pre-fix, on every reuse detection, which an unauthenticated caller
 * could trigger at will (AUTH-003). The indexes below turn each of the four
 * hot predicates into an index scan and, critically, make the retention sweep
 * (`AuthTokenMaintenanceService`) possible without a full-table scan holding
 * write locks. The index MUST exist before the sweep ships — hence this
 * migration precedes it.
 *
 * PRODUCTION LOCK RISK: all four use `CREATE INDEX CONCURRENTLY` so no
 * `ACCESS EXCLUSIVE` lock is taken on a live table. `CONCURRENTLY` cannot run
 * inside a transaction block, so `transaction = false` disables TypeORM's
 * per-migration wrapper FOR THIS MIGRATION ONLY (every other migration keeps
 * `migrationsTransactionMode: 'each'`). This mirrors the pattern already
 * proven in `CustomerTenantScopedEmail1730019000000`, including the
 * post-build validity check: a CONCURRENTLY build that fails partway leaves
 * an INVALID index that silently does nothing, so success is confirmed rather
 * than assumed.
 */
export class AuthTokenIndexes1730057100000 implements MigrationInterface {
  name = 'AuthTokenIndexes1730057100000';
  public transaction = false;

  /** Partial where the predicate allows it — the dead rows are the majority (83% at audit time). */
  private static readonly INDEXES: Array<{
    name: string;
    ddl: string;
    why: string;
  }> = [
    {
      name: 'idx_refresh_tokens_user_active',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_refresh_tokens_user_active"
              ON "refresh_tokens" ("userId") WHERE "revoked_at" IS NULL`,
      why: 'revokeAllForUser — logout-all, password change, password reset',
    },
    {
      name: 'idx_refresh_tokens_family_active',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_refresh_tokens_family_active"
              ON "refresh_tokens" ("family_id") WHERE "revoked_at" IS NULL`,
      why: 'revokeFamily — the AUTH-002 family-scoped reuse response',
    },
    {
      name: 'idx_refresh_tokens_expires_at',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_refresh_tokens_expires_at"
              ON "refresh_tokens" ("expires_at")`,
      why: 'retention sweep — DELETE WHERE expires_at < cutoff',
    },
    {
      name: 'idx_password_resets_expires_at',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_password_resets_expires_at"
              ON "password_resets" ("expires_at")`,
      why: 'retention sweep — password_resets had the same unbounded growth',
    },
    {
      name: 'idx_password_resets_token_hash',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_password_resets_token_hash"
              ON "password_resets" ("token_hash")`,
      why: 'resetPassword lookup — was a Seq Scan on every reset attempt',
    },
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const index of AuthTokenIndexes1730057100000.INDEXES) {
      await q.query(index.ddl);

      // Never assume a CONCURRENTLY build succeeded — an invalid index
      // enforces and accelerates nothing while looking present.
      const [row] = (await q.query(
        `SELECT indisvalid FROM pg_index WHERE indexrelid = '"${index.name}"'::regclass`,
      )) as Array<{ indisvalid: boolean } | undefined>;
      if (!row?.indisvalid) {
        throw new Error(
          `AUTH-006: "${index.name}" (${index.why}) was created but is NOT valid — the ` +
            `CONCURRENTLY build failed partway. Drop the invalid index, investigate, and re-run.`,
        );
      }
    }
  }

  /**
   * Plain `DROP INDEX`, deliberately NOT `CONCURRENTLY`.
   *
   * `transaction = false` above is honoured on the forward path but NOT by
   * TypeORM's revert path, which wraps `down()` in a transaction regardless —
   * so `DROP INDEX CONCURRENTLY` fails there with "cannot run inside a
   * transaction block" and the rollback is unusable. Verified directly against
   * a scratch database rather than assumed.
   *
   * The asymmetry is also correct on its own merits: CREATE has to scan every
   * row, which is what makes CONCURRENTLY worth its cost; DROP only unlinks
   * metadata, so its brief ACCESS EXCLUSIVE lock is measured in milliseconds
   * and is acceptable on an exceptional rollback path.
   */
  public async down(q: QueryRunner): Promise<void> {
    for (const index of AuthTokenIndexes1730057100000.INDEXES) {
      await q.query(`DROP INDEX IF EXISTS "${index.name}"`);
    }
  }
}
