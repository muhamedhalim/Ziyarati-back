import type { PlannerEntity } from './tenant-offboarding.plan';

/** Anything with TypeORM's `query(sql)`; a `DataSource` or a `QueryRunner`. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * The schema as the DATABASE has it, shaped for `buildTenantDeletionPlan`.
 *
 * Deletion order must come from `pg_catalog`, not from the entity metadata:
 * foreign keys and whole tables created by raw-SQL migrations (e.g.
 * `api_logs.api_key_id -> api_keys`, the pgvector sidecar tables) exist in
 * PostgreSQL and block a DELETE whether or not an entity declares them. A plan
 * built from metadata missed `api_logs -> api_keys` — found by the real-database
 * test — and would have failed a real offboarding half-way (and rolled back).
 *
 * Only the `public` schema is read; `pg_catalog` / `information_schema` are not
 * tenant data.
 */
export async function loadPlannerSchema(
  db: Queryable,
): Promise<PlannerEntity[]> {
  const tables = (await db.query(
    `SELECT c.relname AS table_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
  )) as Array<{ table_name: string }>;

  const columns = (await db.query(
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns WHERE table_schema = 'public'`,
  )) as Array<{ table_name: string; column_name: string; is_nullable: string }>;

  const fks = (await db.query(
    `SELECT cl.relname AS table_name,
            fcl.relname AS referenced_table,
            array_agg(att.attname ORDER BY k.ord) AS columns,
            array_agg(fatt.attname ORDER BY k.ord) AS referenced_columns
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class fcl ON fcl.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(a, fa, ord)
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.a
       JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = k.fa
      WHERE con.contype = 'f' AND n.nspname = 'public'
      GROUP BY con.oid, cl.relname, fcl.relname`,
  )) as Array<{
    table_name: string;
    referenced_table: string;
    columns: string[];
    referenced_columns: string[];
  }>;

  const byTable = new Map<string, PlannerEntity>(
    tables.map((t) => [
      t.table_name,
      { tableName: t.table_name, columns: [], foreignKeys: [] },
    ]),
  );
  for (const c of columns) {
    byTable.get(c.table_name)?.columns.push({
      databaseName: c.column_name,
      isNullable: c.is_nullable === 'YES',
    });
  }
  for (const f of fks) {
    byTable.get(f.table_name)?.foreignKeys.push({
      columnNames: f.columns,
      referencedColumnNames: f.referenced_columns,
      referencedEntityMetadata: { tableName: f.referenced_table },
    });
  }
  return [...byTable.values()];
}
