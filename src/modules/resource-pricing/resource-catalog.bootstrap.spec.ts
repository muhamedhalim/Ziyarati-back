import { ResourceCatalogBootstrap } from './resource-catalog.bootstrap';
import { SELLABLE_RESOURCE_REGISTRY } from './sellable-resource.registry';

describe('ResourceCatalogBootstrap (Phase 2.1 — mirrors FeatureCatalogBootstrap)', () => {
  let catalog: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let bootstrap: ResourceCatalogBootstrap;

  beforeEach(() => {
    catalog = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (e: any) => e),
      create: jest.fn((d: any) => d),
    };
    bootstrap = new ResourceCatalogBootstrap(catalog as never);
  });

  describe('syncCatalog — from empty', () => {
    it('creates one row per registry item, with safe defaults (unpriced, inactive)', async () => {
      const result = await bootstrap.syncCatalog();

      expect(result.created).toBe(SELLABLE_RESOURCE_REGISTRY.length);
      expect(result.refreshed).toBe(0);
      expect(catalog.save).toHaveBeenCalledTimes(SELLABLE_RESOURCE_REGISTRY.length);
      for (const call of catalog.create.mock.calls) {
        const row = call[0];
        expect(row.unit_price_minor).toBe('0');
        expect(row.is_active).toBe(false);
        expect(row.min_quantity).toBe(1);
      }
    });

    it('every created row\'s code-owned fields match the registry entry exactly', async () => {
      await bootstrap.syncCatalog();
      const aiTokens = catalog.create.mock.calls
        .map((c: any[]) => c[0])
        .find((r: any) => r.item_key === 'AI_TOKENS');
      expect(aiTokens).toMatchObject({ kind: 'credit', unit_label: 'tokens_1k', unit_size: '1000' });
    });
  });

  describe('syncCatalog — idempotent re-run against existing rows', () => {
    it('creates and refreshes NOTHING on a second run with no registry drift (true steady state)', async () => {
      // Every item already exists with code-owned fields matching the
      // registry exactly — the genuinely idempotent, nothing-to-do case.
      const steadyStateByKey = new Map(
        SELLABLE_RESOURCE_REGISTRY.map((spec) => [
          spec.itemKey,
          {
            item_key: spec.itemKey,
            kind: spec.kind,
            unit_label: spec.unitLabel,
            unit_size: String(spec.unitSize),
            is_active: false,
          },
        ]),
      );
      catalog.findOne.mockImplementation(async (opts: any) =>
        steadyStateByKey.get(opts.where.item_key) ?? null,
      );

      const result = await bootstrap.syncCatalog();

      expect(result.created).toBe(0);
      expect(result.refreshed).toBe(0);
      expect(result.deactivated).toBe(0);
      expect(catalog.save).not.toHaveBeenCalled();
    });

    it('NEVER resets unit_price_minor, is_active, min/max_quantity, sort_order, or currency on an existing row', async () => {
      const adminConfigured = {
        item_key: 'branches',
        kind: 'capacity',
        unit_label: 'branch',
        unit_size: '1',
        unit_price_minor: '9999',
        is_active: true,
        min_quantity: 5,
        max_quantity: 50,
        sort_order: 7,
        currency: 'USD',
      };
      // Filtered by the query's own item_key — a fresh DB row per key, not
      // one shared mutable object reused (and mutated) across every
      // registry item in the loop.
      catalog.findOne.mockImplementation(async (opts: any) =>
        opts.where.item_key === 'branches' ? { ...adminConfigured } : null,
      );

      await bootstrap.syncCatalog();

      // The service never even READS these fields for a no-drift row — since
      // code-owned fields (kind/unit_label/unit_size) already match, save()
      // is never called for that row, so nothing could have been reset.
      const savedBranchesCalls = catalog.save.mock.calls.filter(
        (c: any[]) => c[0]?.item_key === 'branches',
      );
      expect(savedBranchesCalls).toHaveLength(0);
    });

    it('refreshes ONLY the code-owned fields when they drift, leaving admin fields untouched', async () => {
      const existing = {
        item_key: 'branches',
        kind: 'capacity',
        unit_label: 'STALE LABEL',
        unit_size: '1',
        unit_price_minor: '9999',
        is_active: true,
        min_quantity: 5,
        sort_order: 7,
      };
      catalog.findOne.mockImplementation(async (opts: any) =>
        opts.where.item_key === 'branches' ? { ...existing } : null,
      );

      await bootstrap.syncCatalog();

      const saved = catalog.save.mock.calls
        .map((c: any[]) => c[0])
        .find((r: any) => r.item_key === 'branches');
      expect(saved.unit_label).toBe('branch'); // refreshed to match the registry
      expect(saved.unit_price_minor).toBe('9999'); // admin-owned, untouched
      expect(saved.is_active).toBe(true); // admin-owned, untouched (unit_size did not change)
      expect(saved.min_quantity).toBe(5);
      expect(saved.sort_order).toBe(7);
    });
  });

  describe('unit_size change — force-deactivate safety rule', () => {
    it('deactivates an ACTIVE item when its unit_size drifts from the registry', async () => {
      catalog.findOne.mockImplementation(async (opts: any) =>
        opts.where.item_key === 'branches'
          ? {
              item_key: 'branches',
              kind: 'capacity',
              unit_label: 'branch',
              unit_size: '999', // drifted from the registry's 1
              is_active: true,
            }
          : null,
      );

      const result = await bootstrap.syncCatalog();

      expect(result.deactivated).toBe(1);
      const saved = catalog.save.mock.calls
        .map((c: any[]) => c[0])
        .find((r: any) => r.item_key === 'branches');
      expect(saved.is_active).toBe(false);
      expect(saved.unit_size).toBe('1');
    });

    it('logs the OLD unit_size, not the already-overwritten new one (regression: log must read the value before mutation)', async () => {
      const warnSpy = jest.spyOn((bootstrap as unknown as { logger: { warn: jest.Mock } }).logger, 'warn');
      catalog.findOne.mockImplementation(async (opts: any) =>
        opts.where.item_key === 'branches'
          ? { item_key: 'branches', kind: 'capacity', unit_label: 'branch', unit_size: '999', is_active: true }
          : null,
      );

      await bootstrap.syncCatalog();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('(999 → 1)'));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('(1 → 1)'));
    });

    it('does NOT count a deactivation for an item that was already inactive', async () => {
      catalog.findOne.mockImplementation(async (opts: any) =>
        opts.where.item_key === 'branches'
          ? {
              item_key: 'branches',
              kind: 'capacity',
              unit_label: 'branch',
              unit_size: '999',
              is_active: false,
            }
          : null,
      );

      const result = await bootstrap.syncCatalog();

      expect(result.deactivated).toBe(0);
    });
  });

  describe('onModuleInit', () => {
    it('logs and does not throw when syncCatalog fails (transient DB hiccup at boot)', async () => {
      catalog.findOne.mockRejectedValue(new Error('db down'));
      await expect(bootstrap.onModuleInit()).resolves.toBeUndefined();
    });
  });
});
