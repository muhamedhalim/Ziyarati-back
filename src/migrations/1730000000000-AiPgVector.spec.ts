import { QueryRunner } from 'typeorm';
import { AiPgVector1730000000000 } from './1730000000000-AiPgVector';

/**
 * Unit coverage for the pgvector migration's environment-safe decision tree
 * (no DB required — QueryRunner is mocked). Complements the real-Postgres
 * integration test (test/integration/pgvector.int-spec.ts), which exercises the
 * actual schema creation against a live pgvector-enabled server.
 */
describe('AiPgVector1730000000000 (unit — mocked QueryRunner)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function mockRunner(availableRows: unknown[]): {
    runner: QueryRunner;
    query: jest.Mock;
  } {
    const query = jest.fn().mockResolvedValue(availableRows);
    return { runner: { query } as unknown as QueryRunner, query };
  }

  it('AI_PGVECTOR_ENABLED=false skips entirely — issues no queries', async () => {
    process.env.AI_PGVECTOR_ENABLED = 'false';
    const { runner, query } = mockRunner([]);
    await new AiPgVector1730000000000().up(runner);
    expect(query).not.toHaveBeenCalled();
  });

  it('extension unavailable + non-production → warns and skips (no throw)', async () => {
    delete process.env.AI_PGVECTOR_ENABLED;
    process.env.NODE_ENV = 'development';
    const { runner, query } = mockRunner([]); // pg_available_extensions empty
    await expect(
      new AiPgVector1730000000000().up(runner),
    ).resolves.toBeUndefined();
    // Only the availability probe ran — no CREATE EXTENSION / CREATE TABLE attempted.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('extension unavailable + production → throws (fail loud, no silent prod degrade)', async () => {
    delete process.env.AI_PGVECTOR_ENABLED;
    process.env.NODE_ENV = 'production';
    const { runner } = mockRunner([]);
    await expect(new AiPgVector1730000000000().up(runner)).rejects.toThrow(
      /vector.*not available/i,
    );
  });

  it('extension unavailable + AI_PGVECTOR_ENABLED unset in production still throws (secure default)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_PGVECTOR_ENABLED = 'true';
    const { runner } = mockRunner([]);
    await expect(new AiPgVector1730000000000().up(runner)).rejects.toThrow();
  });

  it('extension available → creates the schema with the env-configured dimension', async () => {
    delete process.env.NODE_ENV;
    process.env.OPENAI_EMBEDDING_DIM = '768';
    const { runner, query } = mockRunner([{ '?column?': 1 }]); // pg_available_extensions hit
    await new AiPgVector1730000000000().up(runner);
    const createTableCall = query.mock.calls.find((c) =>
      /CREATE TABLE/.test(String(c[0])),
    );
    expect(createTableCall).toBeDefined();
    expect(String(createTableCall![0])).toContain('vector(768)');
  });

  it('extension available, OPENAI_EMBEDDING_DIM unset → defaults to 1536', async () => {
    delete process.env.OPENAI_EMBEDDING_DIM;
    const { runner, query } = mockRunner([{ '?column?': 1 }]);
    await new AiPgVector1730000000000().up(runner);
    const createTableCall = query.mock.calls.find((c) =>
      /CREATE TABLE/.test(String(c[0])),
    );
    expect(String(createTableCall![0])).toContain('vector(1536)');
  });

  it('rejects a non-numeric OPENAI_EMBEDDING_DIM rather than emitting broken SQL', async () => {
    process.env.OPENAI_EMBEDDING_DIM = 'not-a-number';
    const { runner } = mockRunner([{ '?column?': 1 }]);
    await expect(new AiPgVector1730000000000().up(runner)).rejects.toThrow(
      /OPENAI_EMBEDDING_DIM/,
    );
  });

  it('down() is unconditional and idempotent regardless of whether up() created anything', async () => {
    const { runner, query } = mockRunner([]);
    await new AiPgVector1730000000000().down(runner);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('DROP TABLE IF EXISTS ai_kb_embeddings'),
    );
  });
});
