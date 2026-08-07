import { GlobalUserEmailUniqueness1730035000000 } from './1730035000000-GlobalUserEmailUniqueness';

/** Routes each mocked query by matching a fragment of the SQL text. */
function makeQueryMock(responses: Array<[RegExp, unknown]>) {
  return jest.fn(async (sql: string) => {
    for (const [pattern, result] of responses) {
      if (pattern.test(sql)) return result;
    }
    return [];
  });
}

describe('GlobalUserEmailUniqueness migration', () => {
  describe('up()', () => {
    it('happy path: normalizes, pre-flight passes, adds the CHECK, builds a valid index, then drops the old constraint', async () => {
      const query = makeQueryMock([
        [/GROUP BY "email"/, []], // no duplicates
        [/SELECT indisvalid/, [{ indisvalid: true }]],
      ]);
      await new GlobalUserEmailUniqueness1730035000000().up({ query } as any);
      const statements = query.mock.calls.map(([s]) => s as string);

      expect(
        statements.some((s) => /UPDATE "users" SET "email" = lower/.test(s)),
      ).toBe(true);
      expect(statements.some((s) => /GROUP BY "email"/.test(s))).toBe(true);
      expect(statements.some((s) => /ck_user_email_lowercase/.test(s))).toBe(
        true,
      );
      expect(
        statements.some((s) =>
          /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_user_email_global"/.test(
            s,
          ),
        ),
      ).toBe(true);
      expect(
        statements.some((s) =>
          /WHERE "deleted_at" IS NULL AND "email" IS NOT NULL/.test(s),
        ),
      ).toBe(true);
      expect(
        statements.some((s) =>
          /DROP CONSTRAINT IF EXISTS "UQ_7346b08032078107fce81e014f6"/.test(s),
        ),
      ).toBe(true);

      // Ordering: the old constraint must be dropped LAST, only after the
      // index-validity check has already run.
      const validityIdx = statements.findIndex((s) => /indisvalid/.test(s));
      const dropIdx = statements.findIndex((s) =>
        /DROP CONSTRAINT IF EXISTS "UQ_7346b08032078107fce81e014f6"/.test(s),
      );
      expect(dropIdx).toBeGreaterThan(validityIdx);
    });

    it('refuses to run when a pre-existing email is shared by more than one live user', async () => {
      const query = makeQueryMock([
        [/GROUP BY "email"/, [{ email: 'dup@example.com', rows: '2' }]],
      ]);
      await expect(
        new GlobalUserEmailUniqueness1730035000000().up({ query } as any),
      ).rejects.toThrow(/dup@example\.com/);

      // Must not have gone on to add the CHECK constraint or build the index.
      const statements = query.mock.calls.map(([s]) => s as string);
      expect(statements.some((s) => /ck_user_email_lowercase/.test(s))).toBe(
        false,
      );
      expect(statements.some((s) => /CREATE UNIQUE INDEX/.test(s))).toBe(false);
    });

    it('refuses and does NOT drop the old constraint when the CONCURRENTLY build produces an invalid index', async () => {
      const query = makeQueryMock([
        [/GROUP BY "email"/, []],
        [/SELECT indisvalid/, [{ indisvalid: false }]],
      ]);
      await expect(
        new GlobalUserEmailUniqueness1730035000000().up({ query } as any),
      ).rejects.toThrow(/NOT valid/);

      const statements = query.mock.calls.map(([s]) => s as string);
      expect(
        statements.some((s) =>
          /DROP CONSTRAINT IF EXISTS "UQ_7346b08032078107fce81e014f6"/.test(s),
        ),
      ).toBe(false);
    });

    it('is idempotent: a second up() run against an already-migrated schema issues no destructive statement twice (IF NOT EXISTS / IF EXISTS everywhere)', async () => {
      const query = makeQueryMock([
        [/GROUP BY "email"/, []],
        [/SELECT indisvalid/, [{ indisvalid: true }]],
      ]);
      await new GlobalUserEmailUniqueness1730035000000().up({ query } as any);
      const statements = query.mock.calls.map(([s]) => s as string);
      expect(
        statements.some((s) =>
          /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/.test(s),
        ),
      ).toBe(true);
      expect(statements.some((s) => /DROP CONSTRAINT IF EXISTS/.test(s))).toBe(
        true,
      );
    });

    it('disables the per-migration transaction wrapper (CONCURRENTLY cannot run inside a transaction block)', () => {
      expect(new GlobalUserEmailUniqueness1730035000000().transaction).toBe(
        false,
      );
    });
  });

  describe('down()', () => {
    it('restores the tenant-scoped constraint and drops the new index + CHECK when there is no conflict', async () => {
      const query = makeQueryMock([[/GROUP BY "tenantId", "email"/, []]]);
      await new GlobalUserEmailUniqueness1730035000000().down({ query } as any);
      const statements = query.mock.calls.map(([s]) => s as string);

      expect(
        statements.some((s) =>
          /ADD CONSTRAINT "UQ_7346b08032078107fce81e014f6" UNIQUE \("tenantId", "email"\)/.test(
            s,
          ),
        ),
      ).toBe(true);
      expect(
        statements.some((s) =>
          /DROP INDEX IF EXISTS "uq_user_email_global"/.test(s),
        ),
      ).toBe(true);
      expect(
        statements.some((s) =>
          /DROP CONSTRAINT IF EXISTS "ck_user_email_lowercase"/.test(s),
        ),
      ).toBe(true);
    });

    it('refuses when two live users in the SAME tenant now share an email (restoring the old constraint would fail)', async () => {
      const query = makeQueryMock([
        [
          /GROUP BY "tenantId", "email"/,
          [{ tenantId: 't-1', email: 'dup@example.com', rows: '2' }],
        ],
      ]);
      await expect(
        new GlobalUserEmailUniqueness1730035000000().down({ query } as any),
      ).rejects.toThrow(/rollback refused/);

      const statements = query.mock.calls.map(([s]) => s as string);
      expect(
        statements.some((s) =>
          /ADD CONSTRAINT "UQ_7346b08032078107fce81e014f6"/.test(s),
        ),
      ).toBe(false);
    });
  });
});
