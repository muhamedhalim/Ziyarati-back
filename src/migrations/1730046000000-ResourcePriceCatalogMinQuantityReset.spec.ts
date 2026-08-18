import { ResourcePriceCatalogMinQuantityReset1730046000000 } from './1730046000000-ResourcePriceCatalogMinQuantityReset';

describe('ResourcePriceCatalogMinQuantityReset migration', () => {
  it('resets every non-default min_quantity back to 1, leaving max_quantity untouched', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new ResourcePriceCatalogMinQuantityReset1730046000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('UPDATE "resource_price_catalog"');
    expect(sql).toContain('SET "min_quantity" = 1');
    expect(sql).toContain('WHERE "min_quantity" <> 1');
    expect(sql).not.toContain('max_quantity');
  });

  it('down is a no-op (not reversible)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new ResourcePriceCatalogMinQuantityReset1730046000000().down();
    expect(query).not.toHaveBeenCalled();
  });
});
