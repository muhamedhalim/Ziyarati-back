import { ClinicalRecords1730076000000 } from './1730076000000-ClinicalRecords';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query } as never);
  return query.mock.calls.map(([statement]) => statement as string);
};

describe('ClinicalRecords migration (T104)', () => {
  it('creates all four tables', async () => {
    const statements = await sqlOf((q) =>
      new ClinicalRecords1730076000000().up(q as never),
    );
    const joined = statements.join('\n');
    expect(joined).toContain('CREATE TABLE "clinical_encounters"');
    expect(joined).toContain('CREATE TABLE "clinical_entries"');
    expect(joined).toContain('CREATE TABLE "clinical_entry_revisions"');
    expect(joined).toContain('CREATE TABLE "clinical_access_logs"');
  });

  it('creates the clinical_entries kind enum with exactly the 5 FR-H002 kinds', async () => {
    const statements = await sqlOf((q) =>
      new ClinicalRecords1730076000000().up(q as never),
    );
    const enumStatement = statements.find((s) => s.includes('CREATE TYPE'));
    expect(enumStatement).toContain(
      "AS ENUM('NOTE', 'DIAGNOSIS', 'MEDICATION', 'ALLERGY', 'VITALS')",
    );
  });

  it('clinical_entries has a version column for optimistic locking (FR-H009)', async () => {
    const statements = await sqlOf((q) =>
      new ClinicalRecords1730076000000().up(q as never),
    );
    const entriesTable = statements.find((s) =>
      s.includes('CREATE TABLE "clinical_entries"'),
    );
    expect(entriesTable).toContain('"version" integer NOT NULL DEFAULT 1');
    expect(entriesTable).toContain('"deleted_at" timestamptz');
  });

  it('clinical_entry_revisions and clinical_access_logs carry no version/deleted_at — append-only, never edited or soft-deleted', async () => {
    const statements = await sqlOf((q) =>
      new ClinicalRecords1730076000000().up(q as never),
    );
    const revisions = statements.find((s) =>
      s.includes('CREATE TABLE "clinical_entry_revisions"'),
    );
    const accessLogs = statements.find((s) =>
      s.includes('CREATE TABLE "clinical_access_logs"'),
    );
    for (const table of [revisions, accessLogs]) {
      expect(table).not.toContain('"version"');
      expect(table).not.toContain('"deleted_at"');
    }
  });

  it('does not touch customers or customer_profiles (FR-H004 — no widening, no migrate-away)', async () => {
    const statements = await sqlOf((q) =>
      new ClinicalRecords1730076000000().up(q as never),
    );
    const joined = statements.join('\n');
    expect(joined).not.toMatch(/ALTER TABLE "customers"/);
    expect(joined).not.toMatch(/ALTER TABLE "customer_profiles"/);
  });

  it('down drops all four tables and the enum type, children first', async () => {
    const statements = await sqlOf((q) =>
      new ClinicalRecords1730076000000().down(q as never),
    );
    const dropOrder = statements.map((s) => s);
    expect(dropOrder[0]).toContain(
      'DROP TABLE IF EXISTS "clinical_access_logs"',
    );
    expect(dropOrder[1]).toContain(
      'DROP TABLE IF EXISTS "clinical_entry_revisions"',
    );
    expect(dropOrder[2]).toContain('DROP TABLE IF EXISTS "clinical_entries"');
    expect(dropOrder[3]).toContain('DROP TYPE IF EXISTS');
    expect(dropOrder[4]).toContain(
      'DROP TABLE IF EXISTS "clinical_encounters"',
    );
  });
});
