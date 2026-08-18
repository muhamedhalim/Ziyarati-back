import { ResourceCatalogService } from './resource-catalog.service';
import { ErrorCode } from '../../common/errors';

describe('ResourceCatalogService', () => {
  let catalog: { find: jest.Mock; findOne: jest.Mock };
  let service: ResourceCatalogService;

  beforeEach(() => {
    catalog = { find: jest.fn(), findOne: jest.fn() };
    service = new ResourceCatalogService(catalog as never);
  });

  describe('listActive', () => {
    it('queries only is_active=true, ordered by sort_order', async () => {
      catalog.find.mockResolvedValueOnce([]);
      await service.listActive();
      expect(catalog.find).toHaveBeenCalledWith({
        where: { is_active: true },
        order: { sort_order: 'ASC', item_key: 'ASC' },
      });
    });
  });

  describe('getActiveByKey', () => {
    it('returns the item when found and active', async () => {
      const item = { item_key: 'branches', is_active: true };
      catalog.findOne.mockResolvedValueOnce(item);
      const result = await service.getActiveByKey('branches');
      expect(result).toBe(item);
      expect(catalog.findOne).toHaveBeenCalledWith({
        where: { item_key: 'branches', is_active: true },
      });
    });

    it('404s when not found or inactive — never leaks an inactive item by direct key request', async () => {
      catalog.findOne.mockResolvedValueOnce(null);
      await expect(service.getActiveByKey('branches')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});
