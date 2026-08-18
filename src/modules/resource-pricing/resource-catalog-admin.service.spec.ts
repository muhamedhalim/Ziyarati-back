import { ResourceCatalogAdminService } from './resource-catalog-admin.service';
import { ErrorCode } from '../../common/errors';

const ACTOR = { id: 'admin-1', email: 'admin@example.com' };

function catalogItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cat-1',
    item_key: 'branches',
    kind: 'capacity',
    unit_label: 'branch',
    unit_size: '1',
    unit_price_minor: '0',
    currency: 'SAR',
    min_quantity: 1,
    max_quantity: null,
    is_active: false,
    sort_order: 0,
    ...overrides,
  };
}

describe('ResourceCatalogAdminService (Phase 2.1 — plan §19/§21)', () => {
  let catalog: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let events: { save: jest.Mock; create: jest.Mock; findAndCount: jest.Mock };
  let plans: { find: jest.Mock };
  let limitStatus: { coverage: jest.Mock };
  let tenantContext: { getUser: jest.Mock };
  let service: ResourceCatalogAdminService;

  beforeEach(() => {
    catalog = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(async (e: any) => e),
      create: jest.fn((d: any) => d),
    };
    events = {
      save: jest.fn(async (e: any) => e),
      create: jest.fn((d: any) => d),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    plans = { find: jest.fn().mockResolvedValue([]) };
    limitStatus = { coverage: jest.fn().mockReturnValue({ finite: 1, unlimited: 0, notConfigured: 0, total: 1 }) };
    tenantContext = { getUser: jest.fn().mockReturnValue(ACTOR) };

    service = new ResourceCatalogAdminService(
      catalog as never,
      events as never,
      plans as never,
      limitStatus as never,
      tenantContext as never,
    );
  });

  describe('history', () => {
    it('paginates with defaults and orders newest-first', async () => {
      const rows = [{ id: 'evt-1' }];
      events.findAndCount.mockResolvedValueOnce([rows, 1]);

      const result = await service.history({ page: 1, limit: 20 });

      expect(events.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { created_at: 'DESC' },
        skip: 0,
        take: 20,
      });
      expect(result).toEqual({ data: rows, total: 1, page: 1, limit: 20 });
    });

    it('scopes to one item when itemKey is given', async () => {
      await service.history({ itemKey: 'branches', page: 2, limit: 10 });
      expect(events.findAndCount).toHaveBeenCalledWith({
        where: { item_key: 'branches' },
        order: { created_at: 'DESC' },
        skip: 10,
        take: 10,
      });
    });
  });

  describe('listAll', () => {
    it('orders by sort_order with item_key as a stable tiebreaker', async () => {
      await service.listAll();
      expect(catalog.find).toHaveBeenCalledWith({
        order: { sort_order: 'ASC', item_key: 'ASC' },
      });
    });
  });

  describe('getByKey', () => {
    it('404s for an unknown item', async () => {
      catalog.findOne.mockResolvedValueOnce(null);
      await expect(service.getByKey('nope')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('coverageFor', () => {
    it('404s when the item has no sellable-resource registry entry', async () => {
      await expect(service.coverageFor('not_a_real_item')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('delegates to PlanLimitStatusService.coverage with only ACTIVE plans', async () => {
      plans.find.mockResolvedValueOnce([{ id: 'p1' }]);
      await service.coverageFor('branches');
      expect(plans.find).toHaveBeenCalledWith({ where: { is_active: true } });
      expect(limitStatus.coverage).toHaveBeenCalledWith([{ id: 'p1' }], 'max_branches');
    });
  });

  describe('updatePrice', () => {
    it('updates unitPriceMinor and records ONE change event', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem());

      const result = await service.updatePrice('branches', { unitPriceMinor: 5000 });

      expect(result.unit_price_minor).toBe('5000');
      expect(events.save).toHaveBeenCalledTimes(1);
      expect(events.create).toHaveBeenCalledWith(
        expect.objectContaining({
          item_key: 'branches',
          field: 'unit_price_minor',
          from_value: '0',
          to_value: '5000',
        }),
      );
    });

    it('records a separate event per changed field', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem());

      await service.updatePrice('branches', { unitPriceMinor: 5000, sortOrder: 3 });

      expect(events.save).toHaveBeenCalledTimes(2);
    });

    it('is a no-op (no save side effects beyond the read) when nothing actually changes', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem({ sort_order: 3 }));

      await service.updatePrice('branches', { sortOrder: 3 });

      expect(catalog.save).not.toHaveBeenCalled();
      expect(events.save).not.toHaveBeenCalled();
    });

    it('sets updatedBy from the current actor', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem());
      const result = await service.updatePrice('branches', { unitPriceMinor: 100 });
      expect(result.updatedBy).toEqual({ id: 'admin-1' });
    });

    it('rejects a price × maxQuantity combination that would exceed Number.MAX_SAFE_INTEGER', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem({ max_quantity: 10 }));
      await expect(
        service.updatePrice('branches', { unitPriceMinor: Number.MAX_SAFE_INTEGER }),
      ).rejects.toThrow(/exceeds Number.MAX_SAFE_INTEGER/);
      expect(catalog.save).not.toHaveBeenCalled();
    });

    it('never touches code-owned fields (item_key/kind/unit_label/unit_size) — the DTO has no such properties', async () => {
      const item = catalogItem();
      catalog.findOne.mockResolvedValueOnce(item);
      const result = await service.updatePrice('branches', { unitPriceMinor: 100 });
      expect(result.kind).toBe('capacity');
      expect(result.unit_label).toBe('branch');
      expect(result.unit_size).toBe('1');
    });
  });

  describe('setActive(true) — the publish gate', () => {
    it('activates when priced, sellable, and covered by at least one active plan', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem({ unit_price_minor: '5000' }));
      limitStatus.coverage.mockReturnValueOnce({ finite: 2, unlimited: 1, notConfigured: 2, total: 5 });

      const result = await service.setActive('branches', true);

      expect(result.is_active).toBe(true);
      expect(events.save).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'is_active', from_value: 'false', to_value: 'true' }),
      );
    });

    it('refuses (422) an item with no sellable-resource registry entry', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem({ item_key: 'not_a_real_item', unit_price_minor: '5000' }));
      await expect(service.setActive('not_a_real_item', true)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('refuses (422) a structurally blocked item (storageBytes)', async () => {
      catalog.findOne.mockResolvedValueOnce(
        catalogItem({ item_key: 'storageBytes', unit_price_minor: '5000' }),
      );
      await expect(service.setActive('storageBytes', true)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('refuses (422) an unpriced item (unit_price_minor = 0)', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem({ unit_price_minor: '0' }));
      await expect(service.setActive('branches', true)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('refuses (422) when NO active plan has a Finite limit for the item\'s column', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem({ unit_price_minor: '5000' }));
      limitStatus.coverage.mockReturnValueOnce({ finite: 0, unlimited: 3, notConfigured: 2, total: 5 });

      await expect(service.setActive('branches', true)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('is a no-op (still re-validates, but no duplicate event) when already active', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem({ is_active: true, unit_price_minor: '5000' }));
      const result = await service.setActive('branches', true);
      expect(result.is_active).toBe(true);
      expect(events.save).not.toHaveBeenCalled();
    });
  });

  describe('setActive(false)', () => {
    it('is always allowed, regardless of price/coverage — availability is never frozen', async () => {
      catalog.findOne.mockResolvedValueOnce(catalogItem({ is_active: true, unit_price_minor: '0' }));
      const result = await service.setActive('branches', false);
      expect(result.is_active).toBe(false);
      expect(limitStatus.coverage).not.toHaveBeenCalled();
    });
  });
});
