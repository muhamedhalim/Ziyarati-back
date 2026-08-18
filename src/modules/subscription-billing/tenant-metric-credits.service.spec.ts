import { DataSource, EntityManager } from 'typeorm';

import { TenantMetricCreditsService } from './tenant-metric-credits.service';
import { USAGE_METRIC } from './usage-metric';

const TENANT = 't1';

function creditRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    metric: USAGE_METRIC.AI_TOKENS,
    credited_units: '10000',
    debited_units: '3000',
    balance_units: '7000',
    updated_at: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * TypeORM's Postgres driver returns `[rows, affectedRowCount]` from
 * `.query()` for UPDATE/DELETE statements (even with RETURNING) — a
 * DIFFERENT shape than the plain `rows` array it returns for INSERT/SELECT.
 * Every mock below for an UPDATE-based method (tryDebit, settle,
 * refundReservation, revoke) must return that tuple shape, or the test
 * would pass against a service that silently reads `rows[0]` as the wrong
 * thing — exactly the bug this comment exists to prevent regressing (found
 * via a real-Postgres smoke test; the tuple-shaped mocks below are what
 * actually caught it once corrected). credit()/balanceMap() are
 * INSERT/SELECT and correctly use a plain array.
 */
function updateResult<T>(rows: T[], affected = rows.length): [T[], number] {
  return [rows, affected];
}

