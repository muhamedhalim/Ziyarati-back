import { ConfigService } from '@nestjs/config';
import { AiRagService } from './ai-rag.service';

/**
 * Agents/models are Admin-managed platform config — a clinic may have
 * Knowledge before an agent is provisioned. These tests pin retrieval's
 * "tenant OR (tenant AND agent)" semantics on the keyword fallback path
 * (no embedder/pgvector needed to exercise it) and its tenant isolation.
 */
describe('AiRagService — agent-less knowledge retrieval', () => {
  function service(candidates: Array<Record<string, unknown>>) {
    const kb = { find: jest.fn().mockResolvedValue(candidates) };
    const embedder = { isConfigured: jest.fn(() => false), embed: jest.fn() };
    const pgvector = { isAvailable: jest.fn(() => false) };
    const dataSource = { transaction: jest.fn(), query: jest.fn() };
    const config = new ConfigService({ RAG_TOP_K: 5 });
    const value = new AiRagService(
      kb as any,
      embedder as any,
      pgvector as any,
      dataSource as any,
      config,
    );
    return { value, kb };
  }

  it("retrieves a tenant's unbound knowledge chunks when no agent is resolved yet", async () => {
    const chunk = { id: 'kb-1', content: 'we open at 9am', content_hash: 'h1' };
    const { value, kb } = service([chunk]);

    const results = await value.retrieve('tenant-1', null, 'open');

    expect(results.map((r) => r.id)).toEqual(['kb-1']);
    const where = kb.find.mock.calls[0][0].where;
    // A single tenant-scoped condition with an `agent IS NULL` FindOperator.
    expect(where).toEqual({
      tenant: { id: 'tenant-1' },
      agent: expect.anything(),
    });
    expect(Array.isArray(where)).toBe(false);
  });

  it('once an agent exists, still matches its chunks AND any unbound tenant chunks (agent-less knowledge is never orphaned)', async () => {
    const bound = {
      id: 'kb-bound',
      content: 'bound open hours',
      content_hash: 'h2',
    };
    const { value, kb } = service([bound]);

    await value.retrieve('tenant-1', 'agent-1', 'open');

    const where = kb.find.mock.calls[0][0].where;
    // Two OR'd branches: bound-to-this-agent, and unbound — both tenant-scoped.
    expect(Array.isArray(where)).toBe(true);
    expect(where).toEqual([
      { tenant: { id: 'tenant-1' }, agent: { id: 'agent-1' } },
      { tenant: { id: 'tenant-1' }, agent: expect.anything() },
    ]);
  });

  it('never queries beyond the requesting tenant (isolation)', async () => {
    const { value, kb } = service([]);

    await value.retrieve('tenant-a', null, 'open');

    const where = kb.find.mock.calls[0][0].where;
    expect(where.tenant).toEqual({ id: 'tenant-a' });
    expect(where.tenant).not.toEqual({ id: 'tenant-b' });
  });
});
