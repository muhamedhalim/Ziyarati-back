import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SchemaGuardRegistry } from './schema-guard.registry';
import guardInventory from './schema-guards/critical-schema-guards.json';

/**
 * One row of the curated 43-guard contract (`critical-schema-guards.json`) —
 * the SAME file `test/integration/schema-contract.int-spec.ts` builds a
 * throwaway database against and `tests/load/reports/P0.3_PRODUCTION_VERIFICATION.sql`
 * was hand-derived from. One source, checked three different ways.
 */
export interface CriticalSchemaGuard {
  severity: 'P0' | 'P1';
  name: string;
  kind: 'index' | 'constraint';
  purpose: string;
  definition: string;
}

export const CRITICAL_SCHEMA_GUARDS: readonly CriticalSchemaGuard[] =
  guardInventory.guards as CriticalSchemaGuard[];

/** One row of `pg_indexes` / `pg_constraint`, before normalization. */
interface CatalogRow {
  name: string;
  kind: 'index' | 'constraint';
  def: string;
}

export type GuardVerdict =
  | { status: 'PASS' }
  | { status: 'ENFORCED_RENAMED'; actualName: string }
  | { status: 'MISMATCH'; actualDef: string }
  | { status: 'FAIL' };

/**
 * Collapses runs of whitespace to one space and trims — the exact
 * normalization `P0.3_PRODUCTION_VERIFICATION.sql` applies to both sides of
 * every comparison (`regexp_replace(def, '\s+', ' ', 'g')`), done here in JS
 * instead of SQL so it is one pure, directly-unit-testable function shared by
 * both the catalog row and the fixture's own `definition` string.
 */
export function normalizeDefinition(def: string): string {
  return def.replace(/\s+/g, ' ').trim();
}

/**
 * Strips an index's own name out of its definition, leaving only
 * uniqueness + table + columns + predicate. TypeORM's synchronizer renames
 * whatever index it recreates to `IDX_<28 hex>` (P0.2/P0.3, measured) — a
 * rename is not damage, so a name-only comparison would report a false
 * `FAIL` for an index that is fully enforcing the same rule under a
 * different name. Constraints have no equivalent fallback (matching the SQL
 * script's own scope): `pg_get_constraintdef` never includes a name to
 * strip, and there is no CREATE-style syntax to erase.
 */
export function indexShape(normalizedIndexDef: string): string {
  return normalizedIndexDef.replace(
    /CREATE (UNIQUE )?INDEX \S+ ON /,
    'CREATE $1INDEX ON ',
  );
}

/**
 * Compares one curated guard against the actual catalog. `actualByName` and
 * `shapeToName` are pre-built once per bootstrap pass (see
 * {@link SchemaGuardCatalogService}), so this function does no I/O and is
 * exercised directly in `schema-guard-catalog.service.spec.ts` with fixed
 * catalog snapshots — no database required.
 */
export function compareGuard(
  guard: CriticalSchemaGuard,
  actualByName: ReadonlyMap<string, { kind: string; def: string }>,
  shapeToName: ReadonlyMap<string, string>,
): GuardVerdict {
  const expectedDef = normalizeDefinition(guard.definition);
  const actual = actualByName.get(guard.name);

  if (actual && actual.kind === guard.kind && actual.def === expectedDef) {
    return { status: 'PASS' };
  }
  if (actual) {
    // Present under its own name, but the definition (or kind) differs —
    // NOT the rename case, which never has a same-name catalog hit.
    return { status: 'MISMATCH', actualDef: actual.def };
  }
  if (guard.kind === 'index') {
    const renamedTo = shapeToName.get(indexShape(expectedDef));
    if (renamedTo) return { status: 'ENFORCED_RENAMED', actualName: renamedTo };
  }
  return { status: 'FAIL' };
}

