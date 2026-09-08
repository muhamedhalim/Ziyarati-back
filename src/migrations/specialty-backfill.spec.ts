import { MarketplaceSpecialtiesBackfill1730095000000 } from './1730095000000-MarketplaceSpecialtiesBackfill';

/** Routes each mocked query by matching a fragment of the SQL text. */
function makeQueryMock(responses: Array<[RegExp, unknown]> = []) {
  return jest.fn(async (sql: string) => {
    for (const [pattern, result] of responses) {
      if (pattern.test(sql)) return result;
    }
    return [];
  });
}

describe('MarketplaceSpecialtiesBackfill migration', () => {
  describe('up()', () => {
    it('matches services to a specialty by keyword, then derives clinic and doctor associations', async () => {
      const query = makeQueryMock();
      await new MarketplaceSpecialtiesBackfill1730095000000().up({
        query,
      } as any);
      const statements = query.mock.calls.map(([s]) => s as string);

      // Step 1: keyword-matches unclassified services only.
      expect(
        statements.some(
          (s) =>
            /UPDATE "services" s/.test(s) &&
            /"specialtyId" IS NULL/.test(s) &&
            /LOWER\(s\.name\) LIKE/.test(s),
        ),
      ).toBe(true);

      // Step 2: DERIVED clinic associations, ON CONFLICT DO NOTHING (never
      // overwrites an ASSERTED row already occupying the unique pair).
      expect(
        statements.some(
          (s) =>
            /INSERT INTO "tenant_specialties"/.test(s) &&
            /'DERIVED'/.test(s) &&
            /ON CONFLICT \("tenantId", "specialtyId"\) DO NOTHING/.test(s),
        ),
      ).toBe(true);

      // Step 3: DERIVED doctor associations via the existing staff_services link.
      expect(
        statements.some(
          (s) =>
            /INSERT INTO "staff_specialties"/.test(s) &&
            /JOIN "services" s ON s\.id = ss\."serviceId"/.test(s) &&
            /'DERIVED'/.test(s) &&
            /ON CONFLICT \("staffId", "specialtyId"\) DO NOTHING/.test(s),
        ),
      ).toBe(true);
    });

    it('never issues an UPDATE or INSERT that could overwrite an existing (non-NULL) specialtyId or an ASSERTED association', async () => {
      const query = makeQueryMock();
      await new MarketplaceSpecialtiesBackfill1730095000000().up({
        query,
      } as any);
      const statements = query.mock.calls.map(([s]) => s as string);

      // Every services UPDATE is guarded to NULL-only targets.
      const serviceUpdates = statements.filter((s) =>
        /UPDATE "services"/.test(s),
      );
      expect(serviceUpdates.length).toBeGreaterThan(0);
      expect(serviceUpdates.every((s) => /"specialtyId" IS NULL/.test(s))).toBe(
        true,
      );

      // Neither association INSERT ever names 'ASSERTED' as a value to write.
      const inserts = statements.filter((s) =>
        /INSERT INTO "(tenant|staff)_specialties"/.test(s),
      );
      expect(inserts.length).toBe(2);
      expect(inserts.every((s) => !/'ASSERTED'/.test(s))).toBe(true);
    });
  });

  describe('down()', () => {
    it('deletes only DERIVED association rows, never ASSERTED ones', async () => {
      const query = makeQueryMock();
      await new MarketplaceSpecialtiesBackfill1730095000000().down({
        query,
      } as any);
      const statements = query.mock.calls.map(([s]) => s as string);

      expect(
        statements.some(
          (s) =>
            /DELETE FROM "staff_specialties"/.test(s) &&
            /"provenance" = 'DERIVED'/.test(s),
        ),
      ).toBe(true);
      expect(
        statements.some(
          (s) =>
            /DELETE FROM "tenant_specialties"/.test(s) &&
            /"provenance" = 'DERIVED'/.test(s),
        ),
      ).toBe(true);
      // Neither DELETE is unconditional (a WHERE clause is always present).
      expect(
        statements
          .filter((s) => /DELETE FROM "(tenant|staff)_specialties"/.test(s))
          .every((s) => /WHERE/.test(s)),
      ).toBe(true);
    });
  });
});
