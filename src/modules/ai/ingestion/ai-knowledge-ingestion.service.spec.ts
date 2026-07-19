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
});
