import { ConfigService } from '@nestjs/config';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';

describe('OpenAiEmbeddingProvider cache/dedup (mocked SDK)', () => {
  const quote = {
    status: 'PRICED', provider: 'openai', requestedModel: 'text-embedding-3-small',
    costMicrousd: 1n,
  } as const;

  function setup(redisFails = false) {
    const cache = new Map<string, string>();
    const queue = {
      kvGet: jest.fn(async (key: string) => {
        if (redisFails) throw new Error('redis unavailable');
        return cache.get(key) ?? null;
      }),
      kvSet: jest.fn(async (key: string, value: string) => {
        if (redisFails) throw new Error('redis unavailable');
        cache.set(key, value);
      }),
    };
    const costs = { quoteEmbedding: jest.fn(() => quote), record: jest.fn().mockResolvedValue({ inserted: true }) };
    const provider = new OpenAiEmbeddingProvider(
      new ConfigService({ OPENAI_API_KEY: 'mock-only', OPENAI_PROVIDER_MAX_RETRIES: 0 }),
      queue as any,
      costs as any,
    );
    const create = jest.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }], usage: { total_tokens: 3 },
    });
    (provider as any).client = { embeddings: { create } };
    return { provider, queue, costs, create };
  }

  it('records a miss once, then reuses the tenant/model/version/text hash cache', async () => {
    const { provider, create } = setup();
    const first = await provider.embed('tenant-1', ['same question'], { kind: 'QUERY' });
    const second = await provider.embed('tenant-1', ['same   question'], { kind: 'QUERY' });
    expect(first).toEqual(expect.objectContaining({ cacheHits: 0, cacheMisses: 1, tokens: 3 }));
    expect(second).toEqual(expect.objectContaining({ cacheHits: 1, cacheMisses: 0, tokens: 0 }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates identical texts inside one provider batch', async () => {
    const { provider, create } = setup();
    const result = await provider.embed('tenant-1', ['FAQ answer', 'FAQ  answer'], { kind: 'CONTENT' });
    expect(create.mock.calls[0][0].input).toEqual(['FAQ answer']);
    expect(result.vectors).toEqual([[0.1, 0.2], [0.1, 0.2]]);
  });

  it('fails open when Redis is unavailable without skipping the provider or ledger', async () => {
    const { provider, create, costs } = setup(true);
    await expect(provider.embed('tenant-1', ['hello'], { kind: 'QUERY' })).resolves.toEqual(
      expect.objectContaining({ vectors: [[0.1, 0.2]], tokens: 3 }),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(costs.record).toHaveBeenCalled();
  });
});
