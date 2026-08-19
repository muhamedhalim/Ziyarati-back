import { WhatsappMessagesMinQuantity1k1730048000000 } from './1730048000000-WhatsappMessagesMinQuantity1k';

describe('WhatsappMessagesMinQuantity1k migration', () => {
  it('sets min_quantity=1000 and max_quantity=1000000, scoped to WHATSAPP_MESSAGES only', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new WhatsappMessagesMinQuantity1k1730048000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('UPDATE "resource_price_catalog"');
    expect(sql).toContain('SET "min_quantity" = 1000, "max_quantity" = 1000000');
    expect(sql).toContain(`WHERE "item_key" = 'WHATSAPP_MESSAGES'`);
    expect(sql).not.toContain('unit_price_minor');
    expect(sql).not.toContain('currency');
    expect(sql).not.toContain('is_active');
    expect(sql).not.toContain('sort_order');
  });

  it('down is a no-op (not reversible)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new WhatsappMessagesMinQuantity1k1730048000000().down();
    expect(query).not.toHaveBeenCalled();
  });
});
