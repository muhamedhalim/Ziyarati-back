import {
  classifyTable,
  DATA_CLASSIFICATION,
  NEVER_EXTERNAL_BY_DEFAULT,
  tablesHolding,
} from './data-classification';
import { loadEntityMetadata } from './entity-metadata.test-util';

/**
 * Residency plan P16. The registry is only useful if it cannot silently fall
 * behind the schema, so it is checked against the real entity metadata.
 */
describe('data classification registry', () => {
  let tables: string[];

  beforeAll(async () => {
    tables = (await loadEntityMetadata()).map((m) => m.tableName);
  });

  it('classifies every table — a new entity must be given a class', () => {
    // Guards against a vacuous pass if the entity glob ever resolves to nothing.
    expect(tables.length).toBeGreaterThan(100);
    const unclassified = tables.filter((t) => !classifyTable(t));
    expect(unclassified).toEqual([]);
  });

  it('names no table that does not exist (no stale rows)', () => {
    const known = new Set(tables);
    expect(
      DATA_CLASSIFICATION.map((c) => c.table).filter((t) => !known.has(t)),
    ).toEqual([]);
  });

  it('has one row per table', () => {
    const names = DATA_CLASSIFICATION.map((c) => c.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every row a purpose', () => {
    expect(
      DATA_CLASSIFICATION.filter((c) => !c.purpose.trim()).map((c) => c.table),
    ).toEqual([]);
  });

  it('names a data subject for every table that can hold personal or health data', () => {
    const personal = DATA_CLASSIFICATION.filter((c) =>
      c.classes.some((k) => k === 'D2' || k === 'D3' || k === 'D4'),
    );
    expect(
      personal.filter((c) => c.subjects.length === 0).map((c) => c.table),
    ).toEqual([]);
  });

  it('puts the patient record in the strictest classes', () => {
    expect(classifyTable('customers')?.classes).toEqual(['D2', 'D3', 'D4']);
    expect(classifyTable('clinical_entries')?.classes).toContain('D4');
    expect(classifyTable('customer_profiles')?.classes).toContain('D4');
  });

  it('never classifies a credential-bearing table as less than D6', () => {
    for (const t of [
      'users',
      'refresh_tokens',
      'password_resets',
      'api_keys',
      'whatsapp_accounts',
    ]) {
      expect(classifyTable(t)?.classes).toContain('D6');
    }
  });

  it('exposes the lookup helpers', () => {
    expect(tablesHolding('D3')).toEqual(['customers']);
    expect(tablesHolding('D4')).toEqual(
      expect.arrayContaining(['clinical_entries', 'customer_files']),
    );
    expect(NEVER_EXTERNAL_BY_DEFAULT).toEqual(['D3', 'D4', 'D6']);
  });
});
