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

  it('does not silently absorb a ledger failure — logs and emits an alert event', async () => {
    const dataSource = { transaction: () => { throw new Error('db down'); } } as any;
    const prices = {} as any;
    const emitter = { emit: jest.fn() };
    const ledger = new AiCostLedgerService(dataSource, prices, emitter as any);
    const result = await ledger.record({
      tenantId: 't1', idempotencyKey: 'k', requestKind: 'CHAT', provider: 'openai', model: 'gpt-4o',
      feature: 'chat', route: 'ai.chat.api', channel: 'API', success: true,
      quote: { status: 'PRICED', provider: 'openai', requestedModel: 'gpt-4o', executionMode: 'STANDARD', costMicrousd: 1n } as any,
    });
    // Interactive turn is not broken (returns), but the failure is surfaced loudly.
    expect(result.inserted).toBe(false);
    expect(emitter.emit).toHaveBeenCalledWith(
      AiCostLedgerService.LEDGER_FAILURE_EVENT,
      expect.objectContaining({ tenantId: 't1', feature: 'chat' }),
    );
  });
});

/**
 * Processing-mode accounting. `ai_cost_entries` has carried `execution_mode` and
 * `region` since the batch migration, but the CHAT path never populated them —
 * so a turn served through an enforced regional deployment was indistinguishable
 * after the fact from one served globally, which makes a residency claim
 * unauditable. These assert the columns are actually written, for every
 * combination of the two independent dimensions.
 */
