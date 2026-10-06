import {
  buildTenantDeletionPlan,
  GLOBAL_TABLES,
  NOT_REACHED,
  undeclaredTables,
  type PlannerEntity,
} from './tenant-offboarding.plan';
import { loadEntityMetadata } from './entity-metadata.test-util';

/**
 * Residency plan P11 — the tenant-deletion plan is DERIVED from the schema, so
 * these tests run it on the real entity metadata and on small fakes that pin the
 * algorithm down (the statements run against PostgreSQL in
 * test/integration/tenant-offboarding.int-spec.ts).
 */
describe('tenant deletion plan — the real schema', () => {
  let entities: PlannerEntity[];
  beforeAll(async () => {
    entities = (await loadEntityMetadata()) as unknown as PlannerEntity[];
  });

  it('accounts for EVERY table: owned, declared global, or declared not-reached', () => {
    const plan = buildTenantDeletionPlan(entities);
    expect(plan.length).toBeGreaterThan(100); // not vacuous
    expect(undeclaredTables(entities, plan)).toEqual([]);
  });

  it('is acyclic and ends with the tenant row itself', () => {
    const plan = buildTenantDeletionPlan(entities); // throws on a cycle
    expect(plan[plan.length - 1]).toEqual({
      table: 'tenants',
      predicate: '"id" = :tenant',
      ownedBy: 'direct',
    });
    expect(new Set(plan.map((s) => s.table)).size).toBe(plan.length);
  });

  it('deletes every referencing (child) table before the table it references', () => {
    const plan = buildTenantDeletionPlan(entities);
    const pos = new Map(plan.map((s, i) => [s.table, i]));
    const violations: string[] = [];
    for (const e of entities) {
      if (!pos.has(e.tableName)) continue;
      for (const fk of e.foreignKeys) {
        const parent = fk.referencedEntityMetadata.tableName;
        if (
          parent !== e.tableName &&
          pos.has(parent) &&
          pos.get(e.tableName)! > pos.get(parent)!
        ) {
          violations.push(`${e.tableName} -> ${parent}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps every clinical, identity, financial and audit table in the plan', () => {
    const tables = new Set(
      buildTenantDeletionPlan(entities).map((s) => s.table),
    );
    for (const t of [
      'customers',
      'customer_profiles',
      'clinical_entries',
      'customer_files',
      'appointments',
      'invoices',
      'payments',
      'audit_logs',
      'clinical_access_logs',
      'users',
      'conversations',
      'messages',
      'ai_memories',
    ]) {
      expect(tables.has(t) ? t : `${t} MISSING`).toBe(t);
    }
  });

  it('never deletes shared lookup or catalogue data', () => {
    const tables = new Set(
      buildTenantDeletionPlan(entities).map((s) => s.table),
    );
    for (const g of GLOBAL_TABLES)
      expect(tables.has(g) ? `${g} in plan` : 'ok').toBe('ok');
  });

  it('never plans the governance proof tables — they must outlive the tenant', () => {
    const tables = new Set(
      buildTenantDeletionPlan(entities).map((s) => s.table),
    );
    expect(tables.has('deletion_evidence')).toBe(false);
    expect(tables.has('data_subject_requests')).toBe(false);
  });

  it('scopes every statement to the tenant, directly or through an owned parent', () => {
    for (const s of buildTenantDeletionPlan(entities))
      expect(s.predicate).toContain(':tenant');
  });

  it('declares what it cannot reach, with a reason', () => {
    expect(NOT_REACHED.length).toBeGreaterThan(0);
    for (const n of NOT_REACHED) expect(n.reason.length).toBeGreaterThan(20);
  });
});

describe('tenant deletion plan — the algorithm', () => {
  const ent = (
    tableName: string,
    cols: string[],
    fks: Array<[col: string, parent: string]> = [],
  ): PlannerEntity => ({
    tableName,
    columns: cols.map((databaseName) => ({ databaseName, isNullable: true })),
    foreignKeys: fks.map(([c, p]) => ({
      columnNames: [c],
      referencedColumnNames: ['id'],
      referencedEntityMetadata: { tableName: p },
    })),
  });

  it('owns a table directly through a tenant FK or a plain tenant column', () => {
    const plan = buildTenantDeletionPlan([
      ent('tenants', ['id']),
      ent('a', ['id', 'tenantId'], [['tenantId', 'tenants']]),
      ent('b', ['id', 'tenant_id']),
    ]);
    const by = Object.fromEntries(plan.map((s) => [s.table, s]));
    expect(by.a.predicate).toBe('"tenantId" = :tenant');
    expect(by.b.predicate).toBe('"tenant_id" = :tenant');
  });

  it('inherits ownership through a chain of parents and orders children first', () => {
    const plan = buildTenantDeletionPlan([
      ent('tenants', ['id']),
      ent('grandchild', ['id', 'childId'], [['childId', 'child']]),
      ent('child', ['id', 'parentId'], [['parentId', 'parent']]),
      ent('parent', ['id', 'tenantId'], [['tenantId', 'tenants']]),
    ]);
    expect(plan.map((s) => s.table)).toEqual([
      'grandchild',
      'child',
      'parent',
      'tenants',
    ]);
    expect(plan[0].predicate).toBe(
      `"childId" IN (SELECT "id" FROM "child" WHERE "parentId" IN (SELECT "id" FROM "parent" WHERE "tenantId" = :tenant))`,
    );
    expect(plan[0].ownedBy).toBe('child');
  });

  it('leaves a table with no path to the tenant out of the plan', () => {
    const entities = [
      ent('tenants', ['id']),
      ent('lookup', ['id']),
      ent('a', ['id', 'tenantId'], [['tenantId', 'tenants']]),
    ];
    const plan = buildTenantDeletionPlan(entities);
    expect(plan.map((s) => s.table)).not.toContain('lookup');
    expect(undeclaredTables(entities, plan)).toEqual(['lookup']);
  });

  it('refuses a foreign-key cycle rather than guessing an order', () => {
    expect(() =>
      buildTenantDeletionPlan([
        ent('tenants', ['id']),
        ent(
          'x',
          ['id', 'tenantId', 'yId'],
          [
            ['tenantId', 'tenants'],
            ['yId', 'y'],
          ],
        ),
        ent(
          'y',
          ['id', 'tenantId', 'xId'],
          [
            ['tenantId', 'tenants'],
            ['xId', 'x'],
          ],
        ),
      ]),
    ).toThrow(/cycle/);
  });

  it('tolerates a self-reference (e.g. a parent_id column)', () => {
    const plan = buildTenantDeletionPlan([
      ent('tenants', ['id']),
      ent(
        'node',
        ['id', 'tenantId', 'parentId'],
        [
          ['tenantId', 'tenants'],
          ['parentId', 'node'],
        ],
      ),
    ]);
    expect(plan.map((s) => s.table)).toEqual(['node', 'tenants']);
  });
});
