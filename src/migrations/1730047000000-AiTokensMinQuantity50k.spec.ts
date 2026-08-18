import { AiTokensMinQuantity50k1730047000000 } from './1730047000000-AiTokensMinQuantity50k';

describe('AiTokensMinQuantity50k migration', () => {
  it('sets min_quantity=50 and max_quantity=1000, scoped to AI_TOKENS only', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AiTokensMinQuantity50k1730047000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('UPDATE "resource_price_catalog"');
    expect(sql).toContain('SET "min_quantity" = 50, "max_quantity" = 1000');
    expect(sql).toContain(`WHERE "item_key" = 'AI_TOKENS'`);
    expect(sql).not.toContain('unit_price_minor');
    expect(sql).not.toContain('currency');
    expect(sql).not.toContain('is_active');
    expect(sql).not.toContain('sort_order');
  });

  it('down is a no-op (not reversible)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AiTokensMinQuantity50k1730047000000().down();
    expect(query).not.toHaveBeenCalled();
  });
});