describe('TenantMetricCreditsService', () => {
  let query: jest.Mock;
  let dataSource: DataSource;
  let service: TenantMetricCreditsService;

  beforeEach(() => {
    query = jest.fn();
    dataSource = { query } as unknown as DataSource;
    service = new TenantMetricCreditsService(dataSource);
  });

  describe('tryDebit', () => {
    it('returns true and issues a guarded UPDATE when the balance covers the amount', async () => {
      query.mockResolvedValueOnce(updateResult([{ balance_units: '6000' }]));

      const ok = await service.tryDebit(TENANT, USAGE_METRIC.AI_TOKENS, 1000);

      expect(ok).toBe(true);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/UPDATE "tenant_metric_credits"/);
      expect(sql).toMatch(/balance_units >= \$3/);
      expect(params).toEqual([TENANT, USAGE_METRIC.AI_TOKENS, 1000]);
    });

    it('returns false when the WHERE clause matches no row (insufficient balance or no row at all)', async () => {
      query.mockResolvedValueOnce(updateResult([]));
      const ok = await service.tryDebit(TENANT, USAGE_METRIC.AI_TOKENS, 999_999);
      expect(ok).toBe(false);
    });

    it('correctly unwraps the [rows, affected] tuple rather than treating the tuple itself as the rows array', async () => {
      // If the tuple were NOT unwrapped, `rows.length` (the tuple's own
      // length, always 2) would be truthy regardless of whether the UPDATE
      // matched anything — this is the exact bug class this test guards.
      query.mockResolvedValueOnce(updateResult([], 0));
      const ok = await service.tryDebit(TENANT, USAGE_METRIC.AI_TOKENS, 1);
      expect(ok).toBe(false);
    });

    it('is a no-op returning true for amount <= 0, without querying', async () => {
      const ok = await service.tryDebit(TENANT, USAGE_METRIC.AI_TOKENS, 0);
      expect(ok).toBe(true);
      expect(query).not.toHaveBeenCalled();
    });

    it('uses the caller-supplied manager instead of the injected DataSource when given', async () => {
      const managerQuery = jest.fn().mockResolvedValueOnce(updateResult([{ balance_units: '1' }]));
      const manager = { query: managerQuery } as unknown as EntityManager;

      await service.tryDebit(TENANT, USAGE_METRIC.AI_TOKENS, 1, manager);

      expect(managerQuery).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('settle', () => {
    it('debits the full amount and reports zero overshoot when the balance is sufficient', async () => {
      query.mockResolvedValueOnce(updateResult([{ debited: '500', overshoot: '0' }]));

      const result = await service.settle(TENANT, USAGE_METRIC.AI_TOKENS, 500);

      expect(result).toEqual({ debitedUnits: 500, overshootUnits: 0 });
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/WITH before AS/);
      expect(sql).toMatch(/FOR UPDATE/);
      expect(params).toEqual([TENANT, USAGE_METRIC.AI_TOKENS, 500]);
    });

    it('floors at the available balance and reports the shortfall as overshoot', async () => {
      // balance was only 200, but 500 was requested
      query.mockResolvedValueOnce(updateResult([{ debited: '200', overshoot: '300' }]));

      const result = await service.settle(TENANT, USAGE_METRIC.AI_TOKENS, 500);

      expect(result).toEqual({ debitedUnits: 200, overshootUnits: 300 });
    });

    it('treats a missing row as total overshoot rather than throwing (tokens already spent with the provider)', async () => {
      query.mockResolvedValueOnce(updateResult([]));
      const result = await service.settle(TENANT, USAGE_METRIC.AI_TOKENS, 500);
      expect(result).toEqual({ debitedUnits: 0, overshootUnits: 500 });
    });

    it('is a no-op for amount <= 0, without querying', async () => {
      const result = await service.settle(TENANT, USAGE_METRIC.AI_TOKENS, 0);
      expect(result).toEqual({ debitedUnits: 0, overshootUnits: 0 });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('refundReservation', () => {
    it('gives back exactly what was reserved', async () => {
      query.mockResolvedValueOnce(updateResult([{ refunded: '1' }]));
      const refunded = await service.refundReservation(TENANT, USAGE_METRIC.AI_TOKENS, 1);
      expect(refunded).toBe(1);
      const [sql] = query.mock.calls[0];
      expect(sql).toMatch(/WITH before AS/);
      expect(sql).toMatch(/debited_units/);
    });

    it('is idempotent under a duplicate/late call — the second call refunds 0 once debited_units is already floored', async () => {
      // Simulated by the DB itself via LEAST(before.debited_units, $3); here we
      // assert the service just trusts and returns whatever the query reports.
      query.mockResolvedValueOnce(updateResult([{ refunded: '0' }]));
      const refunded = await service.refundReservation(TENANT, USAGE_METRIC.AI_TOKENS, 1);
      expect(refunded).toBe(0);
    });

    it('returns 0 when no row exists', async () => {
      query.mockResolvedValueOnce(updateResult([]));
      const refunded = await service.refundReservation(TENANT, USAGE_METRIC.AI_TOKENS, 1);
      expect(refunded).toBe(0);
    });

    it('is a no-op for amount <= 0, without querying', async () => {
      const refunded = await service.refundReservation(TENANT, USAGE_METRIC.AI_TOKENS, 0);
      expect(refunded).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('credit', () => {
    it('upserts via INSERT ... ON CONFLICT DO UPDATE and returns the new balance', async () => {
      // INSERT ... RETURNING: TypeORM returns the plain rows array, NOT a tuple.
      query.mockResolvedValueOnce([creditRow({ credited_units: '11000', balance_units: '8000' })]);

      const balance = await service.credit(TENANT, USAGE_METRIC.AI_TOKENS, 1000);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO "tenant_metric_credits"/);
      expect(sql).toMatch(/ON CONFLICT \("tenantId", metric\) DO UPDATE/);
      expect(params).toEqual([TENANT, USAGE_METRIC.AI_TOKENS, 1000]);
      expect(balance.creditedUnits).toBe(11000);
      expect(balance.balanceUnits).toBe(8000);
    });

    it('rejects amount <= 0 without querying', async () => {
      await expect(service.credit(TENANT, USAGE_METRIC.AI_TOKENS, 0)).rejects.toThrow(/amount must be > 0/);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('claws back the full amount when the balance covers it (unused purchase — plan §14)', async () => {
      query.mockResolvedValueOnce(updateResult([{ clawed_back: '1000', unrecoverable: '0' }]));

      const result = await service.revoke(TENANT, USAGE_METRIC.AI_TOKENS, 1000);

      expect(result).toEqual({ clawedBackUnits: 1000, unrecoverableUnits: 0 });
      const [sql] = query.mock.calls[0];
      expect(sql).toMatch(/credited_units = GREATEST/);
      expect(sql).toMatch(/balance_units = GREATEST/);
    });

    it('floors at 0 and reports the already-consumed portion as unrecoverable (partly used — plan §14)', async () => {
      // requested 1000, only 300 remained in the balance
      query.mockResolvedValueOnce(updateResult([{ clawed_back: '300', unrecoverable: '700' }]));

      const result = await service.revoke(TENANT, USAGE_METRIC.AI_TOKENS, 1000);

      expect(result).toEqual({ clawedBackUnits: 300, unrecoverableUnits: 700 });
    });

    it('reports total unrecoverable when fully used (balance already 0)', async () => {
      query.mockResolvedValueOnce(updateResult([{ clawed_back: '0', unrecoverable: '1000' }]));
      const result = await service.revoke(TENANT, USAGE_METRIC.AI_TOKENS, 1000);
      expect(result).toEqual({ clawedBackUnits: 0, unrecoverableUnits: 1000 });
    });

    it('treats a missing row as total unrecoverable', async () => {
      query.mockResolvedValueOnce(updateResult([]));
      const result = await service.revoke(TENANT, USAGE_METRIC.AI_TOKENS, 500);
      expect(result).toEqual({ clawedBackUnits: 0, unrecoverableUnits: 500 });
    });

    it('is a no-op for amount <= 0, without querying', async () => {
      const result = await service.revoke(TENANT, USAGE_METRIC.AI_TOKENS, 0);
      expect(result).toEqual({ clawedBackUnits: 0, unrecoverableUnits: 0 });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('balanceMap', () => {
    it('builds a Map<metric, CreditBalance> from every row for the tenant', async () => {
      // Plain SELECT: TypeORM returns the plain rows array, NOT a tuple.
      query.mockResolvedValueOnce([
        creditRow({ metric: USAGE_METRIC.AI_TOKENS }),
        creditRow({ metric: USAGE_METRIC.WHATSAPP_MESSAGES, credited_units: '50', debited_units: '10', balance_units: '40' }),
      ]);

      const map = await service.balanceMap(TENANT);

      expect(map.size).toBe(2);
      expect(map.get(USAGE_METRIC.AI_TOKENS)?.balanceUnits).toBe(7000);
      expect(map.get(USAGE_METRIC.WHATSAPP_MESSAGES)?.balanceUnits).toBe(40);
    });

    it('returns an empty map for a tenant with no credit rows', async () => {
      query.mockResolvedValueOnce([]);
      const map = await service.balanceMap(TENANT);
      expect(map.size).toBe(0);
    });
  });

  describe('reconciliation invariant', () => {
    it('balanceUnits always equals creditedUnits - debitedUnits on the mapped shape returned by credit()', async () => {
      query.mockResolvedValueOnce([creditRow({ credited_units: '10000', debited_units: '3000', balance_units: '7000' })]);
      const balance = await service.credit(TENANT, USAGE_METRIC.AI_TOKENS, 1000);
      expect(balance.balanceUnits).toBe(balance.creditedUnits - balance.debitedUnits);
    });
  });
});
