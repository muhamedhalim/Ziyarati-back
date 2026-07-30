import { ConfigService } from '@nestjs/config';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';

describe('OpenAiEmbeddingProvider cache/dedup (mocked SDK)', () => {
  const quote = {
    status: 'PRICED',
    provider: 'openai',
    requestedModel: 'text-embedding-3-small',
    executionMode: 'STANDARD',
    costMicrousd: 1n,
  } as const;

  function setup(redisFails = false) {
    const cache = new Map<string, string>();
    const queue = {
      kvGet: jest.fn(async (key: string) => {
        if (redisFails) throw new Error('redis unavailable');
        return cache.get(key) ?? null;
      }),
      kvMget: jest.fn(async (keys: string[]) => {
        if (redisFails) throw new Error('redis unavailable');
        return keys.map((k) => cache.get(k) ?? null);
      }),
      kvSet: jest.fn(async (key: string, value: string) => {
        if (redisFails) throw new Error('redis unavailable');
        cache.set(key, value);
      }),
    };
    const costs = {
      quoteEmbedding: jest.fn(() => quote),
      record: jest.fn().mockResolvedValue({ inserted: true }),
    };
    const provider = new OpenAiEmbeddingProvider(
      new ConfigService({
        OPENAI_API_KEY: 'mock-only',
        OPENAI_PROVIDER_MAX_RETRIES: 0,
      }),
      queue as any,
      costs as any,
    );
    const create = jest.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }],
      usage: { total_tokens: 3 },
    });
    (provider as any).client = { embeddings: { create } };
    return { provider, queue, costs, create, cache };
  }

  it('records a miss once, then reuses the tenant/model/version/text hash cache', async () => {
    const { provider, create } = setup();
    const first = await provider.embed('tenant-1', ['same question'], {
      kind: 'QUERY',
    });
    const second = await provider.embed('tenant-1', ['same   question'], {
      kind: 'QUERY',
    });
    expect(first).toEqual(
      expect.objectContaining({ cacheHits: 0, cacheMisses: 1, tokens: 3 }),
    );
    expect(second).toEqual(
      expect.objectContaining({ cacheHits: 1, cacheMisses: 0, tokens: 0 }),
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates identical texts inside one provider batch', async () => {
    const { provider, create } = setup();
    const result = await provider.embed(
      'tenant-1',
      ['FAQ answer', 'FAQ  answer'],
      { kind: 'CONTENT' },
    );
    expect(create.mock.calls[0][0].input).toEqual(['FAQ answer']);
    expect(result.vectors).toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ]);
  });

  it('fails open when Redis is unavailable without skipping the provider or ledger', async () => {
    const { provider, create, costs } = setup(true);
    await expect(
      provider.embed('tenant-1', ['hello'], { kind: 'QUERY' }),
    ).resolves.toEqual(
      expect.objectContaining({ vectors: [[0.1, 0.2]], tokens: 3 }),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(costs.record).toHaveBeenCalled();
  });

  it('reads the whole batch in ONE kvMget call, not one kvGet per text (M5)', async () => {
    const { provider, queue, create } = setup();
    create.mockResolvedValueOnce({
      data: [
        { embedding: [0.1, 0.2] },
        { embedding: [0.3, 0.4] },
        { embedding: [0.5, 0.6] },
      ],
      usage: { total_tokens: 9 },
    });
    await provider.embed('tenant-1', ['alpha', 'beta', 'gamma'], {
      kind: 'CONTENT',
    });
    expect(queue.kvMget).toHaveBeenCalledTimes(1);
    expect(queue.kvMget.mock.calls[0][0]).toHaveLength(3);
    expect(queue.kvGet).not.toHaveBeenCalled();
  });

  it('round-trips a vector through the binary encoding with float32 precision (M5)', async () => {
    const { provider, queue, create } = setup();
    create.mockResolvedValueOnce({
      data: [{ embedding: [0.123456789, -0.5, 1, 0, 0.999999] }],
      usage: { total_tokens: 5 },
    });
    const first = await provider.embed('tenant-1', ['precise text'], {
      kind: 'CONTENT',
    });
    // Stored value must be a compact base64 string, not JSON.
    const storedValue = queue.kvSet.mock.calls[0][1];
    expect(() => JSON.parse(storedValue)).toThrow();
    expect(Buffer.from(storedValue, 'base64').length).toBe(5 * 4); // 5 floats * 4 bytes

    const second = await provider.embed('tenant-1', ['precise text'], {
      kind: 'CONTENT',
    });
    expect(second.cacheHits).toBe(1);
    // Float32 precision, not exact float64 — compare with a small tolerance.
    second.vectors[0].forEach((v, i) => {
      expect(v).toBeCloseTo(first.vectors[0][i], 5);
    });
  });

  it('bumping AI_EMBEDDING_VERSION orphans old-version cache entries — a v2 lookup never hits v1 data for the identical text (§18 test-plan #12)', async () => {
    const cache = new Map<string, string>();
    const queue = {
      kvGet: jest.fn(async (key: string) => cache.get(key) ?? null),
      kvMget: jest.fn(async (keys: string[]) =>
        keys.map((k) => cache.get(k) ?? null),
      ),
      kvSet: jest.fn(async (key: string, value: string) => {
        cache.set(key, value);
      }),
    };
    const costs = {
      quoteEmbedding: jest.fn(() => quote),
      record: jest.fn().mockResolvedValue({ inserted: true }),
    };
    const buildProvider = (version: string) => {
      const provider = new OpenAiEmbeddingProvider(
        new ConfigService({
          OPENAI_API_KEY: 'mock-only',
          OPENAI_PROVIDER_MAX_RETRIES: 0,
          AI_EMBEDDING_VERSION: version,
        }),
        queue as any,
        costs as any,
      );
      (provider as any).client = {
        embeddings: {
          create: jest.fn().mockResolvedValue({
            data: [{ embedding: [0.1, 0.2] }],
            usage: { total_tokens: 3 },
          }),
        },
      };
      return provider;
    };

    const v1Provider = buildProvider('v1');
    await v1Provider.embed('tenant-1', ['same question'], { kind: 'QUERY' });
    expect(cache.size).toBe(1);
    const v1Key = [...cache.keys()][0];
    expect(v1Key).toContain(':v1:');

    const v2Provider = buildProvider('v2');
    const v2Result = await v2Provider.embed('tenant-1', ['same question'], {
      kind: 'QUERY',
    });

    // A genuine miss under v2 — the v1 entry is neither read nor overwritten.
    expect(v2Result.cacheHits).toBe(0);
    expect(v2Result.cacheMisses).toBe(1);
    expect(cache.size).toBe(2); // v1 entry survives untouched, v2 entry added
    expect(cache.get(v1Key)).toBeDefined();
    const v2Key = [...cache.keys()].find((k) => k !== v1Key)!;
    expect(v2Key).toContain(':v2:');
  });

  it('never throws out of the whole batch when a cached entry is undecodable garbage (M5)', async () => {
    // Node's base64 decoder is lenient (rarely errors on invalid input), so
    // `decodeVector`'s try/catch is defense-in-depth rather than something
    // reliably exercised by "corrupt" base64 text — what actually matters is
    // that a garbage cached value can never crash the whole embed() call for
    // every OTHER text in the same batch. Verified directly instead of via a
    // contrived corruption string.
    const { provider, cache } = setup();
    await provider.embed('tenant-1', ['poisoned text'], { kind: 'CONTENT' });
    const [cachedKey] = [...cache.keys()];
    cache.set(cachedKey, 'not-valid-base64-floats!!');

    await expect(
      provider.embed('tenant-1', ['poisoned text', 'a second text'], {
        kind: 'CONTENT',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        vectors: expect.arrayContaining([expect.any(Array)]),
      }),
    );
  });
});
