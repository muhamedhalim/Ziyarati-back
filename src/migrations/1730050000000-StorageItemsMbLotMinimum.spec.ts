import { StorageItemsMbLotMinimum1730050000000 } from './1730050000000-StorageItemsMbLotMinimum';

describe('StorageItemsMbLotMinimum migration', () => {
  it('sets min_quantity=1024 for storageBytes/uploadedFiles/trainingFiles only', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new StorageItemsMbLotMinimum1730050000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('SET "min_quantity" = 1024');
    expect(sql).toContain(
      `WHERE "item_key" IN ('storageBytes', 'uploadedFiles', 'trainingFiles')`,
    );
    expect(sql).not.toContain('max_quantity');
    expect(sql).not.toContain('unit_price_minor');
  });

  it('down is a no-op (not reversible)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new StorageItemsMbLotMinimum1730050000000().down();
    expect(query).not.toHaveBeenCalled();
  });
});
