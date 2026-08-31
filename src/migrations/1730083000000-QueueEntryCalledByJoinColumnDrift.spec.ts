import { QueueEntryCalledByJoinColumnDrift1730083000000 } from './1730083000000-QueueEntryCalledByJoinColumnDrift';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('QueueEntryCalledByJoinColumnDrift migration', () => {
  it("renames queue_entries.called_byId to calledById (TypeORM's actual naming-strategy output)", async () => {
    const sql = await sqlOf((q) =>
      new QueueEntryCalledByJoinColumnDrift1730083000000().up(q as never),
    );

    expect(sql).toContain(
      'ALTER TABLE "queue_entries" RENAME COLUMN "called_byId" TO "calledById"',
    );
  });

  it('asserts the correct column exists and the wrong one is gone (post-condition)', async () => {
    const sql = await sqlOf((q) =>
      new QueueEntryCalledByJoinColumnDrift1730083000000().up(q as never),
    );

    expect(sql).toContain(
      "WHERE table_name = 'queue_entries' AND column_name = 'calledById'",
    );
    expect(sql).toContain('Migration post-condition failed');
  });

  it('down renames the column back to the broken name', async () => {
    const sql = await sqlOf((q) =>
      new QueueEntryCalledByJoinColumnDrift1730083000000().down(q as never),
    );

    expect(sql).toContain(
      'ALTER TABLE "queue_entries" RENAME COLUMN "calledById" TO "called_byId"',
    );
  });
});
