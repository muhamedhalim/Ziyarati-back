import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

/**
 * Seeds rows into a REAL migrated database without hand-writing every NOT NULL
 * column and every parent row.
 *
 * `make(table, overrides)` reads the table's required columns and foreign keys
 * from the live catalog, creates any missing parent rows (once per world, so
 * every row shares one tenant / user / branch unless overridden), and fills the
 * remaining required columns with unique, type-correct placeholders. A test then
 * states only the columns that matter to it.
 *
 * It is a test seam only: placeholders are not meaningful data, and a CHECK
 * constraint the placeholder violates is fixed by passing a real value.
 */
interface Col {
  name: string;
  udt: string;
  nullable: boolean;
  hasDefault: boolean;
  maxLen: number | null;
}

export class PgFactory {
  private cols = new Map<string, Col[]>();
  private fks = new Map<string, Map<string, string>>();
  private enums = new Map<string, string>();
  private counter = 0;

  constructor(private readonly ds: DataSource) {}

  async load(): Promise<void> {
    const cols: Array<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
    }> = await this.ds.query(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    );
    for (const c of cols) {
      const list = this.cols.get(c.table_name) ?? [];
      list.push({
        name: c.column_name,
        udt: c.udt_name,
        nullable: c.is_nullable === 'YES',
        hasDefault: c.column_default !== null,
        maxLen: c.character_maximum_length,
      });
      this.cols.set(c.table_name, list);
    }
    const fks: Array<{ tbl: string; col: string; ftbl: string }> =
      await this.ds.query(
        `SELECT cl.relname AS tbl, att.attname AS col, fcl.relname AS ftbl
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_class fcl ON fcl.oid = c.confrelid
         JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1`,
      );
    for (const f of fks) {
      const m = this.fks.get(f.tbl) ?? new Map<string, string>();
      m.set(f.col, f.ftbl);
      this.fks.set(f.tbl, m);
    }
    const labels: Array<{ typname: string; label: string }> =
      await this.ds.query(
        `SELECT t.typname, e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        ORDER BY t.typname, e.enumsortorder`,
      );
    for (const l of labels)
      if (!this.enums.has(l.typname)) this.enums.set(l.typname, l.label);
  }

  /** A fresh world: parents created on demand are shared within it. */
  world(opts: { connected?: boolean } = {}): World {
    return new World(this, opts.connected ?? false);
  }

  /** @internal */
  async insert(
    table: string,
    overrides: Record<string, unknown>,
    parents: Map<string, string>,
    stack: string[],
    sink: Array<{ table: string; id: string }> = [],
    connected = false,
  ): Promise<string> {
    const cols = this.cols.get(table);
    if (!cols) throw new Error(`pg-factory: unknown table ${table}`);
    const fk = this.fks.get(table) ?? new Map<string, string>();
    const row: Record<string, unknown> = { ...overrides };

    for (const c of cols) {
      if (c.name in row) continue;
      const parentTable = fk.get(c.name);
      // Plain tenant columns with no declared foreign key (e.g. `tenant_id uuid`) belong to the world's tenant too.
      // (Required ones too: several tables keep it as a plain varchar / uuid with no key.)
      if (
        !parentTable &&
        (c.name === 'tenant_id' || c.name === 'tenantId') &&
        parents.has('tenants') &&
        (connected || !c.nullable)
      ) {
        row[c.name] = parents.get('tenants');
        continue;
      }
      // `connected` worlds also fill OPTIONAL foreign keys, so rows form the realistic
      // tenant -> parent -> child chains that ownership is later derived from. A cycle of
      // optional keys is simply left null.
      if (
        connected &&
        c.nullable &&
        parentTable &&
        !stack.includes(parentTable) &&
        parentTable !== table
      ) {
        let id = parents.get(parentTable);
        if (!id) {
          id = await this.insert(
            parentTable,
            {},
            parents,
            [...stack, table],
            sink,
            connected,
          );
          parents.set(parentTable, id);
        }
        row[c.name] = id;
        continue;
      }
      if (c.nullable || c.hasDefault) continue;
      if (parentTable) {
        let id = parents.get(parentTable);
        if (!id) {
          if (stack.includes(parentTable))
            throw new Error(
              `pg-factory: cycle ${[...stack, parentTable].join(' -> ')}`,
            );
          id = await this.insert(
            parentTable,
            {},
            parents,
            [...stack, table],
            sink,
            connected,
          );
          parents.set(parentTable, id);
        }
        row[c.name] = id;
        continue;
      }
      row[c.name] = this.placeholder(c);
    }

    const names = Object.keys(row);
    const hasId = cols.some((c) => c.name === 'id');
    if (hasId && !('id' in row)) {
      row.id = randomUUID();
      names.push('id');
    }
    const text =
      `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) ` +
      `VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})` +
      (hasId ? ' RETURNING "id"' : '');
    const params = names.map((n) => {
      const v = row[n];
      return v !== null &&
        typeof v === 'object' &&
        !(v instanceof Date) &&
        !Buffer.isBuffer(v)
        ? JSON.stringify(v)
        : v;
    });
    const res = await this.ds.query(text, params);
    const id = hasId ? (res[0].id as string) : '';
    if (hasId) sink.push({ table, id });
    return id;
  }

  private placeholder(c: Col): unknown {
    this.counter += 1;
    const n = this.counter;
    const udt = c.udt;
    if (udt === 'uuid') return randomUUID();
    if (udt === 'varchar' || udt === 'text' || udt === 'bpchar') {
      const s = `x${n}`;
      return c.maxLen ? s.slice(0, c.maxLen) : s;
    }
    if (['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'].includes(udt))
      return 1;
    if (udt === 'bool') return false;
    if (udt === 'timestamptz' || udt === 'timestamp') return new Date();
    if (udt === 'date') return '2026-01-01';
    if (udt === 'time' || udt === 'timetz') return '09:00:00';
    if (udt === 'jsonb' || udt === 'json') return '{}';
    if (udt.startsWith('_')) return '{}';
    if (udt === 'bytea') return Buffer.from('x');
    const enumLabel = this.enums.get(udt);
    if (enumLabel !== undefined) return enumLabel;
    throw new Error(`pg-factory: no placeholder for type ${udt} (${c.name})`);
  }
}

export class World {
  private readonly parents = new Map<string, string>();
  /** Every row this world created — including auto-created parents — in creation order. */
  readonly created: Array<{ table: string; id: string }> = [];
  constructor(
    private readonly f: PgFactory,
    private readonly connected: boolean,
  ) {}

  /** Pin a parent row so later inserts reuse it (e.g. the tenant under test). */
  pin(table: string, id: string): void {
    this.parents.set(table, id);
  }

  async make(
    table: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = await this.f.insert(
      table,
      overrides,
      this.parents,
      [],
      this.created,
      this.connected,
    );
    if (!this.parents.has(table)) this.parents.set(table, id);
    return id;
  }

  get(table: string): string | undefined {
    return this.parents.get(table);
  }
}
