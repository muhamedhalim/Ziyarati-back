/**
 * The tenant-deletion plan (residency plan P11 — offboarding), DERIVED from the
 * schema rather than hand-listed.
 *
 * A hand-kept list of the 143 tenant-owned tables would rot the first time a
 * table is added; one missed table is either a foreign-key failure at the worst
 * moment or, worse, a clinic's data left behind after it was "deleted". So the
 * plan is computed from the entity metadata every time:
 *
 *  1. A table is OWNED DIRECTLY when it has a column that references `tenants`
 *     (or a plain `tenant_id` / `tenantId`). Predicate: `"col" = :tenant`.
 *  2. A table with no tenant column but a foreign key to an owned table is
 *     OWNED THROUGH that parent. Predicate: `"fk" IN (SELECT "pk" FROM parent
 *     WHERE <parent predicate>)`. Repeated to a fixed point.
 *  3. Owned tables are ordered CHILDREN FIRST by foreign-key dependency, so no
 *     delete is blocked by a row that has not been deleted yet. `tenants` is last.
 *
 * Everything not owned must be declared — either `GLOBAL_TABLES` (shared lookup
 * and catalogue data that belongs to no clinic) or `NOT_REACHED` (holds clinic
 * data this plan cannot locate, reported honestly in every evidence record).
 * `tenant-offboarding.plan.spec.ts` fails when a table is neither owned nor
 * declared, so a new table cannot be added without deciding where it stands.
 */

/** The slice of TypeORM's `EntityMetadata` the planner reads (kept minimal so it is easy to fake). */
export interface PlannerEntity {
  tableName: string;
  columns: Array<{ databaseName: string; isNullable: boolean }>;
  foreignKeys: Array<{
    columnNames: string[];
    referencedColumnNames: string[];
    referencedEntityMetadata: { tableName: string };
  }>;
}

export interface TenantDeletionStep {
  table: string;
  /** `WHERE` clause using `:tenant`. */
  predicate: string;
  /** `direct` (own tenant column) or the parent table the ownership is inherited through. */
  ownedBy: 'direct' | string;
}

/** Shared lookup / catalogue data: belongs to no clinic and is never deleted with one. */
export const GLOBAL_TABLES: ReadonlySet<string> = new Set([
  'countries',
  'cities',
  'currencies',
  'languages',
  'timezones',
  'specialties',
  'permissions',
  'subscription_plans',
  'feature_definitions',
  'feature_dependencies',
  'feature_plans',
  'system_settings',
]);

/**
 * Accountability records that carry a `tenant_id` but must OUTLIVE the tenant: the proof
 * that data was deleted, and the trail of data-subject requests. They have no foreign key to
 * `tenants` precisely so this plan can leave them alone — and they are excluded here by name
 * because a plain `tenant_id` column would otherwise make them look owned.
 */
export const RETAINED_PROOF_TABLES: ReadonlySet<string> = new Set([
  'deletion_evidence',
  'data_subject_requests',
]);

/** Tables that may hold a clinic's data but cannot be located by tenant. Reported, never silently skipped. */
export const NOT_REACHED: ReadonlyArray<{ table: string; reason: string }> = [
  {
    table: 'outbox_jobs',
    reason:
      'Side-effect outbox rows carry a payload, not a tenant column; completed rows age out and pending ones fail once their targets are gone.',
  },
  {
    table: 'usage_report_schedules',
    reason:
      'A platform-operator schedule (recipient emails), not clinic data; it is not keyed by tenant.',
  },
  {
    table: 'contact_leads',
    reason:
      'Website Contact Us enquiries from prospects who are not yet a clinic: no tenant exists to offboard, and the rows are handled and aged by the sales team.',
  },
  {
    table: 'patients',
    reason:
      'Marketplace patient accounts belong to the patient, not to a clinic; they are removed by the patient, not by clinic offboarding.',
  },
];

const TENANT_COLUMNS = new Set(['tenant_id', 'tenantId']);
const ROOT = 'tenants';

export function buildTenantDeletionPlan(
  entities: readonly PlannerEntity[],
): TenantDeletionStep[] {
  const byTable = new Map(entities.map((e) => [e.tableName, e]));
  const owned = new Map<
    string,
    { col: string; parent?: { table: string; parentPk: string } }
  >();

  for (const e of entities) {
    if (e.tableName === ROOT || RETAINED_PROOF_TABLES.has(e.tableName))
      continue;
    const fk = e.foreignKeys.find(
      (f) =>
        f.referencedEntityMetadata.tableName === ROOT &&
        f.columnNames.length === 1,
    );
    const col =
      fk?.columnNames[0] ??
      e.columns.find((c) => TENANT_COLUMNS.has(c.databaseName))?.databaseName;
    if (col) owned.set(e.tableName, { col });
  }

  // Inherit ownership through foreign keys until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of entities) {
      if (
        e.tableName === ROOT ||
        RETAINED_PROOF_TABLES.has(e.tableName) ||
        owned.has(e.tableName)
      )
        continue;
      const fk = e.foreignKeys.find(
        (f) =>
          f.columnNames.length === 1 &&
          owned.has(f.referencedEntityMetadata.tableName),
      );
      if (fk) {
        owned.set(e.tableName, {
          col: fk.columnNames[0],
          parent: {
            table: fk.referencedEntityMetadata.tableName,
            parentPk: fk.referencedColumnNames[0],
          },
        });
        changed = true;
      }
    }
  }

  const predicateOf = (table: string): string => {
    const o = owned.get(table)!;
    if (!o.parent) return `"${o.col}" = :tenant`;
    return `"${o.col}" IN (SELECT "${o.parent.parentPk}" FROM "${o.parent.table}" WHERE ${predicateOf(o.parent.table)})`;
  };

  // Children first: a table is deletable once every owned table that REFERENCES it is gone.
  const referencedBy = new Map<string, Set<string>>();
  for (const table of owned.keys()) referencedBy.set(table, new Set());
  for (const table of owned.keys()) {
    for (const fk of byTable.get(table)!.foreignKeys) {
      const parent = fk.referencedEntityMetadata.tableName;
      if (parent !== table && referencedBy.has(parent))
        referencedBy.get(parent)!.add(table);
    }
  }
  const remaining = new Set(owned.keys());
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) =>
      [...referencedBy.get(t)!].every((child) => !remaining.has(child)),
    );
    if (ready.length === 0) {
      throw new Error(
        `tenant-offboarding: foreign-key cycle among ${[...remaining].sort().join(', ')}`,
      );
    }
    for (const t of ready.sort()) {
      ordered.push(t);
      remaining.delete(t);
    }
  }

  const steps: TenantDeletionStep[] = ordered.map((table) => ({
    table,
    predicate: predicateOf(table),
    ownedBy: owned.get(table)!.parent?.table ?? 'direct',
  }));
  steps.push({ table: ROOT, predicate: `"id" = :tenant`, ownedBy: 'direct' });
  return steps;
}

/** Tables that are neither owned, global, nor declared — the set the spec requires to be empty. */
export function undeclaredTables(
  entities: readonly PlannerEntity[],
  plan: readonly TenantDeletionStep[],
): string[] {
  const covered = new Set(plan.map((s) => s.table));
  const declared = new Set([
    ...GLOBAL_TABLES,
    ...RETAINED_PROOF_TABLES,
    ...NOT_REACHED.map((n) => n.table),
  ]);
  return entities
    .map((e) => e.tableName)
    .filter((t) => !covered.has(t) && !declared.has(t));
}
