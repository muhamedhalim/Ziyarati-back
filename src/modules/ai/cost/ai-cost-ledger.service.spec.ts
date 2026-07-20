import { AiCostLedgerService } from './ai-cost-ledger.service';

describe('AiCostLedgerService', () => {
  it('persists the exact catalog snapshot and updates the aggregate once', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'entry-1' }])
      .mockResolvedValueOnce([]);
    const dataSource = { transaction: (fn: (m: { query: jest.Mock }) => unknown) => fn({ query }) } as any;
    const prices = { quoteChat: jest.fn(), quoteEmbedding: jest.fn() } as any;
    const ledger = new AiCostLedgerService(dataSource, prices);
    const quote = {
      status: 'PRICED' as const, provider: 'openai', requestedModel: 'gpt-4o',
      executionMode: 'STANDARD' as const,
      pricedModel: 'gpt-4o', catalogVersion: 'catalog-v1', source: 'approved-source',
      effectiveAt: '2026-07-19', inputMicrousdPerMillion: '2500000',
      cachedInputMicrousdPerMillion: '1250000', outputMicrousdPerMillion: '10000000',
      costMicrousd: 7_000n,
    };
    await ledger.record({
      tenantId: '11111111-1111-1111-1111-111111111111', idempotencyKey: 'turn-1',
      requestKind: 'CHAT', provider: 'openai', model: 'gpt-4o', feature: 'chat',
      route: 'ai.chat.api', channel: 'API', inputTokens: 1000, outputTokens: 500,
      success: true, quote,
    });
    const insertParams = query.mock.calls[0][1] as unknown[];
    expect(insertParams).toContain('catalog-v1');
    expect(insertParams).toContain('2500000');
    expect(insertParams).toContain('7000');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
