import { slugify, uniqueSlug } from '../../common/utils/slugify.util';
import { StaffPublicSlug1730096000000 } from '../../migrations/1730096000000-StaffPublicSlug';

describe('slugify (Marketplace BE-2, T060)', () => {
  it('lowercases, kebab-cases, and strips punctuation from a Latin name', () => {
    expect(slugify('Dr. Ahmed Ali')).toBe('dr-ahmed-ali');
  });

  it('keeps an Arabic-only name legible instead of falling back (Unicode-aware)', () => {
    expect(slugify('د. خالد العتيبي')).toMatch(/[؀-ۿ]/);
    expect(slugify('د. خالد العتيبي')).not.toBe('doctor');
  });

  it('falls back to the given default when the input has no letters/digits at all', () => {
    expect(slugify('   ', 'doctor')).toBe('doctor');
    expect(slugify('', 'doctor')).toBe('doctor');
  });
});

describe('uniqueSlug (deterministic numeric disambiguation)', () => {
  it('returns the base slug when it is free', async () => {
    await expect(uniqueSlug('dr-ahmed-ali', () => false)).resolves.toBe(
      'dr-ahmed-ali',
    );
  });

  it('appends -2, -3, ... deterministically until a free candidate is found', async () => {
    const taken = new Set(['dr-ahmed-ali', 'dr-ahmed-ali-2', 'dr-ahmed-ali-3']);
    await expect(uniqueSlug('dr-ahmed-ali', (c) => taken.has(c))).resolves.toBe(
      'dr-ahmed-ali-4',
    );
  });
});

describe('StaffPublicSlug migration (backfill covers every existing row)', () => {
  function makeQueryMock(responses: Array<[RegExp, unknown]>) {
    return jest.fn(async (sql: string, _params: unknown[]) => {
      for (const [pattern, result] of responses) {
        if (pattern.test(sql)) return result;
      }
      return [];
    });
  }

  it('LEFT JOINs users so a staff_profiles row with no matching user still gets backfilled (not silently skipped)', async () => {
    const query = makeQueryMock([
      [/ADD COLUMN/, []],
      [
        /SELECT sp\.id, u\.full_name/,
        [
          { id: 'orphan-1', full_name: null }, // no matching user — LEFT JOIN, not JOIN
          { id: 'staff-2', full_name: 'Dr. Sara Ahmed' },
        ],
      ],
      [
        /SELECT "public_slug" FROM "staff_profiles" WHERE "public_slug" IS NOT NULL/,
        [],
      ],
      [/SELECT COUNT\(\*\)::int AS c/, [{ c: 0 }]],
    ]);
    await new StaffPublicSlug1730096000000().up({ query } as any);

    const statements = query.mock.calls.map(([s]) => s as string);
    expect(statements.some((s) => /LEFT JOIN "users"/.test(s))).toBe(true);

    const updates = query.mock.calls.filter(([s]) =>
      /UPDATE "staff_profiles" SET "public_slug"/.test(s),
    );
    expect(updates).toHaveLength(2);
    // The orphan (null full_name) still gets a slug — falls back to 'doctor', never left NULL.
    expect(
      updates.some(
        ([, params]) => params[0] === 'doctor' && params[1] === 'orphan-1',
      ),
    ).toBe(true);
    expect(
      updates.some(
        ([, params]) =>
          params[0] === 'dr-sara-ahmed' && params[1] === 'staff-2',
      ),
    ).toBe(true);
  });

  it('refuses to tighten the column if any row is still NULL after the backfill loop (never ships a partial state)', async () => {
    const query = makeQueryMock([
      [/ADD COLUMN/, []],
      [/SELECT sp\.id, u\.full_name/, []], // nothing to backfill this run
      [/SELECT COUNT\(\*\)::int AS c/, [{ c: 3 }]], // yet 3 rows are somehow still NULL
    ]);
    await expect(
      new StaffPublicSlug1730096000000().up({ query } as any),
    ).rejects.toThrow(
      /3 staff_profiles row\(s\) still have a NULL public_slug/,
    );

    const statements = query.mock.calls.map(([s]) => s as string);
    expect(
      statements.some((s) => /ALTER COLUMN "public_slug" SET NOT NULL/.test(s)),
    ).toBe(false);
  });

  it('down() drops the column, the NOT NULL, and the unique index', async () => {
    const query = makeQueryMock([]);
    await new StaffPublicSlug1730096000000().down({ query } as any);
    const statements = query.mock.calls.map(([s]) => s as string);
    expect(
      statements.some((s) =>
        /DROP INDEX IF EXISTS "public"\."UQ_staff_profiles_public_slug"/.test(
          s,
        ),
      ),
    ).toBe(true);
    expect(
      statements.some((s) => /DROP COLUMN IF EXISTS "public_slug"/.test(s)),
    ).toBe(true);
  });
});
