import { ConfigService } from '@nestjs/config';
import { AiKnowledgeIngestionService } from './ai-knowledge-ingestion.service';

describe('AiKnowledgeIngestionService content deduplication', () => {
  function service(existing?: Record<string, unknown>) {
    const kb = {
      findOne: jest.fn().mockResolvedValue(existing ?? null),
      findOneOrFail: jest.fn(), save: jest.fn(), create: jest.fn((v) => v), find: jest.fn(), update: jest.fn(),
    };
    const embedder = { isConfigured: jest.fn(() => true), embed: jest.fn() };
    const pgvector = { isAvailable: jest.fn(() => false) };
    const dataSource = { manager: {}, transaction: jest.fn(), query: jest.fn() };
    const value = new AiKnowledgeIngestionService(
      kb as any, embedder as any, pgvector as any, dataSource as any,
      new ConfigService({ OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small', AI_EMBEDDING_VERSION: 'v1' }),
    );
    return { value, kb, embedder };
  }

  it('normalizes content into a stable hash including the embedding version', () => {
    const { value } = service();
    expect(value.hashContent('مرحبا   بكم').hash).toBe(value.hashContent('مرحبا بكم').hash);
    expect(value.hashContent('مرحبا بكم').version).toContain('text-embedding-3-small');
  });

  it('returns the existing chunk and never pays for a duplicate embedding', async () => {
    const existing = { id: 'kb-1', content: 'same' };
    const { value, kb, embedder } = service(existing);
    await expect(value.ingestChunk('tenant-1', 'agent-1', 'same')).resolves.toBe(existing);
    expect(kb.save).not.toHaveBeenCalled();
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('reuses a persisted vector when another training source has identical content', async () => {
    const content = 'identical knowledge content';
    const kb = {
      findOne: jest.fn(), findOneOrFail: jest.fn(), save: jest.fn(),
      create: jest.fn((v) => v), find: jest.fn(), update: jest.fn(),
    };
    const embedder = { isConfigured: jest.fn(() => true), embed: jest.fn() };
    const pgvector = { isAvailable: jest.fn(() => true) };
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO ai_knowledge_bases')) return [{ id: 'new-kb' }];
        if (sql.includes('SELECT $1,$2,$3,embedding')) return [{ kb_id: 'new-kb' }];
        return [];
      }),
    };
    const dataSource = {
      manager,
      query: jest.fn(),
      transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)),
    };
    const value = new AiKnowledgeIngestionService(
      kb as any, embedder as any, pgvector as any, dataSource as any,
      new ConfigService({ OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small', AI_EMBEDDING_VERSION: 'v1' }),
    );
    dataSource.query.mockResolvedValueOnce([{
      id: 'existing-kb', content_hash: value.hashContent(content).hash,
    }]);

    await expect(value.ingestDocument(
      'tenant-1', 'agent-1', content, 'new-source', { requireEmbedding: true },
    )).resolves.toMatchObject({ chunks: 1, embedded: 1 });
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT $1,$2,$3,embedding'),
      expect.arrayContaining(['new-kb', 'tenant-1', 'agent-1', 'existing-kb']),
    );
  });

  // AI-004 (T039/T040, R14) — reembedChunk's tenant-scoped affected-row guard,
  // and the ON CONFLICT clause's ownership-column restriction.
  describe('AI-004 ownership guards (T039/T040)', () => {
    function reembedService() {
      const kb = {
        findOne: jest.fn(), findOneOrFail: jest.fn(), save: jest.fn(),
        create: jest.fn((v) => v), find: jest.fn(),
        update: jest.fn(),
      };
      const embedder = {
        isConfigured: jest.fn(() => true),
        embed: jest.fn().mockResolvedValue({ vectors: [[0.1, 0.2]] }),
      };
      const pgvector = { isAvailable: jest.fn(() => true) };
      const manager = { query: jest.fn().mockResolvedValue([]) };
      const dataSource = { manager, query: jest.fn(), transaction: jest.fn() };
      const value = new AiKnowledgeIngestionService(
        kb as any, embedder as any, pgvector as any, dataSource as any,
        new ConfigService({ OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small', AI_EMBEDDING_VERSION: 'v1' }),
      );
      return { value, kb, embedder, manager };
    }

    it('T039 — a foreign kbId (zero affected rows on the tenant-scoped update) stops BEFORE embedding or the upsert — no attacker vector is ever written', async () => {
      const { value, kb, embedder, manager } = reembedService();
      kb.update.mockResolvedValue({ affected: 0 });

      await value.reembedChunk('tenant-a', 'agent-1', 'foreign-kb-id', 'attacker content');

      expect(kb.update).toHaveBeenCalledWith(
        { id: 'foreign-kb-id', tenant: { id: 'tenant-a' } },
        expect.objectContaining({ content_hash: expect.any(String) }),
      );
      expect(embedder.embed).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('T039 — the rightful owner (one affected row) proceeds to embed and upsert exactly as before', async () => {
      const { value, kb, embedder, manager } = reembedService();
      kb.update.mockResolvedValue({ affected: 1 });

      await value.reembedChunk('tenant-a', 'agent-1', 'own-kb-id', 'own content');

      expect(embedder.embed).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT (kb_id) DO UPDATE'),
        ['own-kb-id', 'tenant-a', 'agent-1', '[0.1,0.2]'],
      );
    });

    it('T040 (R14 layer 2) — the ON CONFLICT clause updates ONLY embedding, never tenant_id/agent_id, so a repointed conflict cannot repoint ownership', async () => {
      const { value, kb, manager } = reembedService();
      kb.update.mockResolvedValue({ affected: 1 });

      await value.reembedChunk('tenant-a', 'agent-1', 'own-kb-id', 'own content');

      const [sql] = manager.query.mock.calls[0];
      // Pins BOTH R14 care points from the same call site:
      //  - first-insert still works: this is a plain INSERT ... ON CONFLICT,
      //    so a first insert (no existing kb_id) never enters the DO UPDATE
      //    branch at all — the clause only fires on a genuine conflict.
      //  - legitimate re-embedding by the rightful owner is a true no-op on
      //    ownership columns: the SET list contains embedding only.
      expect(sql).toContain('INSERT INTO');
      expect(sql).toMatch(/ON CONFLICT \(kb_id\) DO UPDATE\s+SET embedding/);
      expect(sql).not.toMatch(/SET[^;]*tenant_id\s*=/i);
      expect(sql).not.toMatch(/SET[^;]*agent_id\s*=/i);
    });
  });

  // AI-012 (T128, T132a, R13) — cleanupSource's pgvector-availability guard.
  describe('AI-012 sidecar-delete guard (T128)', () => {
    function cleanupService(vectorAvailable: boolean) {
      const kb = {
        findOne: jest.fn(), findOneOrFail: jest.fn(), save: jest.fn(),
        create: jest.fn((v) => v), find: jest.fn(), update: jest.fn(),
      };
      const embedder = { isConfigured: jest.fn(() => true), embed: jest.fn() };
      const pgvector = { isAvailable: jest.fn(() => vectorAvailable) };
      const queries: string[] = [];
      const manager = { query: jest.fn(async (sql: string) => { queries.push(sql); return []; }) };
      const dataSource = {
        manager,
        query: jest.fn(),
        transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)),
      };
      const value = new AiKnowledgeIngestionService(
        kb as any, embedder as any, pgvector as any, dataSource as any,
        new ConfigService({ OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small', AI_EMBEDDING_VERSION: 'v1' }),
      );
      return { value, queries };
    }

    it('on a NON-vector deployment, skips the sidecar DELETE entirely but still deletes the knowledge-base rows', async () => {
      const { value, queries } = cleanupService(false);
      await value.cleanupSource('tenant-1', 'source-1');
      expect(queries.some((q) => q.includes('DELETE FROM ai_kb_embeddings'))).toBe(false);
      expect(queries.some((q) => q.includes('DELETE FROM ai_knowledge_bases'))).toBe(true);
    });

    it('on a vector deployment, sidecar cleanup still happens exactly as today, in addition to the knowledge-base row delete', async () => {
      const { value, queries } = cleanupService(true);
      await value.cleanupSource('tenant-1', 'source-1');
      expect(queries.some((q) => q.includes('DELETE FROM ai_kb_embeddings'))).toBe(true);
      expect(queries.some((q) => q.includes('DELETE FROM ai_knowledge_bases'))).toBe(true);
    });
  });
});
