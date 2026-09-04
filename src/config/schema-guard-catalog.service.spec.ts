import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  CRITICAL_SCHEMA_GUARDS,
  SchemaGuardCatalogService,
  compareGuard,
  indexShape,
  normalizeDefinition,
} from './schema-guard-catalog.service';
import { SchemaGuardRegistry } from './schema-guard.registry';

/**
 * P0.5 / P04-001. `SchemaGuardRegistry` only ever recorded what a bootstrap
 * ATTEMPTED (12 of the 43 curated guards, and one of those 12 —
 * `uq_ai_tool_call_idem`, a P0 — misclassified `optional`). These tests pin
 * the two properties that close that gap: every one of the 43 guards is
 * checked against the real catalog, using the SAME fixture the schema
 * contract integration test and the production SQL script use, and a
 * missing/wrong P0 guard degrades the registry's summary — the object
 * `HealthController.readiness()` actually reads.
 */
describe('normalizeDefinition', () => {
  it('collapses runs of whitespace, including newlines, to one space and trims', () => {
    expect(normalizeDefinition('  CREATE   UNIQUE\nINDEX  foo  ')).toBe(
      'CREATE UNIQUE INDEX foo',
    );
  });
});

describe('indexShape', () => {
  it('strips a unique index name, leaving the rest intact', () => {
    expect(
      indexShape(
        'CREATE UNIQUE INDEX uq_refund_idem ON public.refunds USING btree (idempotency_key)',
      ),
    ).toBe(
      'CREATE UNIQUE INDEX ON public.refunds USING btree (idempotency_key)',
    );
  });

  it('strips a plain (non-unique) index name', () => {
    expect(
      indexShape('CREATE INDEX idx_foo ON public.bar USING btree (baz)'),
    ).toBe('CREATE INDEX ON public.bar USING btree (baz)');
  });
});

describe('compareGuard', () => {
  const guard = {
    severity: 'P0' as const,
    name: 'uq_example',
    kind: 'index' as const,
    purpose: 'example',
    definition:
      'CREATE UNIQUE INDEX uq_example ON public.things USING btree (a, b)',
  };

  it('PASS — same name, same kind, identical normalized definition', () => {
    const actual = new Map([
      [
        'uq_example',
        { kind: 'index', def: normalizeDefinition(guard.definition) },
      ],
    ]);
    expect(compareGuard(guard, actual, new Map())).toEqual({ status: 'PASS' });
  });

  it('MISMATCH — present under its own name but a different definition', () => {
    const actual = new Map([
      [
        'uq_example',
        {
          kind: 'index',
          def: 'CREATE UNIQUE INDEX uq_example ON public.things USING btree (a)',
        },
      ],
    ]);
    const verdict = compareGuard(guard, actual, new Map());
    expect(verdict.status).toBe('MISMATCH');
  });

  it('ENFORCED_RENAMED — absent under its own name, but the same shape exists under a hash name (TypeORM synchronize rename)', () => {
    const shape = indexShape(normalizeDefinition(guard.definition));
    const shapeToName = new Map([[shape, 'IDX_deadbeef0123456789abcdef01']]);
    const verdict = compareGuard(guard, new Map(), shapeToName);
    expect(verdict).toEqual({
      status: 'ENFORCED_RENAMED',
      actualName: 'IDX_deadbeef0123456789abcdef01',
    });
  });

  it('FAIL — absent under its own name and no shape match', () => {
    expect(compareGuard(guard, new Map(), new Map())).toEqual({
      status: 'FAIL',
    });
  });

  it('a constraint guard gets no shape fallback — matches the SQL script it mirrors', () => {
    const constraintGuard = { ...guard, kind: 'constraint' as const };
    // Even with a matching shape entry present, constraints never consult it.
    const shapeToName = new Map([
      [indexShape(normalizeDefinition(guard.definition)), 'some_other_name'],
    ]);
    expect(compareGuard(constraintGuard, new Map(), shapeToName)).toEqual({
      status: 'FAIL',
    });
  });
});

