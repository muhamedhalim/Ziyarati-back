import { CustomerSegmentCreatedByJoinColumnDrift1730117000000 } from './1730117000000-CustomerSegmentCreatedByJoinColumnDrift';
import { CustomerSegment } from '../entities/CRM/CustomerSegment';
import { getMetadataArgsStorage } from 'typeorm';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('CustomerSegmentCreatedByJoinColumnDrift migration', () => {
  it("renames customer_segments.created_byId to createdById (TypeORM's actual naming-strategy output)", async () => {
    const sql = await sqlOf((q) =>
      new CustomerSegmentCreatedByJoinColumnDrift1730117000000().up(q as never),
    );

    expect(sql).toContain(
      'ALTER TABLE "customer_segments" RENAME COLUMN "created_byId" TO "createdById"',
    );
  });

  it('only renames when the wrong column exists AND the right one does not (safe on a synchronize-built DB)', async () => {
    const sql = await sqlOf((q) =>
      new CustomerSegmentCreatedByJoinColumnDrift1730117000000().up(q as never),
    );

    expect(sql).toMatch(
      /IF EXISTS \([\s\S]*column_name = 'created_byId'[\s\S]*\) AND NOT EXISTS \([\s\S]*column_name = 'createdById'/,
    );
  });

  it('asserts the correct column exists and the wrong one is gone (post-condition)', async () => {
    const sql = await sqlOf((q) =>
      new CustomerSegmentCreatedByJoinColumnDrift1730117000000().up(q as never),
    );

    expect(sql).toContain(
      "WHERE table_name = 'customer_segments' AND column_name = 'createdById'",
    );
    expect(sql).toContain('Migration post-condition failed');
  });

  it('down renames the column back to the broken name', async () => {
    const sql = await sqlOf((q) =>
      new CustomerSegmentCreatedByJoinColumnDrift1730117000000().down(
        q as never,
      ),
    );

    expect(sql).toContain(
      'ALTER TABLE "customer_segments" RENAME COLUMN "createdById" TO "created_byId"',
    );
  });

  it('targets the column the entity really maps to: created_by has no explicit @JoinColumn name', () => {
    const joinColumns = getMetadataArgsStorage().joinColumns.filter(
      (j) => j.target === CustomerSegment && j.propertyName === 'created_by',
    );
    // An explicit name here would make the rename above wrong — fail loudly.
    expect(joinColumns).toHaveLength(0);
  });
});
