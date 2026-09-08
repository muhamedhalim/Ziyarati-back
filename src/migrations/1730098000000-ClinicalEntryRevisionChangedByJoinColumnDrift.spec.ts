import { ClinicalEntryRevisionChangedByJoinColumnDrift1730098000000 } from './1730098000000-ClinicalEntryRevisionChangedByJoinColumnDrift';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('ClinicalEntryRevisionChangedByJoinColumnDrift migration', () => {
  it("renames clinical_entry_revisions.changed_byId to changedById (TypeORM's actual naming-strategy output)", async () => {
    const sql = await sqlOf((q) =>
      new ClinicalEntryRevisionChangedByJoinColumnDrift1730098000000().up(
        q as never,
      ),
    );

    expect(sql).toContain(
      'ALTER TABLE "clinical_entry_revisions" RENAME COLUMN "changed_byId" TO "changedById"',
    );
  });

  it('asserts the correct column exists and the wrong one is gone (post-condition)', async () => {
    const sql = await sqlOf((q) =>
      new ClinicalEntryRevisionChangedByJoinColumnDrift1730098000000().up(
        q as never,
      ),
    );

    expect(sql).toContain(
      "WHERE table_name = 'clinical_entry_revisions' AND column_name = 'changedById'",
    );
    expect(sql).toContain('Migration post-condition failed');
  });

  it('down renames the column back to the broken name', async () => {
    const sql = await sqlOf((q) =>
      new ClinicalEntryRevisionChangedByJoinColumnDrift1730098000000().down(
        q as never,
      ),
    );

    expect(sql).toContain(
      'ALTER TABLE "clinical_entry_revisions" RENAME COLUMN "changedById" TO "changed_byId"',
    );
  });
});