describe('AiCostLedgerService — processing-mode accounting', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';

  function ledgerWithCapture() {
    const query = jest.fn()
      .mockResolvedValue([])
      .mockResolvedValueOnce([{ id: 'entry-1' }]);
    const dataSource = {
      transaction: (fn: (m: { query: jest.Mock }) => unknown) => fn({ query }),
    } as never;
    const prices = { quoteChat: jest.fn(), quoteEmbedding: jest.fn() } as never;
    return { ledger: new AiCostLedgerService(dataSource, prices), query };
  }

  const quote = (executionMode: 'STANDARD' | 'BATCH') =>
    ({
      status: 'PRICED' as const,
      provider: 'openai',
      requestedModel: 'gpt-4.1-mini',
      executionMode,
      pricedModel: 'gpt-4.1-mini',
      catalogVersion: 'catalog-v1',
      source: 'approved-source',
      effectiveAt: '2026-08-19',
      inputMicrousdPerMillion: '400000',
      outputMicrousdPerMillion: '1600000',
      costMicrousd: 1_000n,
    }) as never;

  it.each([
    ['STANDARD', null],
    ['STANDARD', 'eu'],
    ['BATCH', null],
    ['BATCH', 'eu'],
  ] as const)(
    'writes execution_mode=%s and region=%s onto the cost entry',
    async (executionMode, region) => {
      const { ledger, query } = ledgerWithCapture();
      await ledger.record({
        tenantId: TENANT,
        idempotencyKey: `turn-${executionMode}-${region}`,
        requestKind: 'CHAT',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        feature: 'chat',
        route: 'ai.chat.api',
        channel: 'API',
        executionMode,
        region,
        inputTokens: 1000,
        outputTokens: 200,
        success: true,
        quote: quote(executionMode),
      });

      const params = query.mock.calls[0][1] as unknown[];
      expect(params).toContain(executionMode);
      // `region` is a VALUE, not an omission — null for non-residency requests.
      expect(params).toContain(region);
    },
  );

  it('persists the cache-write token count and the rate that was applied to it', async () => {
    const { ledger, query } = ledgerWithCapture();
    await ledger.record({
      tenantId: TENANT,
      idempotencyKey: 'turn-cache-write',
      requestKind: 'CHAT',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      feature: 'chat',
      route: 'ai.chat.api',
      channel: 'API',
      inputTokens: 1000,
      cachedInputTokens: 100,
      cacheWriteTokens: 400,
      outputTokens: 200,
      success: true,
      quote: {
        ...(quote('STANDARD') as Record<string, unknown>),
        cacheWriteMicrousdPerMillion: '250000',
      } as never,
    });

    const sql = query.mock.calls[0][0] as string;
    const params = query.mock.calls[0][1] as unknown[];
    expect(sql).toContain('cache_write_tokens');
    expect(sql).toContain('cache_write_price_microusd_per_million');
    expect(params).toContain(400);
    // The RATE is stored alongside the count: a later catalog revision must not
    // be able to change what a historical turn was billed.
    expect(params).toContain('250000');
  });

  it('writes zero cache-write tokens for a model that does not bill them', async () => {
    const { ledger, query } = ledgerWithCapture();
    await ledger.record({
      tenantId: TENANT,
      idempotencyKey: 'turn-no-cache-write',
      requestKind: 'CHAT',
      provider: 'openai',
      model: 'gpt-4o',
      feature: 'chat',
      route: 'ai.chat.api',
      channel: 'API',
      inputTokens: 1000,
      outputTokens: 200,
      success: true,
      quote: quote('STANDARD'),
    });

    const params = query.mock.calls[0][1] as unknown[];
    // 0 and null, not undefined — an omitted bind parameter is a driver error,
    // and "no cache writes" must be recorded as a fact rather than a gap.
    expect(params.at(-2)).toBe(0);
    expect(params.at(-1)).toBeNull();
  });

  it('defaults to STANDARD + no region when a caller omits both — never "unknown"', async () => {
    const { ledger, query } = ledgerWithCapture();
    await ledger.record({
      tenantId: TENANT,
      idempotencyKey: 'turn-default',
      requestKind: 'CHAT',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      feature: 'chat',
      route: 'ai.chat.api',
      channel: 'API',
      success: true,
      quote: quote('STANDARD'),
    });
    const params = query.mock.calls[0][1] as unknown[];
    expect(params).toContain('STANDARD');
    expect(params).toContain(null);
  });

  it('keeps BATCH spend out of the standard aggregate columns', async () => {
    const { ledger, query } = ledgerWithCapture();
    await ledger.record({
      tenantId: TENANT,
      idempotencyKey: 'batch-embedding',
      requestKind: 'EMBEDDING',
      provider: 'openai',
      model: 'text-embedding-3-small',
      feature: 'bulk_embedding',
      route: 'ai.batch.bulk_embedding',
      channel: 'BATCH',
      executionMode: 'BATCH',
      embeddingTokens: 5_000,
      success: true,
      quote: quote('BATCH'),
    });
    // The aggregate upsert carries the batch-specific contributions separately
    // so a dashboard can show standard vs batch spend without rescanning entries.
    const aggregateParams = query.mock.calls[1][1] as unknown[];
    expect(aggregateParams).toContain(5_000);
  });

  it('records an UNPRICED entry rather than skipping it — unknown cost is never free', async () => {
    const { ledger, query } = ledgerWithCapture();
    const result = await ledger.record({
      tenantId: TENANT,
      idempotencyKey: 'residency-unpriced',
      requestKind: 'CHAT',
      provider: 'openai',
      model: 'gpt-4o-mini',
      feature: 'chat',
      route: 'ai.chat.api',
      channel: 'API',
      executionMode: 'STANDARD',
      region: 'eu',
      success: true,
      quote: {
        status: 'UNPRICED',
        provider: 'openai',
        requestedModel: 'gpt-4o-mini',
        executionMode: 'STANDARD',
        costMicrousd: null,
      } as never,
    });
    expect(result.costMicrousd).toBeNull();
    const params = query.mock.calls[0][1] as unknown[];
    expect(params).toContain('UNPRICED');
    expect(params).toContain('eu');
  });

  it('routes both quote helpers through the residency-aware catalog signature', () => {
    const prices = {
      quoteChat: jest.fn().mockReturnValue({ status: 'PRICED' }),
      quoteEmbedding: jest.fn().mockReturnValue({ status: 'PRICED' }),
    };
    const ledger = new AiCostLedgerService({} as never, prices as never);

    ledger.quoteChat('gpt-4.1-mini', 10, 5, 0, 'openai', 'BATCH', true);
    expect(prices.quoteChat).toHaveBeenCalledWith(
      'openai', 'gpt-4.1-mini', 10, 5, 0, 'BATCH', true, 0,
    );

    ledger.quoteEmbedding('text-embedding-3-small', 10, 'BATCH', 'openai', true);
    expect(prices.quoteEmbedding).toHaveBeenCalledWith(
      'openai', 'text-embedding-3-small', 10, 'BATCH', true,
    );
  });

  it('defaults the new residency parameter to false, so existing callers are unchanged', () => {
    const prices = { quoteChat: jest.fn(), quoteEmbedding: jest.fn() };
    const ledger = new AiCostLedgerService({} as never, prices as never);
    ledger.quoteChat('gpt-4o', 10, 5);
    expect(prices.quoteChat).toHaveBeenCalledWith('openai', 'gpt-4o', 10, 5, 0, 'STANDARD', false, 0);
  });
});