describe('the curated fixture', () => {
  it('has 43 entries — 18 P0, 25 P1 (P0.4 count)', () => {
    expect(CRITICAL_SCHEMA_GUARDS).toHaveLength(43);
    expect(
      CRITICAL_SCHEMA_GUARDS.filter((g) => g.severity === 'P0'),
    ).toHaveLength(18);
    expect(
      CRITICAL_SCHEMA_GUARDS.filter((g) => g.severity === 'P1'),
    ).toHaveLength(25);
  });
});

describe('SchemaGuardCatalogService', () => {
  let registry: SchemaGuardRegistry;
  let dataSource: { query: jest.Mock };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    registry = new SchemaGuardRegistry();
    dataSource = { query: jest.fn() };
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** One catalog row per fixture entry, echoing its own name/kind/definition
   *  back verbatim — a database that exactly matches the canonical contract. */
  function catalogRowsMatchingEveryGuard() {
    return CRITICAL_SCHEMA_GUARDS.map((g) => ({
      name: g.name,
      kind: g.kind,
      def: g.definition,
    }));
  }

  function service() {
    return new SchemaGuardCatalogService(
      dataSource as unknown as DataSource,
      registry,
    );
  }

  it('all 43 guards PASS on a catalog that matches the contract exactly — required, none failed', async () => {
    dataSource.query.mockResolvedValueOnce(catalogRowsMatchingEveryGuard());

    await service().onApplicationBootstrap();

    const summary = registry.summary();
    expect(summary.requiredChecked).toBe(18); // the 18 P0 guards
    expect(summary.requiredFailed).toBe(0);
    expect(summary.status).toBe('ok');
  });

  it('a missing P0 guard degrades the registry summary', async () => {
    const rows = catalogRowsMatchingEveryGuard().filter(
      (r) => r.name !== 'uq_user_email_global', // a P0 guard
    );
    dataSource.query.mockResolvedValueOnce(rows);

    await service().onApplicationBootstrap();

    const summary = registry.summary();
    expect(summary.status).toBe('degraded');
    expect(summary.requiredFailed).toBe(1);
  });

  it('a missing P1 guard does NOT degrade the registry summary (optional)', async () => {
    const rows = catalogRowsMatchingEveryGuard().filter(
      (r) => r.name !== 'UQ_email_logs_idempotency', // a P1 guard
    );
    dataSource.query.mockResolvedValueOnce(rows);

    await service().onApplicationBootstrap();

    expect(registry.summary().status).toBe('ok');
    expect(registry.summary().requiredFailed).toBe(0);
  });

  it('a P0 index guard renamed to an IDX_<hash> name is NOT a failure, and logs a warn', async () => {
    const target = CRITICAL_SCHEMA_GUARDS.find(
      (g) => g.severity === 'P0' && g.kind === 'index',
    )!;
    const rows = catalogRowsMatchingEveryGuard().map((r) =>
      r.name === target.name
        ? { ...r, name: 'IDX_0123456789abcdef0123456789' }
        : r,
    );
    dataSource.query.mockResolvedValueOnce(rows);

    await service().onApplicationBootstrap();

    expect(registry.summary().requiredFailed).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `Guard "${target.name}" is enforced under a different name`,
      ),
    );
  });

  it('never throws and records nothing when the catalog query itself fails (never a diagnostic that blocks boot)', async () => {
    dataSource.query.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service().onApplicationBootstrap()).resolves.toBeUndefined();
    expect(registry.summary().requiredChecked).toBe(0);
  });

  it('never leaks a guard name or table into the registry summary, only counts (readiness stays public-safe)', async () => {
    const rows = catalogRowsMatchingEveryGuard().filter(
      (r) => r.name !== 'uq_refund_idem',
    );
    dataSource.query.mockResolvedValueOnce(rows);

    await service().onApplicationBootstrap();

    const summary = registry.summary();
    expect(JSON.stringify(summary)).not.toMatch(/refund|idem|refunds/i);
  });

  it('issues exactly one catalog query per boot pass (readiness stays request-cheap — the check runs once at boot, not per request)', async () => {
    dataSource.query.mockResolvedValueOnce(catalogRowsMatchingEveryGuard());

    await service().onApplicationBootstrap();

    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });
});
