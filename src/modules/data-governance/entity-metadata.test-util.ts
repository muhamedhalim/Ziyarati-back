import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource, type EntityMetadata } from 'typeorm';

/**
 * The REAL TypeORM metadata for every entity, built without a database
 * connection — the same entity glob the application loads. Shared by the
 * data-governance specs so "is every table classified / covered by the erasure
 * plan" is checked against the schema as it is, not a hand-kept list.
 */
let cached: EntityMetadata[] | undefined;

export async function loadEntityMetadata(): Promise<EntityMetadata[]> {
  if (cached) return cached;
  const ds = new DataSource({
    type: 'postgres',
    entities: [join(__dirname, '..', '..', 'entities', '**', '!(*.spec).ts')],
  });
  // `buildMetadatas` is protected: it is the step `initialize()` runs before it
  // connects, and is exactly what is needed here.
  await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  cached = ds.entityMetadatas;
  return cached;
}

/** Tables with a foreign key to `customers`, with the FK column name(s). */
export async function customerForeignKeys(): Promise<
  Array<{ table: string; columns: string[] }>
> {
  const out: Array<{ table: string; columns: string[] }> = [];
  for (const m of await loadEntityMetadata()) {
    for (const fk of m.foreignKeys) {
      if (fk.referencedEntityMetadata.tableName === 'customers') {
        out.push({ table: m.tableName, columns: fk.columnNames });
      }
    }
  }
  return out;
}
