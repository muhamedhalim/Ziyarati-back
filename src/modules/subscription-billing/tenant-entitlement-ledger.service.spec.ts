import { DataSource, EntityManager } from 'typeorm';

import {
  TenantEntitlementLedgerService,
  LEDGER_REASON,
} from './tenant-entitlement-ledger.service';
import { SELLABLE_KIND } from '../resource-pricing/sellable-resource.registry';

const TENANT = 't1';

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ledger-1',
    tenantId: TENANT,
    metric: 'branches',
    kind: 'capacity',
    direction: 'grant',
    amount_units: '3',
    unrecoverable_units: '0',
    reason: 'purchase',
    sourcePurchaseId: 'purchase-1',
    sourceRefundId: null,
    actorId: null,
    note: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

describe('TenantEntitlementLedgerService', () => {
  let query: jest.Mock;
  let dataSource: DataSource;
  let service: TenantEntitlementLedgerService;

  beforeEach(() => {
    query = jest.fn();
    dataSource = { query } as unknown as DataSource;
    service = new TenantEntitlementLedgerService(dataSource);
  });

  describe('grant', () => {
    it('inserts a grant row and maps the returned row to a LedgerEntry', async () => {
      query.mockResolvedValueOnce([ledgerRow()]);

      const result = await service.grant({
        tenantId: TENANT,
        metric: 'branches',
        kind: SELLABLE_KIND.CAPACITY,
        amountUnits: 3,
        reason: LEDGER_REASON.PURCHASE,
        sourcePurchaseId: 'purchase-1',
      });

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO "tenant_entitlement_ledger"/);
      expect(sql).toMatch(/'grant'/);
      expect(params).toEqual([TENANT, 'branches', 'capacity', 3, 'purchase', 'purchase-1', null, null]);

      expect(result).toEqual({
        id: 'ledger-1',
        tenantId: TENANT,
        metric: 'branches',
        kind: 'capacity',
        direction: 'grant',
        amountUnits: 3,
        unrecoverableUnits: 0,
        reason: 'purchase',
        sourcePurchaseId: 'purchase-1',
        sourceRefundId: null,
        actorId: null,
        note: null,
        createdAt: new Date('2026-08-01T00:00:00Z'),
      });
    });

    it('rejects amountUnits <= 0 without querying the database', async () => {
      await expect(
        service.grant({
          tenantId: TENANT,
          metric: 'branches',
          kind: SELLABLE_KIND.CAPACITY,
          amountUnits: 0,
          reason: LEDGER_REASON.PURCHASE,
        }),
      ).rejects.toThrow(/amountUnits must be > 0/);
      expect(query).not.toHaveBeenCalled();
    });

    it('uses the caller-supplied manager instead of the injected DataSource when given', async () => {
      const managerQuery = jest.fn().mockResolvedValueOnce([ledgerRow()]);
      const manager = { query: managerQuery } as unknown as EntityManager;

      await service.grant({
        tenantId: TENANT,
        metric: 'branches',
        kind: SELLABLE_KIND.CAPACITY,
        amountUnits: 3,
        reason: LEDGER_REASON.PURCHASE,
        manager,
      });

      expect(managerQuery).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });

    it('propagates a unique-violation (23505) from a duplicate sourcePurchaseId rather than swallowing it', async () => {
      const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
      query.mockRejectedValueOnce(dup);

      await expect(
        service.grant({
          tenantId: TENANT,
          metric: 'branches',
          kind: SELLABLE_KIND.CAPACITY,
          amountUnits: 3,
          reason: LEDGER_REASON.PURCHASE,
          sourcePurchaseId: 'purchase-1',
        }),
      ).rejects.toBe(dup);
    });
  });

  describe('revoke', () => {
    it('inserts a revoke row with unrecoverable_units and maps the result', async () => {
      query.mockResolvedValueOnce([
        ledgerRow({ direction: 'revoke', unrecoverable_units: '1', reason: 'refund', sourcePurchaseId: null, sourceRefundId: 'refund-1' }),
      ]);

      const result = await service.revoke({
        tenantId: TENANT,
        metric: 'branches',
        kind: SELLABLE_KIND.CAPACITY,
        amountUnits: 3,
        unrecoverableUnits: 1,
        reason: LEDGER_REASON.REFUND,
        sourceRefundId: 'refund-1',
      });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/'revoke'/);
      expect(params).toEqual([TENANT, 'branches', 'capacity', 3, 1, 'refund', 'refund-1', null, null]);
      expect(result.direction).toBe('revoke');
      expect(result.unrecoverableUnits).toBe(1);
      expect(result.sourceRefundId).toBe('refund-1');
    });

    it('defaults unrecoverableUnits to 0 when omitted', async () => {
      query.mockResolvedValueOnce([ledgerRow({ direction: 'revoke' })]);

      await service.revoke({
        tenantId: TENANT,
        metric: 'branches',
        kind: SELLABLE_KIND.CAPACITY,
        amountUnits: 3,
        reason: LEDGER_REASON.REFUND,
      });

      const [, params] = query.mock.calls[0];
      expect(params[4]).toBe(0); // unrecoverable_units param
    });

    it('rejects amountUnits <= 0', async () => {
      await expect(
        service.revoke({
          tenantId: TENANT,
          metric: 'branches',
          kind: SELLABLE_KIND.CAPACITY,
          amountUnits: -1,
          reason: LEDGER_REASON.REFUND,
        }),
      ).rejects.toThrow(/amountUnits must be > 0/);
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects unrecoverableUnits greater than amountUnits — cannot un-recover more than was revoked', async () => {
      await expect(
        service.revoke({
          tenantId: TENANT,
          metric: 'branches',
          kind: SELLABLE_KIND.CAPACITY,
          amountUnits: 3,
          unrecoverableUnits: 4,
          reason: LEDGER_REASON.REFUND,
        }),
      ).rejects.toThrow(/unrecoverableUnits/);
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects a negative unrecoverableUnits', async () => {
      await expect(
        service.revoke({
          tenantId: TENANT,
          metric: 'branches',
          kind: SELLABLE_KIND.CAPACITY,
          amountUnits: 3,
          unrecoverableUnits: -1,
          reason: LEDGER_REASON.REFUND,
        }),
      ).rejects.toThrow(/unrecoverableUnits/);
    });

    it('propagates a unique-violation (23505) from a duplicate sourceRefundId', async () => {
      const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
      query.mockRejectedValueOnce(dup);

      await expect(
        service.revoke({
          tenantId: TENANT,
          metric: 'branches',
          kind: SELLABLE_KIND.CAPACITY,
          amountUnits: 3,
          reason: LEDGER_REASON.REFUND,
          sourceRefundId: 'refund-1',
        }),
      ).rejects.toBe(dup);
    });
  });

  describe('capacityMap', () => {
    it('builds a Map<metric, capacity> from the grouped rows, scoped to kind=capacity', async () => {
      query.mockResolvedValueOnce([
        { metric: 'branches', capacity: '4' },
        { metric: 'customers', capacity: '0' },
      ]);

      const map = await service.capacityMap(TENANT);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/kind = 'capacity'/);
      expect(sql).toMatch(/GREATEST\(SUM/);
      expect(params).toEqual([TENANT]);
      expect(map.get('branches')).toBe(4);
      expect(map.get('customers')).toBe(0);
      expect(map.size).toBe(2);
    });

    it('returns an empty map when the tenant has no capacity ledger rows', async () => {
      query.mockResolvedValueOnce([]);
      const map = await service.capacityMap(TENANT);
      expect(map.size).toBe(0);
    });
  });
});