/**
 * Boot-time, read-only cross-check of the full 43-guard contract against
 * `pg_catalog` — closing the gap `SchemaGuardRegistry` cannot close on its
 * own (P04-001 / P0.5).
 *
 * WHY THIS EXISTS RATHER THAN EXTENDING THE SIX DOMAIN BOOTSTRAPS. Those
 * bootstraps (`PaymentsSchemaBootstrap` and siblings) each run
 * `CREATE ... IF NOT EXISTS` for the objects THEIR OWN module owns, and
 * together cover only 12 of the 43 curated guards — the other 31 (8 of them
 * P0) have no runtime check of any kind, including the case a hand-written
 * migration created an object no bootstrap ever mirrors. Adding a 7th,
 * 8th... Nth bootstrap per missing guard would mean touching production
 * DDL-issuing code repeatedly; this service touches none. It never runs
 * DDL — two `SELECT`s against `pg_indexes` / `pg_constraint`, read-only,
 * exactly the same catalog reads
 * `tests/load/reports/P0.3_PRODUCTION_VERIFICATION.sql` already proved safe.
 *
 * WHY IT REUSES `SchemaGuardRegistry.ensure()` RATHER THAN A NEW REGISTRY
 * METHOD. `ensure()` already does precisely what is needed here: run a
 * check, record `ok` on success and `failed` (with the operator-only detail)
 * on a thrown error. Extending the registry's own surface for this would add
 * API a reader has to learn for no behavioural gain — see the P0.5 phase
 * report for why this was checked before writing a new class.
 *
 * DOUBLE-COUNTING IS ACCEPTED, DELIBERATELY. The ~12 guards a domain
 * bootstrap already manages are checked AGAIN here, under a different owner
 * key (`schema-guard-catalog::<name>`) — so `SchemaGuardRegistry.summary()`
 * legitimately reports more "required" entries than 18. This is not waste:
 * a bootstrap's `CREATE UNIQUE INDEX IF NOT EXISTS` only proves ITS OWN
 * statement succeeded, which no-ops silently if an object with that name
 * already exists in ANY shape — it cannot detect "present but wrong
 * definition". This service's full-definition comparison can, and does.
 *
 * FAILS SOFT ON A CATALOG-QUERY ERROR — never a diagnostic that takes down
 * boot (same policy as `SchedulingIntegrityService`), and never records 43
 * bogus failures from one transient connectivity blip.
 *
 * NO PERIODIC RE-CHECK. `OnApplicationBootstrap` runs once, before Nest
 * starts accepting HTTP traffic, so the very first readiness probe already
 * sees this pass's result — there is no window where a request could race
 * it. A guard disappearing DURING a long-lived process's life (e.g. a manual
 * `DROP INDEX`) is an out-of-band operator action outside what an
 * automated, request-time-cheap readiness gate is for; P0.3 already closed
 * the one realistic in-process cause (`TYPEORM_SYNCHRONIZE=true` against a
 * migrated database refuses to boot at all). Adding a timer here was
 * considered and deliberately left out — see the P0.5 phase report.
 */
@Injectable()
export class SchemaGuardCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger('SchemaGuardCatalog');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly guards: SchemaGuardRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let rows: CatalogRow[];
    try {
      rows = await this.fetchCatalog();
    } catch (err) {
      this.logger.warn(
        `Could not read pg_catalog to verify the ${CRITICAL_SCHEMA_GUARDS.length}-guard ` +
          `contract: ${err instanceof Error ? err.message : String(err)}. Skipping this pass ` +
          `— never let a diagnostic take down boot.`,
      );
      return;
    }

    const actualByName = new Map<string, { kind: string; def: string }>();
    const shapeToName = new Map<string, string>();
    for (const row of rows) {
      const def = normalizeDefinition(row.def);
      actualByName.set(row.name, { kind: row.kind, def });
      if (row.kind === 'index') shapeToName.set(indexShape(def), row.name);
    }

    for (const guard of CRITICAL_SCHEMA_GUARDS) {
      const verdict = compareGuard(guard, actualByName, shapeToName);
      await this.guards.ensure({
        owner: 'schema-guard-catalog',
        label: guard.name,
        criticality: guard.severity === 'P0' ? 'required' : 'optional',
        run: () => this.verdictToOutcome(guard, verdict),
      });
    }
  }

  private async verdictToOutcome(
    guard: CriticalSchemaGuard,
    verdict: GuardVerdict,
  ): Promise<void> {
    switch (verdict.status) {
      case 'PASS':
        return;
      case 'ENFORCED_RENAMED':
        // Present and functionally identical — not a failure. Logged because
        // a hash-named object in a database that should never have
        // synchronized is itself worth an operator's attention (P0.3
        // REPAIR_RUNBOOK §1.3: never create the canonically-named index
        // alongside it).
        this.logger.warn(
          `Guard "${guard.name}" is enforced under a different name ` +
            `("${verdict.actualName}") — TypeORM's synchronizer renames what it ` +
            `recreates. The rule IS enforced; the naming means a synchronize boot ` +
            `touched this database at some point.`,
        );
        return;
      case 'MISMATCH':
        throw new Error(
          `guard "${guard.name}" (${guard.kind}) exists but its definition does not match ` +
            `the canonical contract. Expected: ${normalizeDefinition(guard.definition)} — ` +
            `actual: ${verdict.actualDef}`,
        );
      case 'FAIL':
        throw new Error(
          `guard "${guard.name}" (${guard.kind}, ${guard.severity}) — "${guard.purpose}" — ` +
            `not found in the public schema.`,
        );
    }
  }

  private async fetchCatalog(): Promise<CatalogRow[]> {
    return this.dataSource.query(`
      SELECT indexname AS name, 'index' AS kind, indexdef AS def
        FROM pg_indexes
       WHERE schemaname = 'public'
      UNION ALL
      SELECT c.conname AS name, 'constraint' AS kind, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
    `);
  }
}
