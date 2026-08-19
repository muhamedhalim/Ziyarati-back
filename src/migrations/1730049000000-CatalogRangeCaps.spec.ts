import { CatalogRangeCaps1730049000000 } from './1730049000000-CatalogRangeCaps';

describe('CatalogRangeCaps migration', () => {
  it('sets max_quantity for branches, APPOINTMENTS and CAMPAIGNS only', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new CatalogRangeCaps1730049000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain(`SET "max_quantity" = 20 WHERE "item_key" = 'branches'`);
    expect(sql).toContain(`SET "max_quantity" = 1000 WHERE "item_key" = 'APPOINTMENTS'`);
    expect(sql).toContain(`SET "max_quantity" = 1000 WHERE "item_key" = 'CAMPAIGNS'`);
    expect(sql).not.toContain('min_quantity');
    expect(sql).not.toContain('unit_price_minor');
    expect(sql).not.toContain('WHATSAPP_MESSAGES');
    expect(sql).not.toContain('AI_TOKENS');
  });

  it('down is a no-op (not reversible)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new CatalogRangeCaps1730049000000().down();
    expect(query).not.toHaveBeenCalled();
  });
});
